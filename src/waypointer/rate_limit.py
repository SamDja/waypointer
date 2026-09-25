"""Minimal per-IP rate limiting for the POI-database- and routing-backed
endpoints.

Now that POI lookups hit a local PostGIS database (see poi_db.py) instead
of a shared, rate-limit-sensitive public Overpass mirror, the POI buckets'
job is just guarding this app's own DB/CPU usage against a burst of
traffic (accidental or not) from one IP - not protecting a third party's
quota. Route planning is different: /api/route-leg still proxies BRouter's
shared public instance (see routing.py), so a burst there does risk getting
this server's one IP throttled upstream. Still a small in-memory sliding
window log, not a distributed limiter - sufficient for a single instance and
intentionally not backed by Redis/a database.

Each endpoint gets its own named bucket with its own budget, so one
endpoint's traffic can never consume another's: route planning is
inherently chatty (dragging an anchor re-requests its two adjacent legs),
and sharing one budget would let a planning session starve the search it
exists to feed.

The frontend fans a single "Find POIs" click out into one
/api/find-pois/route request per selected POI type (fired in parallel)
rather than one request carrying every type, so progress/results can be
shown per type instead of only once the slowest type finishes - see
FindPoisCard.tsx / App.tsx's runFind. That doesn't change how much real
DB work happens (still one query per type, same as before), just how many
times this dependency gets checked for the same amount of work - so the
budget below is sized to comfortably cover a full-registry search (~50
searchable types) plus a couple of re-searches within the window.
"""

import math
import threading
import time
from collections import defaultdict

from fastapi import HTTPException, Request, status

REQUESTS_PER_WINDOW = 60
LOOKUP_POI_REQUESTS_PER_WINDOW = 30
ROUTING_REQUESTS_PER_WINDOW = 60
# The map's search box is a debounced typeahead - a few requests per search.
GEOCODE_REQUESTS_PER_WINDOW = 30
# Map POIs are fetched per viewport, debounced, and only past a zoom - so
# this is panning around, not a fan-out like find-pois.
MAP_POI_REQUESTS_PER_WINDOW = 60

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
                # The window frees a slot once its oldest request ages out -
                # Retry-After tells the frontend exactly how long to hold off
                # (lib/api.ts pauses that endpoint for this long).
                retry_after_s = max(1, math.ceil(timestamps[0] + window_s - now))
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Too many requests - please wait a moment and try again.",
                    headers={"Retry-After": str(retry_after_s)},
                )
            timestamps.append(now)
            _requests_by_ip[key] = timestamps

    return rate_limit_dependency


rate_limit = make_rate_limit("find_pois", REQUESTS_PER_WINDOW)
lookup_poi_rate_limit = make_rate_limit("lookup_poi", LOOKUP_POI_REQUESTS_PER_WINDOW)
routing_rate_limit = make_rate_limit("routing", ROUTING_REQUESTS_PER_WINDOW)
geocode_rate_limit = make_rate_limit("geocode", GEOCODE_REQUESTS_PER_WINDOW)
map_poi_rate_limit = make_rate_limit("map_poi", MAP_POI_REQUESTS_PER_WINDOW)
