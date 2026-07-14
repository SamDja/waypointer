"""Minimal per-IP rate limiting for the Overpass-backed endpoint.

A public deployment shares one server IP across all visitors when it talks
to the Overpass API, so a burst of traffic (accidental or not) risks getting
that IP rate-limited or banned upstream. This is a small in-memory sliding
window log, not a distributed limiter - sufficient for a single free-tier
instance and intentionally not backed by Redis/a database.
"""

import threading
import time
from collections import defaultdict

from fastapi import HTTPException, Request, status

REQUESTS_PER_WINDOW = 10
WINDOW_S = 60.0

_lock = threading.Lock()
_requests_by_ip: dict[str, list[float]] = defaultdict(list)


def _client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(request: Request) -> None:
    """FastAPI dependency: raises 429 once an IP exceeds the request budget."""
    ip = _client_ip(request)
    now = time.monotonic()
    cutoff = now - WINDOW_S

    with _lock:
        timestamps = [t for t in _requests_by_ip[ip] if t > cutoff]
        if len(timestamps) >= REQUESTS_PER_WINDOW:
            _requests_by_ip[ip] = timestamps
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests - please wait a moment and try again.",
            )
        timestamps.append(now)
        _requests_by_ip[ip] = timestamps
