from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def _reset_shared_state():
    """The rate limiter is process-wide module state; reset it before every
    test so tests don't leak into each other. (poi_db.py has no equivalent
    cache to reset - see its module docstring for why.)"""
    from waypointer.rate_limit import _requests_by_ip

    _requests_by_ip.clear()
    yield


@pytest.fixture
def sample_route_path() -> Path:
    return FIXTURES_DIR / "sample_route.gpx"


@pytest.fixture
def sample_route_bytes(sample_route_path: Path) -> bytes:
    return sample_route_path.read_bytes()
