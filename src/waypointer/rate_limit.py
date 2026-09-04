"""Minimal per-IP rate limiting for the endpoints backed by external APIs.

A public deployment shares one server IP across all visitors when it talks to
the Overpass and BRouter APIs, so a burst of traffic (accidental or not)
risks getting that IP rate-limited or banned upstream. This is a small
in-memory sliding window log, not a distributed limiter - sufficient for a
single free-tier instance and intentionally not backed by Redis/a database.

Each endpoint gets its own named bucket with its own budget: route planning
is inherently chattier than POI search (dragging an anchor re-requests its
two adjacent legs), and sharing one budget would let a planning session
starve the search it exists to feed.
"""

import threading
import time
from collections import defaultdict

from fastapi import HTTPException, Request, status

OVERPASS_REQUESTS_PER_WINDOW = 10
ROUTING_REQUESTS_PER_WINDOW = 60
WINDOW_S = 60.0

_lock = threading.Lock()
# Keyed on (bucket, ip) rather than ip alone, so one endpoint's traffic can
# never consume another's budget.
_requests_by_ip: dict[tuple[str, str], list[float]] = defaultdict(list)


def _client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def make_rate_limit(bucket: str, requests_per_window: int, window_s: float = WINDOW_S):
    """Builds a FastAPI dependency enforcing one named bucket's budget."""

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


rate_limit = make_rate_limit("overpass", OVERPASS_REQUESTS_PER_WINDOW)
routing_rate_limit = make_rate_limit("routing", ROUTING_REQUESTS_PER_WINDOW)
