"""Minimal per-IP rate limiting for the Overpass-backed endpoint.

A public deployment shares one server IP across all visitors when it talks
to the Overpass API, so a burst of traffic (accidental or not) risks getting
that IP rate-limited or banned upstream. This is a small in-memory sliding
window log, not a distributed limiter - sufficient for a single free-tier
instance and intentionally not backed by Redis/a database.

The frontend now fans a single "Find POIs" click out into one
/api/find-pois request per selected POI type (fired in parallel) rather than
one request carrying every type, so progress/results can be shown per type
instead of only once the slowest type finishes - see FindPoisCard.tsx /
App.tsx's handleFind. That doesn't change how many Overpass calls actually
happen (still one per type, same as before), just how many times this
dependency gets checked for the same amount of real work - so the budget
below is sized to comfortably cover a full-registry search (~40 searchable
types) plus a couple of re-searches within the window. The real protection
against hammering the shared Overpass IP remains osm.py's per-query TTL
cache, not this counter.
"""

import threading
import time
from collections import defaultdict

from fastapi import HTTPException, Request, status

REQUESTS_PER_WINDOW = 60
LOOKUP_POI_REQUESTS_PER_WINDOW = 30

WINDOW_S = 60.0

_lock = threading.Lock()
_requests_by_ip: dict[tuple[str, str], list[float]] = defaultdict(list)


def _client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def make_rate_limit(bucket: str, requests_per_window: int, window_s: float = WINDOW_S):
    """Builds a FastAPI dependency that raises 429 once an IP exceeds the
    request budget for this bucket - separate buckets so one endpoint's
    traffic can't exhaust another's budget."""

    def rate_limit_dependency(request: Request) -> None:
        ip = _client_ip(request)
        key = (bucket, ip)
        now = time.monotonic()
        cutoff = now - window_s

        with _lock:
            timestamps = [t for t in _requests_by_ip[key] if t > cutoff]
            if len(timestamps) >= requests_per_window:
                _requests_by_ip[key] = timestamps
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Too many requests - please wait a moment and try again.",
                )
            timestamps.append(now)
            _requests_by_ip[key] = timestamps

    return rate_limit_dependency


rate_limit = make_rate_limit("overpass", REQUESTS_PER_WINDOW)
lookup_poi_rate_limit = make_rate_limit("lookup_poi", LOOKUP_POI_REQUESTS_PER_WINDOW)
