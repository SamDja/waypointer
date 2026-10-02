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
# One request per POI popup opened that has photo tags - clicking around the
# map, and it protects Commons/Panoramax/Mapillary rather than our own DB.
PHOTO_REQUESTS_PER_WINDOW = 60
# Every /api/strava/* call - connecting, listing routes, importing one. All of
# them spend this app's single Strava quota (shared by every visitor), so a
# visitor gets a few dialog openings and imports per minute, not a fan-out.
STRAVA_REQUESTS_PER_WINDOW = 20
# Every /api/wahoo/* call that reaches Wahoo with the account's token -
# connecting, listing, pushing, renaming, deleting. Wahoo's own per-app
# limits are generous, but they're still one quota shared by every visitor.
WAHOO_REQUESTS_PER_WINDOW = 30
# /api/nl-routes/generate: each request is an LLM parse, about 10 BRouter
# calls on the shared public instance and an LLM explanation - so a handful a
# minute, not a typeahead.
NL_ROUTE_REQUESTS_PER_WINDOW = 5
# Account endpoints (auth.py). Login is limited per IP and, separately, per
# email address, so neither guessing many passwords for one account from many
# IPs nor one IP spraying many accounts gets far. Anything that sends an email
# (sign-up, password reset, verification resend, email change) is limited per
# address as well, so the form can't be used to flood someone's inbox.
LOGIN_REQUESTS_PER_WINDOW = 10
LOGIN_ATTEMPTS_PER_EMAIL = 5
LOGIN_EMAIL_WINDOW_S = 15 * 60.0
SIGNUP_REQUESTS_PER_HOUR = 5
EMAILS_PER_ADDRESS_PER_HOUR = 3
# Everything else under /api/auth and /api/account (verify, me, settings):
# cheap, but still worth a ceiling.
ACCOUNT_REQUESTS_PER_WINDOW = 60
HOUR_S = 3600.0

WINDOW_S = 60.0

_lock = threading.Lock()
# Keyed on (bucket, ip) rather than ip alone, so one endpoint's traffic can
# never consume another's budget.
_requests_by_ip: dict[tuple[str, str], list[float]] = defaultdict(list)


def client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_rate(bucket: str, key: str, requests_per_window: int, window_s: float = WINDOW_S) -> None:
    """Records one request against (bucket, key) and raises 429 once that key
    has spent its budget for the window. The core of make_rate_limit's
    per-IP dependency, also called directly where the key isn't the IP -
    auth.py limits login and email sends per email address too, so spreading
    attempts on one account across many IPs doesn't get around the budget."""
    now = time.monotonic()
    cutoff = now - window_s

    with _lock:
        timestamps = [t for t in _requests_by_ip[(bucket, key)] if t > cutoff]
        if len(timestamps) >= requests_per_window:
            _requests_by_ip[(bucket, key)] = timestamps
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
        _requests_by_ip[(bucket, key)] = timestamps


# The longest window any bucket uses - a key with nothing newer than this
# can't be over any budget, so it's safe to forget.
LONGEST_WINDOW_S = HOUR_S


def prune(now: float | None = None) -> int:
    """Forgets every key whose requests have all aged out of the longest
    window. Without this, an address that never comes back would stay in
    memory until the server restarts - check_rate only tidies a key when that
    key is used again. Returns how many keys were dropped."""
    cutoff = (time.monotonic() if now is None else now) - LONGEST_WINDOW_S
    with _lock:
        idle = [key for key, stamps in _requests_by_ip.items() if not stamps or stamps[-1] <= cutoff]
        for key in idle:
            del _requests_by_ip[key]
    return len(idle)


def make_rate_limit(bucket: str, requests_per_window: int, window_s: float = WINDOW_S):
    """Builds a FastAPI dependency that raises 429 once an IP exceeds the
    request budget for this bucket - separate buckets so one endpoint's
    traffic can't exhaust another's budget."""

    def rate_limit_dependency(request: Request) -> None:
        check_rate(bucket, client_ip(request), requests_per_window, window_s)

    return rate_limit_dependency


rate_limit = make_rate_limit("find_pois", REQUESTS_PER_WINDOW)
lookup_poi_rate_limit = make_rate_limit("lookup_poi", LOOKUP_POI_REQUESTS_PER_WINDOW)
routing_rate_limit = make_rate_limit("routing", ROUTING_REQUESTS_PER_WINDOW)
geocode_rate_limit = make_rate_limit("geocode", GEOCODE_REQUESTS_PER_WINDOW)
map_poi_rate_limit = make_rate_limit("map_poi", MAP_POI_REQUESTS_PER_WINDOW)
photo_rate_limit = make_rate_limit("photos", PHOTO_REQUESTS_PER_WINDOW)
strava_rate_limit = make_rate_limit("strava", STRAVA_REQUESTS_PER_WINDOW)
wahoo_rate_limit = make_rate_limit("wahoo", WAHOO_REQUESTS_PER_WINDOW)
nl_route_rate_limit = make_rate_limit("nl_routes", NL_ROUTE_REQUESTS_PER_WINDOW)
login_rate_limit = make_rate_limit("login", LOGIN_REQUESTS_PER_WINDOW)
signup_rate_limit = make_rate_limit("signup", SIGNUP_REQUESTS_PER_HOUR, HOUR_S)
account_rate_limit = make_rate_limit("account", ACCOUNT_REQUESTS_PER_WINDOW)
