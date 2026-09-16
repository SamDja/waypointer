"""BRouter routing client for the in-app route planner.

Turns a pair of clicked map points into a road-snapped polyline. BRouter was
picked over the managed alternatives (ORS/GraphHopper/Mapbox) for three
reasons: its cycling profiles explicitly weight against traffic rather than
just preferring cycling infrastructure, it needs no API key at all, and its
GeoJSON response carries elevation inline - which matters because a FIT
course with no altitude data renders as a flat black line on a Wahoo ELEMNT
ROAM (see fit_io.py's _elevation_stats).

Structured as an "external HTTP dependency with a cache": module-level
env-overridable URL, a shared TTLCache, a descriptive User-Agent, and one
error type the caller maps to a 502.
"""

import os
from dataclasses import dataclass

import requests

from waypointer.geometry import LatLon
from waypointer.ttl_cache import TTLCache

# BRouter's public instance is a shared community service - identify
# ourselves rather than sending the default python-requests UA.
USER_AGENT = "waypointer/0.1 (+https://github.com/SamDja/waypointer)"

# Defaults to BRouter's public instance; set ROUTING_URL to point at a
# self-hosted one instead. Self-hosting needs per-region .rd5 segment files
# (tractable for a single country on a Raspberry Pi, impractical for a
# global deploy), so the public instance is the default rather than an
# afterthought.
ROUTING_URL = os.environ.get("ROUTING_URL", "https://brouter.de/brouter")

CACHE_TTL_S = 3600.0

# Profiles this app is willing to forward. The caller-supplied profile comes
# straight from the frontend, so it's checked against this set rather than
# passed through - BRouter would otherwise happily accept any profile name
# its server happens to host. Mirrors the routingProfile values in
# frontend/src/lib/mapStyles.ts (same hand-mirroring convention as
# poi_types.py/poiTypes.ts).
ALLOWED_PROFILES = frozenset({"fastbike-lowtraffic"})
DEFAULT_PROFILE = "fastbike-lowtraffic"


class RoutingError(RuntimeError):
    """Raised when the routing request fails or returns malformed data."""


@dataclass(frozen=True)
class RoutedLeg:
    # Index-parallel: elevations[i] is the elevation at coords[i], or None
    # where BRouter returned a 2D coordinate. Matches the (coords, elevations)
    # split gpx_io.route_coordinates()/route_elevations() produce, so callers
    # can treat a routed leg and a parsed GPX track identically.
    coords: list[LatLon]
    elevations: list[float | None]
    distance_m: float


_cache: TTLCache[RoutedLeg] = TTLCache(CACHE_TTL_S)


def _cache_key(start: LatLon, end: LatLon, profile: str, url: str) -> str:
    return f"{url}\n{profile}\n{start[0]},{start[1]}\n{end[0]},{end[1]}"


def build_routing_params(start: LatLon, end: LatLon, profile: str) -> dict[str, str]:
    """Builds BRouter's query parameters for a two-point leg.

    Note the coordinate order flip: BRouter's `lonlats` is lon,lat pairs,
    while every coordinate elsewhere in this codebase is (lat, lon).
    """
    return {
        "lonlats": f"{start[1]},{start[0]}|{end[1]},{end[0]}",
        "profile": profile,
        # BRouter can return several alternatives; 0 is the primary one.
        "alternativeidx": "0",
        "format": "geojson",
    }


def _parse_leg(payload: dict) -> RoutedLeg:
    """Splits BRouter's GeoJSON into this codebase's (lat, lon) coords plus a
    parallel elevation list.

    BRouter returns a FeatureCollection holding a single LineString whose
    coordinates are 3D - [lon, lat, ele] - and a `track-length` property in
    metres (as a string). A 2D coordinate yields a None elevation rather than
    0, so downstream gain/loss math treats it as "unknown" instead of sea
    level (the same rule as gpx_io.route_elevations()).
    """
    try:
        feature = payload["features"][0]
        raw_coords = feature["geometry"]["coordinates"]
        track_length = feature["properties"]["track-length"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RoutingError(f"Routing API returned malformed data: {exc}") from exc

    coords: list[LatLon] = []
    elevations: list[float | None] = []
    try:
        for point in raw_coords:
            coords.append((float(point[1]), float(point[0])))
            elevations.append(float(point[2]) if len(point) > 2 else None)
        distance_m = float(track_length)
    except (IndexError, TypeError, ValueError) as exc:
        raise RoutingError(f"Routing API returned malformed data: {exc}") from exc

    if len(coords) < 2:
        raise RoutingError("Routing API returned no usable route between those points.")

    return RoutedLeg(coords=coords, elevations=elevations, distance_m=distance_m)


def route_leg(
    start: LatLon,
    end: LatLon,
    profile: str = DEFAULT_PROFILE,
    session: requests.Session | None = None,
    url: str = ROUTING_URL,
    use_cache: bool = True,
) -> RoutedLeg:
    """Routes a single leg between two points and returns its polyline.

    Cached on the exact (start, end, profile) triple: dragging a planner
    anchor away and back, or undoing an edit, is then free rather than
    another hit on a shared public instance.
    """
    if profile not in ALLOWED_PROFILES:
        raise ValueError(f"Unknown routing profile: {profile}")

    key = _cache_key(start, end, profile, url)
    if use_cache:
        cached = _cache.get(key)
        if cached is not None:
            return cached

    http = session or requests
    try:
        response = http.get(
            url,
            params=build_routing_params(start, end, profile),
            headers={"User-Agent": USER_AGENT},
            timeout=30,
        )
    except requests.RequestException as exc:
        raise RoutingError(f"Routing request failed: {exc}") from exc

    if response.status_code != 200:
        raise RoutingError(
            f"Routing API returned status {response.status_code}: {response.text[:200]}"
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise RoutingError(f"Routing API returned malformed data: {exc}") from exc

    leg = _parse_leg(payload)
    if use_cache:
        _cache.set(key, leg)
    return leg
