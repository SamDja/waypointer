import json
from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def _reset_shared_state():
    """The external-API TTL caches and the rate limiter are process-wide module
    state; reset them before every test so tests don't leak into each other.
    (poi_db.py has no equivalent cache to reset - see its module docstring
    for why.)"""
    from waypointer.rate_limit import _requests_by_ip
    from waypointer.geocode import _cache as geocode_cache
    from waypointer.photos import clear_caches as clear_photo_caches
    from waypointer.routing import _cache as routing_cache

    routing_cache.clear()
    geocode_cache.clear()
    clear_photo_caches()
    _requests_by_ip.clear()
    yield


@pytest.fixture
def sample_route_path() -> Path:
    return FIXTURES_DIR / "sample_route.gpx"


@pytest.fixture
def sample_route_bytes(sample_route_path: Path) -> bytes:
    return sample_route_path.read_bytes()


@pytest.fixture
def brouter_response_json() -> dict:
    """A real BRouter 1.7.10 GeoJSON response (truncated to 12 points, with
    its bulky per-point `messages`/`times` arrays dropped) - captured from
    the public instance so the 3D-coordinate shape under test is the one the
    service actually returns."""
    return json.loads((FIXTURES_DIR / "brouter_response.json").read_text())


@pytest.fixture
def photon_json() -> dict:
    """A real Photon response for "Trento" - see test_geocode.py."""
    return json.loads((FIXTURES_DIR / "photon_response.json").read_text())


@pytest.fixture
def commons_category_json() -> dict:
    """A real Commons imageinfo response for two files of
    Category:Rifugio_Tonini (bulky srcset fields dropped) - see test_photos.py."""
    return json.loads((FIXTURES_DIR / "commons_category_response.json").read_text())


@pytest.fixture
def panoramax_json() -> dict:
    """A real Panoramax meta-catalogue answer for one picture id (its bulky
    exif/semantics properties dropped) - see test_photos.py."""
    return json.loads((FIXTURES_DIR / "panoramax_response.json").read_text())


@pytest.fixture
def wikidata_p18_json() -> dict:
    """A real wbgetclaims P18 response for Q3376 (Trento)."""
    return json.loads((FIXTURES_DIR / "wikidata_p18_response.json").read_text())


# --- account database (test_auth.py, test_connections.py) -------------------

ACCOUNT_ORIGIN = "http://testserver"
ACCOUNT_PASSWORD = "correct horse battery"


@pytest.fixture(scope="session")
def _account_server_url():
    """One throwaway Postgres for every account test, started on first use.
    Skips cleanly without Docker, like test_poi_db.py."""
    try:
        from testcontainers.community.postgres import PostgresContainer
    except ImportError:  # pragma: no cover - dev dependency, see pyproject.toml
        pytest.skip("testcontainers is not installed")
    try:
        container = PostgresContainer("postgres:16-alpine")
        container.start()
    except Exception as exc:  # noqa: BLE001 - Docker unavailable in this environment
        pytest.skip(f"Docker/testcontainers unavailable: {exc}")
        return
    yield container.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")
    container.stop()


@pytest.fixture(scope="session")
def _account_database_url(_account_server_url):
    import psycopg

    from waypointer import db

    # A database that doesn't exist yet, so init_database has to create it -
    # the same path an existing deployment's volume takes on first start.
    url = psycopg.conninfo.make_conninfo(_account_server_url, dbname="sulla_via_test")
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv(db.DATABASE_URL_ENV, url)
        assert db.init_database()
        # A second run finds everything already applied.
        with psycopg.connect(url) as conn:
            assert db.apply_migrations(conn) == []
    return url


@pytest.fixture
def account_db(_account_database_url, monkeypatch):
    """A clean account database for one test, plus the env the account code
    reads, with every optional external service (SMTP, captcha, HIBP) off."""
    import psycopg
    from cryptography.fernet import Fernet

    from waypointer import cleanup, db, passwords, token_crypto

    monkeypatch.setenv(db.DATABASE_URL_ENV, _account_database_url)
    monkeypatch.setenv("COOKIE_SECURE", "0")
    monkeypatch.setenv(token_crypto.TOKEN_ENCRYPTION_KEY_ENV, Fernet.generate_key().decode())
    for name in ("PUBLIC_BASE_URL", "SMTP_HOST", "TURNSTILE_SECRET_KEY", passwords.HIBP_CHECK_ENV):
        monkeypatch.delenv(name, raising=False)
    # The app's own hourly cleanup would run a pass as each TestClient starts,
    # concurrently with the test - tests call cleanup themselves instead.
    async def no_cleanup():
        return None

    monkeypatch.setattr(cleanup, "run_forever", no_cleanup)
    db.close_pool()
    with psycopg.connect(_account_database_url, autocommit=True) as conn:
        conn.execute("TRUNCATE users CASCADE")
    yield _account_database_url
    db.close_pool()


@pytest.fixture
def outbox(monkeypatch):
    """Every email the account code sends, instead of sending it."""
    from waypointer import mailer

    sent: list[dict] = []
    monkeypatch.setattr(
        mailer, "send_email", lambda to, subject, body: sent.append({"to": to, "subject": subject, "body": body})
    )
    return sent


@pytest.fixture
def client(account_db):
    from fastapi.testclient import TestClient

    from waypointer.main import app

    with TestClient(app, headers={"Origin": ACCOUNT_ORIGIN}) as c:
        yield c
