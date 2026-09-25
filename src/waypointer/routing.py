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
ALLOWED_PROFILES = frozenset({"fastbike", "hiking-mountain"})
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
# This allowlist is the *only* guard on option names: BRouter silently
# ignores a `profile:` parameter that no variable matches - it answers 200
# with the unmodified route rather than an error - so a misspelled name here
# would quietly do nothing instead of failing loudly.
#
# fastbike rather than fastbike-lowtraffic: the two profiles are identical
# except for consider_traffic's default (0.1 vs 1), and since that's an
# option always sent explicitly, the profile choice only sets the default.
#
# hiking-mountain rather than the hiking-beta the public instance also still
# serves: hiking-beta was dropped from BRouter upstream after v1.6.3, so
# self-hosting (which ships upstream's profile set) would lose it, and it
# declares no `# %name%` options at all - its tunables are bare `assign`s
# that only respond to overrides by undocumented accident. hiking-mountain
# is in upstream master and declares each option with its type and range.
PROFILE_OPTIONS: dict[str, dict[str, RoutingOption]] = {
    "fastbike": {
        # How much longer a detour is worth to avoid busy roads: BRouter
        # scales its traffic penalty by this (1 = strongest avoidance,
        # 0 = ignore traffic).
        "consider_traffic": ChoiceOption(choices=(0.0, 0.1, 0.3, 0.5, 1.0), default=0.1),
        # Deliberately off, unlike fastbike's own defaults: a road bike
        # planner shouldn't route onto either unless asked.
        "allow_ferries": BoolOption(default=False),
        "allow_steps": BoolOption(default=False),
        "consider_noise": BoolOption(default=False),
        "consider_river": BoolOption(default=False),
        "consider_forest": BoolOption(default=False),
        "consider_town": BoolOption(default=False),
    },
    "hiking-mountain": {
        # The SAC mountaineering scale (Key:sac_scale): T1 hiking, T2
        # mountain hiking, T3 demanding mountain hiking. Paths below the
        # preferred level are penalised slightly and above it strongly, so
        # this shapes the route without forbidding anything - the profile's
        # separate hard cap (SAC_scale_limit, left at its own default of T3)
        # is not offered, since two SAC knobs side by side read as one
        # setting contradicting the other.
        "SAC_scale_preferred": ChoiceOption(choices=(1.0, 2.0, 3.0), default=1.0),
        # Multiplies the cost of ways that aren't part of a marked hiking
        # route by 1 + this. The profile allows 0.10-2.0 continuously; a
        # fixed set of steps for the same reason as ChoiceOption itself.
        "hiking_routes_preference": ChoiceOption(choices=(0.1, 0.2, 0.5, 1.0), default=0.2),
        "iswet": BoolOption(default=False),
        "consider_elevation": BoolOption(default=False),
        # Left at the profile's own defaults (both on), unlike fastbike
        # above: steps are an ordinary part of a walking route rather than
        # something to route around, and a ferry is a normal way for a
        # walker to cross water.
        "allow_steps": BoolOption(default=True),
        "allow_ferries": BoolOption(default=True),
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


class RoutingRateLimitedError(RoutingError):
    """The routing service answered 429 - this server's IP is being throttled
    upstream, so the caller should back off rather than retry straight away."""


# Surface categories for the planner's surface band, from each stretch's OSM
# tags. Cobbles are their own category because they matter to a road bike in
# a way "paved" hides.
PAVED_SURFACES = frozenset(
    {"asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes", "paving_stones", "chipseal", "metal"}
)
COBBLE_SURFACES = frozenset({"sett", "cobblestone", "unhewn_cobblestone", "cobblestone:flattened"})
UNPAVED_SURFACES = frozenset(
    {
        "unpaved", "compacted", "fine_gravel", "gravel", "pebblestone", "rock", "ground", "dirt",
        "earth", "grass", "grass_paver", "mud", "sand", "woodchips", "clay",
    }
)
# Road classes whose surface is almost never tagged but is, in practice,
# asphalt - counting them as unknown would fill the band with "unknown" on
# roads that obviously aren't.
MAJOR_ROADS = frozenset(
    {"motorway", "trunk", "primary", "secondary", "tertiary"}
    | {f"{road}_link" for road in ("motorway", "trunk", "primary", "secondary", "tertiary")}
)


def surface_category(tags: dict[str, str]) -> str:
    """paved / cobbles / unpaved / unknown, from a stretch's OSM tags.

    An explicit `surface` wins. Without one: a major road counts as paved, a
    track by its `tracktype` (grade1 is paved, grade2+ isn't), and anything
    else is honestly unknown.
    """
    surface = tags.get("surface")
    if surface in PAVED_SURFACES:
        return "paved"
    if surface in COBBLE_SURFACES:
        return "cobbles"
    if surface in UNPAVED_SURFACES:
        return "unpaved"
    if surface is None:
        if tags.get("highway") in MAJOR_ROADS:
            return "paved"
        tracktype = tags.get("tracktype")
        if tracktype == "grade1":
            return "paved"
        if tracktype is not None:
            return "unpaved"
    return "unknown"


@dataclass(frozen=True)
class SurfaceRun:
    # A stretch of one surface category, in route order. Distances are
    # BRouter's own per-stretch metres, which sum to the leg's distance_m.
    category: str
    distance_m: float


@dataclass(frozen=True)
class RoutedLeg:
    # Index-parallel: elevations[i] is the elevation at coords[i], or None
    # where BRouter returned a 2D coordinate. Matches the (coords, elevations)
    # split gpx_io.route_coordinates()/route_elevations() produce, so callers
    # can treat a routed leg and a parsed GPX track identically.
    coords: list[LatLon]
    elevations: list[float | None]
    distance_m: float
    # Consecutive same-category stretches merged; empty if BRouter sent no
    # per-stretch data.
    surface: tuple[SurfaceRun, ...] = ()
    # How much of the leg is on dedicated cycleways (highway=cycleway).
    cycleway_m: float = 0.0


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

    surface, cycleway_m = _parse_surface(feature["properties"].get("messages"))
    return RoutedLeg(
        coords=coords, elevations=elevations, distance_m=distance_m, surface=surface, cycleway_m=cycleway_m
    )


def _parse_surface(messages: object) -> tuple[tuple[SurfaceRun, ...], float]:
    """Surface runs and cycleway metres from BRouter's `messages` table.

    That table is a header row then one row per stretch of road, each with its
    own `Distance` (metres) and `WayTags` (space-separated `key=value` OSM
    tags). It's informational, so anything malformed just yields no surface
    data rather than failing the whole leg.
    """
    if not isinstance(messages, list) or len(messages) < 2:
        return (), 0.0
    header = messages[0]
    try:
        distance_col = header.index("Distance")
        tags_col = header.index("WayTags")
    except (ValueError, AttributeError):
        return (), 0.0

    runs: list[SurfaceRun] = []
    cycleway_m = 0.0
    for row in messages[1:]:
        try:
            distance = float(row[distance_col])
            tags = dict(tag.split("=", 1) for tag in str(row[tags_col]).split() if "=" in tag)
        except (IndexError, TypeError, ValueError):
            return (), 0.0
        if tags.get("highway") == "cycleway":
            cycleway_m += distance
        category = surface_category(tags)
        if runs and runs[-1].category == category:
            runs[-1] = SurfaceRun(category, runs[-1].distance_m + distance)
        else:
            runs.append(SurfaceRun(category, distance))
    return tuple(runs), cycleway_m


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

    if response.status_code == 429:
        raise RoutingRateLimitedError("Routing API rate limit reached.")
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
