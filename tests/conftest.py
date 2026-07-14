import json
from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def _reset_shared_state():
    """Overpass's TTL cache and the rate limiter are process-wide module
    state; reset them before every test so tests don't leak into each other."""
    from waypointer.osm import _cache
    from waypointer.rate_limit import _requests_by_ip

    _cache._store.clear()
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
