import json
from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def _reset_shared_state():
    """The Overpass and routing TTL caches and the rate limiter are
    process-wide module state; reset them before every test so tests don't
    leak into each other."""
    from waypointer.osm import _cache as overpass_cache
    from waypointer.rate_limit import _requests_by_ip
    from waypointer.routing import _cache as routing_cache

    overpass_cache.clear()
    routing_cache.clear()
    _requests_by_ip.clear()
    yield


@pytest.fixture
def sample_route_path() -> Path:
    return FIXTURES_DIR / "sample_route.gpx"


@pytest.fixture
def sample_route_bytes(sample_route_path: Path) -> bytes:
    return sample_route_path.read_bytes()


@pytest.fixture
def overpass_response_json() -> dict:
    return json.loads((FIXTURES_DIR / "overpass_response.json").read_text())


@pytest.fixture
def brouter_response_json() -> dict:
    """A real BRouter 1.7.10 GeoJSON response (truncated to 12 points, with
    its bulky per-point `messages`/`times` arrays dropped) - captured from
    the public instance so the 3D-coordinate shape under test is the one the
    service actually returns."""
    return json.loads((FIXTURES_DIR / "brouter_response.json").read_text())
