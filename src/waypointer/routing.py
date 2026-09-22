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

import math
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
ALLOWED_PROFILES = frozenset({"fastbike"})
DEFAULT_PROFILE = "fastbike"


@dataclass(frozen=True)
class BoolOption:
    default: bool


@dataclass(frozen=True)
class ChoiceOption:
    # A fixed set of numeric values rather than a free number, so a visitor
    # can't push BRouter's cost model somewhere nobody tested.
    choices: tuple[float, ...]
    default: float


RoutingOption = BoolOption | ChoiceOption

# The BRouter profile parameters each profile lets a visitor change, passed
# as `profile:<name>=<value>` query parameters (BRouter's per-request
# override of a profile's `assign ... # %name%` variables). An allowlist for
# the same reason as ALLOWED_PROFILES; everything not listed stays at the
# profile's own default. Mirrors the routingOptions in
# frontend/src/lib/mapStyles.ts, labels and all, by hand.
#
# Two defaults deliberately differ from fastbike's own: ferries and steps are
# off, since a road bike planner shouldn't route onto either unless asked.
#
# fastbike rather than fastbike-lowtraffic: the two profiles are identical
# except for consider_traffic's default (0.1 vs 1), and since that's an
# option always sent explicitly, the profile choice only sets the default.
PROFILE_OPTIONS: dict[str, dict[str, RoutingOption]] = {
    "fastbike": {
        # How much longer a detour is worth to avoid busy roads: BRouter
        # scales its traffic penalty by this (1 = strongest avoidance,
        # 0 = ignore traffic).
        "consider_traffic": ChoiceOption(choices=(0.0, 0.1, 0.3, 0.5, 1.0), default=0.1),
        "allow_ferries": BoolOption(default=False),
        "allow_steps": BoolOption(default=False),
        "consider_noise": BoolOption(default=False),
        "consider_river": BoolOption(default=False),
        "consider_forest": BoolOption(default=False),
        "consider_town": BoolOption(default=False),
    },
}


def resolve_options(profile: str, options: dict[str, object] | None) -> dict[str, str]:
    """Validates caller-supplied options for `profile` and returns every
    option that profile exposes, encoded for BRouter.

    Missing options take their default, and every exposed option is always
    returned - so the cache key and the request are unambiguous, and a change
    of defaults on the public instance can't quietly change a route. Raises
    ValueError for an unknown option or a value of the wrong kind.

    BRouter's encoding: booleans must be `1`/`0` (it answers `true` with an
    empty body), numbers are plain decimals.
    """
    allowed = PROFILE_OPTIONS.get(profile, {})
    supplied = options or {}
    unknown = sorted(set(supplied) - set(allowed))
    if unknown:
        raise ValueError(f"Unknown routing option(s) for {profile}: {', '.join(unknown)}")

    encoded: dict[str, str] = {}
    for name, spec in sorted(allowed.items()):
        value = supplied.get(name, spec.default)
        if isinstance(spec, BoolOption):
            if not isinstance(value, bool):
                raise ValueError(f"Routing option {name} must be true or false.")
            encoded[name] = "1" if value else "0"
        else:
            # bool is an int subclass - reject it explicitly for a number.
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"Routing option {name} must be a number.")
            if not any(math.isclose(value, choice) for choice in spec.choices):
                raise ValueError(f"Routing option {name} must be one of {list(spec.choices)}.")
            encoded[name] = f"{value:g}"
    return encoded


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


def _cache_key(
    start: LatLon, end: LatLon, profile: str, options: dict[str, str], url: str
) -> str:
    encoded = ",".join(f"{name}={value}" for name, value in sorted(options.items()))
    return f"{url}\n{profile}\n{encoded}\n{start[0]},{start[1]}\n{end[0]},{end[1]}"


def build_routing_params(
    start: LatLon, end: LatLon, profile: str, options: dict[str, str] | None = None
) -> dict[str, str]:
    """Builds BRouter's query parameters for a two-point leg.

    Note the coordinate order flip: BRouter's `lonlats` is lon,lat pairs,
    while every coordinate elsewhere in this codebase is (lat, lon).
    `options` are already-encoded values from resolve_options().
    """
    params = {
        "lonlats": f"{start[1]},{start[0]}|{end[1]},{end[0]}",
        "profile": profile,
        # BRouter can return several alternatives; 0 is the primary one.
        "alternativeidx": "0",
        "format": "geojson",
    }
    for name, value in (options or {}).items():
        params[f"profile:{name}"] = value
    return params


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
    options: dict[str, object] | None = None,
    session: requests.Session | None = None,
    url: str = ROUTING_URL,
    use_cache: bool = True,
) -> RoutedLeg:
    """Routes a single leg between two points and returns its polyline.

    Cached on the exact (start, end, profile, options): dragging a planner
    anchor away and back, undoing an edit, or flipping an option back is then
    free rather than another hit on a shared public instance. Raises
    ValueError for an unknown profile or invalid options (see
    resolve_options).
    """
    if profile not in ALLOWED_PROFILES:
        raise ValueError(f"Unknown routing profile: {profile}")
    encoded = resolve_options(profile, options)

    key = _cache_key(start, end, profile, encoded, url)
    if use_cache:
        cached = _cache.get(key)
        if cached is not None:
            return cached

    http = session or requests
    try:
        response = http.get(
            url,
            params=build_routing_params(start, end, profile, encoded),
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
