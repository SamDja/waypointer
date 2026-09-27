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
