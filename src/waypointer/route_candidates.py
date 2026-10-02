"""Natural-language routes, step two: candidates, metrics, ranking.

route_request.py turns the visitor's words into RouteConstraints; this module
turns those into routes. The same rule holds as there: **the LLM never
routes**. Candidates are drawn geometrically (circles of via points, detours,
turnaround points, known passes), routed by BRouter, and then measured
entirely by us - distance, ascent, climbs, surface, water - so the ranking
and every number later shown to the visitor come from the routes themselves.
The LLM only writes the short explanation, from those numbers.

Road cycling only for now (the parser asks about anything else first).

Layout, in pipeline order:
- check_feasibility: cheap heuristics, before any routing call.
- plan_candidates: the via points of each candidate - pure geometry.
- generate: routes the plans (one BRouter call each), drops near-duplicates.
- measure / score: metrics, and how far each misses the request.
- explain: one LLM call for the shortlisted options, with a template
  fallback - an explanation failing never fails the request.
- generate_routes: the whole pipeline, as the endpoint runs it.
"""

import dataclasses
import json
import logging
import math
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Literal

import requests

from waypointer import llm, poi_db, routing
from waypointer.climbs import (
    CATEGORY_RANK,
    ROAD_CYCLING_CLIMBS,
    Climb,
    ClimbCategory,
    detect_climbs,
    route_difficulty,
    route_max_grade_pct,
)
from waypointer.geometry import (
    EARTH_RADIUS_M,
    LatLon,
    _to_local_xy,
    cumulative_distances_m,
    elevation_gain_loss_m,
    haversine_m,
    point_to_polyline_distance_m,
)
from waypointer.route_request import Range, RouteConstraints, RouteType

logger = logging.getLogger(__name__)

ROUTING_PROFILE = "fastbike"
ACTIVITY = "road_cycling"

# ---- tunables ---------------------------------------------------------------

# How much longer a road route is than the straight lines between its points,
# until measured: sizes circles and detours so the routed distance lands near
# the target. Mountain roads wind far more (1.7+), which is why a first round
# of candidates measures it for the rest (observed_road_factor).
ROAD_FACTOR = 1.3
ROAD_FACTOR_RANGE = (1.1, 2.5)
# Candidates routed before the road factor (and the start's elevation) are
# measured; the rest of MAX_CANDIDATES are sized with what was learnt.
FIRST_ROUND = 4
# The most candidates routed per request, so the public BRouter instance sees
# about this many calls (each candidate is one call - routing.route_via).
MAX_CANDIDATES = 10
# Parallel BRouter calls. Small on purpose: it's a shared community instance.
ROUTING_WORKERS = 3
# The best options returned (and explained).
SHORTLIST = 3
# A generated via point closer than this to a place to avoid is dropped.
AVOID_RADIUS_M = 5_000
# A named climb counts as ridden when the route passes within this of it.
NAMED_CLIMB_HIT_M = 200
# Two candidates sharing this much of their route are the same option.
DUPLICATE_SHARE = 0.9
DUPLICATE_NEAR_M = 30
# A stretch ridden again within this distance of itself counts as repeated.
REPEAT_NEAR_M = 25
REPEAT_SAMPLE_M = 50
# Stretches closer than this along the route are neighbours, not repeats.
REPEAT_MIN_GAP_M = 500
# Water within this of the route counts.
WATER_NEAR_M = 100
# The default duration model: distance / flat speed + ascent / VAM. Overridden
# by the account's own settings (schemas.ProfileSettings).
DEFAULT_FLAT_SPEED_KMH = 25.0
DEFAULT_VAM_M_PER_H = 700.0

# Feasibility (check_feasibility).
MIN_DISTANCE_KM = 5
MAX_DISTANCE_KM = 300
# More climbing than this per km isn't a road ride anywhere.
MAX_ASCENT_M_PER_KM = 35
# Below this many metres of ascent a climb can come from any hill, so only
# bigger categories are checked against the known passes in reach.
RELIEF_CHECK_MIN_ASCENT_M = 320
# Relief needed for a category, as a share of its nominal ascent: a pass's
# height above the start underestimates the climb when the road dips first.
RELIEF_SHARE = 0.8

# The length a loop or out-and-back gets when only its difficulty, ascent or
# climbs sized it - the start of each difficulty level's distance band.
DISTANCE_FOR_DIFFICULTY_KM = {"easy": 30, "moderate": 60, "hard": 100, "very_hard": 150}
# Metres of climbing per km of a typical hilly ride, to size a route asked for
# by ascent alone.
TYPICAL_M_PER_KM = 15

# A Strava category is a score of length x gradient, which is 100 x ascent,
# so each category starts at this many metres of ascent.
CATEGORY_MIN_ASCENT_M: dict[str, float] = {"4": 80, "3": 160, "2": 320, "1": 640, "HC": 800}

# How much each kind of miss weighs in a candidate's score. A miss is
# measured in "range widths" (see _range_miss), so 1.0 is "as far outside the
# range as the range is wide". In one place so it can be tuned with feedback.
SCORING_WEIGHTS: dict[str, float] = {
    "distance": 3.0,
    "ascent": 2.0,
    "max_gradient": 1.5,
    "difficulty": 1.0,
    "climb_categories": 2.0,
    "named_climbs": 4.0,
    "avoid_surface": 1.5,
    "repeated_road": 2.0,
    # Only when nothing sized an A->B: a mild preference for the shorter way.
    "detour": 0.5,
    # Unasked: a stretch steeper than any road (BRouter took a track).
    "road_gradient": 8.0,
    # Offered a different shape than asked (an out-and-back for a loop).
    "route_shape": 3.0,
}
# Steeper than this, a stretch isn't a road a road bike rides - BRouter has
# taken a track or a path. Penalised (as road_gradient) when the visitor set
# no gradient limit of their own.
ROAD_MAX_SANE_GRADE_PCT = 20.0
# Read over this window rather than the 100m of the climbs' max gradient:
# DEM noise at mountain hairpins already reads as 30% over 100m on a road
# that tops out at 15%, while a track up a mountainside stays steep over
# 500m too.
ROAD_GRADE_WINDOW_M = 500.0


# ---- geometry helpers -------------------------------------------------------


def destination(p: LatLon, bearing_deg: float, distance_m: float) -> LatLon:
    """The point distance_m from p along bearing_deg (0 = north, clockwise)."""
    lat1, lon1 = math.radians(p[0]), math.radians(p[1])
    brg = math.radians(bearing_deg)
    d = distance_m / EARTH_RADIUS_M
    lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(brg))
    lon2 = lon1 + math.atan2(
        math.sin(brg) * math.sin(d) * math.cos(lat1), math.cos(d) - math.sin(lat1) * math.sin(lat2)
    )
    return (math.degrees(lat2), (math.degrees(lon2) + 540) % 360 - 180)


def bearing(a: LatLon, b: LatLon) -> float:
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return math.degrees(math.atan2(x, y)) % 360


def _dist(a: LatLon, b: LatLon) -> float:
    return haversine_m(a[0], a[1], b[0], b[1])


def _path_m(points: list[LatLon]) -> float:
    return sum(_dist(points[i], points[i + 1]) for i in range(len(points) - 1))


# ---- inputs -----------------------------------------------------------------


@dataclass(frozen=True)
class KnownClimb:
    """A road pass from the PostGIS import (OSM mountain_pass=yes)."""

    name: str | None
    point: LatLon
    ele_m: float | None


def find_passes(start: LatLon, radius_m: float, limit: int = 40) -> list[KnownClimb]:
    """The road passes in reach of the start. A database failure means no
    known climbs rather than no routes."""
    try:
        nodes = poi_db.query_pois_near_point("mountain_pass", start[0], start[1], radius_m, limit)
    except poi_db.PoiDbError as exc:
        logger.warning("mountain pass lookup failed: %s", exc)
        return []
    passes = []
    for node in nodes:
        try:
            ele = float(str(node.tags.get("ele", "")).replace(",", ".").removesuffix("m").strip())
        except ValueError:
            ele = None
        passes.append(KnownClimb(name=node.tags.get("name"), point=(node.lat, node.lon), ele_m=ele))
    return passes


def target_distance_km(constraints: RouteConstraints) -> float | None:
    """The distance to aim for: the middle of the requested range, else
    whatever else sized the request. None for an A->B nothing sized - the
    direct route and its alternatives are then the candidates."""
    r = constraints.distance_km
    if r is not None and (r.min is not None or r.max is not None):
        if r.min is not None and r.max is not None:
            return (r.min + r.max) / 2
        # "At least 80" aims a little above it, "at most 80" a little below.
        return r.min * 1.1 if r.min is not None else r.max * 0.9  # type: ignore[operator]
    parsed = constraints.parsed
    if parsed.route_type == "a_to_b":
        return None
    if parsed.ascent_m is not None:
        ascent = parsed.ascent_m.min if parsed.ascent_m.min is not None else parsed.ascent_m.max
        if ascent:
            return max(MIN_DISTANCE_KM, ascent / TYPICAL_M_PER_KM)
    if parsed.difficulty is not None:
        return DISTANCE_FOR_DIFFICULTY_KM[parsed.difficulty]
    required = [p.place for p in [*constraints.via, *constraints.climbs]]
    if required and constraints.start is not None:
        s = (constraints.start.place.lat, constraints.start.place.lon)
        far = max(_dist(s, (p.lat, p.lon)) for p in required)
        factor = 2.0 if parsed.route_type == "out_and_back" else 2.6
        return far * factor * ROAD_FACTOR / 1000
    return DISTANCE_FOR_DIFFICULTY_KM["moderate"]


def routing_options(constraints: RouteConstraints) -> dict[str, object]:
    """BRouter options for what the visitor asked to avoid. Tunnels and
    surfaces have no fastbike option, so scoring handles those."""
    # Ferries are already off by default on fastbike (routing.PROFILE_OPTIONS);
    # sent explicitly when asked, so a change of default can't undo it.
    options: dict[str, object] = {}
    if "ferries" in constraints.parsed.avoid.road_types:
        options["allow_ferries"] = False
    if "main_roads" in constraints.parsed.avoid.road_types:
        options["consider_traffic"] = 1.0
    return options


# ---- feasibility ------------------------------------------------------------


@dataclass(frozen=True)
class Infeasible:
    # distance / ascent_per_km / climb_relief
    reason: Literal["distance", "ascent_per_km", "climb_relief"]
    # In English, for the log and as the fallback explanation.
    detail: str
    # The nearest request we can plan: what to suggest instead.
    suggested_distance_km: Range | None = None
    suggested_ascent_m: Range | None = None
    suggested_climb_categories: list[ClimbCategory] | None = None


def check_feasibility(
    constraints: RouteConstraints,
    passes: list[KnownClimb] | None = None,
    start_ele_m: float | None = None,
) -> Infeasible | None:
    """Catches requests no route can meet, before (or, for the relief check,
    just after the first) routing call. Heuristics, deliberately lenient: a
    request that's merely hard should still get its closest candidates."""
    distance = constraints.distance_km
    if distance is not None:
        if distance.max is not None and distance.max < MIN_DISTANCE_KM:
            return Infeasible(
                "distance",
                f"{distance.max:g} km is shorter than the {MIN_DISTANCE_KM} km we plan.",
                suggested_distance_km=Range(min=MIN_DISTANCE_KM, max=max(MIN_DISTANCE_KM * 2, distance.max)),
            )
        if distance.min is not None and distance.min > MAX_DISTANCE_KM:
            return Infeasible(
                "distance",
                f"{distance.min:g} km is longer than the {MAX_DISTANCE_KM} km we plan in one go.",
                suggested_distance_km=Range(min=MAX_DISTANCE_KM * 0.8, max=MAX_DISTANCE_KM),
            )

    ascent = constraints.parsed.ascent_m
    wanted = sorted(constraints.parsed.climbs.categories, key=lambda c: CATEGORY_RANK[c], reverse=True)
    needed_ascent = max(
        (ascent.min if ascent and ascent.min is not None else 0),
        sum(CATEGORY_MIN_ASCENT_M[c] for c in wanted),
    )
    longest = distance.max if distance and distance.max is not None else None
    if longest and needed_ascent > MAX_ASCENT_M_PER_KM * longest:
        return Infeasible(
            "ascent_per_km",
            f"{needed_ascent:.0f} m of climbing in {longest:g} km is more than {MAX_ASCENT_M_PER_KM} m per km.",
            suggested_distance_km=Range(min=math.ceil(needed_ascent / MAX_ASCENT_M_PER_KM), max=None),
            suggested_ascent_m=Range(min=None, max=MAX_ASCENT_M_PER_KM * longest),
        )

    # Big categories need real relief, and only a named climb or a known pass
    # high enough above the start provides that.
    if passes is not None and start_ele_m is not None and not constraints.climbs:
        big = [c for c in wanted if CATEGORY_MIN_ASCENT_M[c] >= RELIEF_CHECK_MIN_ASCENT_M]
        if big:
            relief = max(
                (p.ele_m - start_ele_m for p in passes if p.ele_m is not None), default=0.0
            )
            if relief < CATEGORY_MIN_ASCENT_M[big[0]] * RELIEF_SHARE:
                reachable = [
                    c for c in ("HC", "1", "2", "3", "4") if CATEGORY_MIN_ASCENT_M[c] * RELIEF_SHARE <= max(relief, 0)
                ]
                return Infeasible(
                    "climb_relief",
                    f"No known pass in reach climbs more than {max(relief, 0):.0f} m above the start, "
                    f"short of a {'HC' if big[0] == 'HC' else 'Cat ' + big[0]} climb.",
                    suggested_climb_categories=reachable[:1] or None,
                )
    return None


# ---- planning -----------------------------------------------------------------

PlanKind = Literal["loop", "a_to_b", "out_and_back"]


@dataclass(frozen=True)
class Plan:
    """One candidate before routing: the points BRouter routes through."""

    id: str
    kind: PlanKind
    points: tuple[LatLon, ...]
    alternative: int = 0
    # Out-and-back: routed one way, then ridden back the same way.
    mirrored: bool = False
    # The known passes this plan was seeded with, for the explanation.
    seeded_with: tuple[str, ...] = ()


def _required_points(constraints: RouteConstraints) -> list[LatLon]:
    return [(p.place.lat, p.place.lon) for p in [*constraints.via, *constraints.climbs]]


def _avoid_points(constraints: RouteConstraints) -> list[LatLon]:
    return [(p.place.lat, p.place.lon) for p in constraints.avoid]


def _circle_loop(start: LatLon, radius_m: float, centre_bearing: float, n: int) -> list[LatLon]:
    """n points evenly round a circle through the start (the start included,
    first), going clockwise."""
    centre = destination(start, centre_bearing, radius_m)
    back = (centre_bearing + 180) % 360
    return [start] + [destination(centre, back + 360 * k / n, radius_m) for k in range(1, n)]


def _loop_through(start: LatLon, radius_m: float, required: list[LatLon], n: int, side: int) -> list[LatLon] | None:
    """A loop through the required points: the circle through the start and
    the farthest of them (on one side or the other), with each required point
    standing in for the nearest circle point, ordered round the circle."""
    far = max(required, key=lambda p: _dist(start, p))
    s = _dist(start, far)
    radius = max(radius_m, s / 2 * 1.02)
    alpha = math.degrees(math.acos(min(1.0, s / (2 * radius))))
    centre_bearing = (bearing(start, far) + side * alpha) % 360
    circle = _circle_loop(start, radius, centre_bearing, n)
    centre = destination(start, centre_bearing, radius)
    pts = circle[1:]
    for p in required:
        nearest = min(range(len(pts)), key=lambda i: _dist(pts[i], p))
        pts[nearest] = p
    # Order round the centre, clockwise from the start.
    start_angle = bearing(centre, start)
    pts.sort(key=lambda p: (bearing(centre, p) - start_angle) % 360 if side > 0 else (start_angle - bearing(centre, p)) % 360)
    return [start, *pts]


def _over_the_top(start: LatLon, ordered: list[LatLon], reach_m: float) -> list[LatLon]:
    """An out-and-back's points: through the required ones, and on beyond the
    last along the same bearing when it's short of the turnaround distance -
    over the pass and down the other side, as a rider would, rather than
    turning round at the top of a ride half the length asked for."""
    last = ordered[-1]
    gone = _dist(start, last)
    if gone >= reach_m * 0.9:
        return ordered
    return [*ordered, destination(last, bearing(start, last), reach_m - gone)]


def plan_candidates(
    constraints: RouteConstraints,
    target_km: float | None,
    passes: list[KnownClimb] | None = None,
    start_ele_m: float | None = None,
    road_factor: float = ROAD_FACTOR,
) -> list[Plan]:
    """The candidates to route, best ideas first (the list is cut at
    MAX_CANDIDATES after duplicates are dropped). road_factor is how much
    longer the roads are than straight lines - ROAD_FACTOR until a first
    round of routing has measured it (observed_road_factor)."""
    assert constraints.start is not None
    passes = passes or []
    start = (constraints.start.place.lat, constraints.start.place.lon)
    route_type: RouteType = constraints.parsed.route_type or "loop"
    required = _required_points(constraints)
    seeds = _climb_seeds(constraints, target_km, passes, start_ele_m, start, road_factor)
    plans: list[Plan] = []

    if route_type == "loop":
        radius = (target_km or 60) * 1000 / (2 * math.pi * road_factor)
        if required:
            # Several sizes: how much longer than the circle the roads turn
            # out depends on the terrain (far more in the mountains), and a
            # required point fixes where the loop goes, not how winding it is.
            for scale in (1.0, 0.8, 0.65):
                for side in (1, -1):
                    pts = _loop_through(start, radius * scale, required, 4, side)
                    if pts:
                        plans.append(Plan(f"loop-req-{side}-{scale}", "loop", (*pts, start)))
            # The closest thing when no loop of that length goes there on
            # roads (a pass with one road over it): there and back, which
            # scoring marks as a relaxed shape.
            ordered = sorted(required, key=lambda p: _dist(start, p))
            reach = (target_km or 60) * 1000 / 2 / road_factor
            plans.append(Plan("loop-as-oab", "out_and_back", (start, *_over_the_top(start, ordered, reach)), mirrored=True))
            for side in (1, -1):
                pts = _loop_through(start, radius, required, 5, side)
                if pts:
                    plans.append(Plan(f"loop-req-{side}-5pt", "loop", (*pts, start)))
        for seed in seeds:
            for side in (1, -1):
                pts = _loop_through(start, radius, [*required, seed.point], 4, side)
                if pts:
                    plans.append(Plan(f"loop-pass-{seed.name}-{side}", "loop", (*pts, start), seeded_with=(seed.name or "",)))
        for scale in (1.0, 0.85):
            for b in (0, 90, 180, 270, 45, 135, 225, 315):
                for n in (4, 3):
                    pts = _circle_loop(start, radius * scale, b, n)
                    plans.append(Plan(f"loop-{b}-{n}-{scale}", "loop", (*pts, start)))

    elif route_type == "out_and_back":
        reach = (target_km or 60) * 1000 / 2 / road_factor
        if required:
            ordered = sorted(required, key=lambda p: _dist(start, p))
            plans.append(Plan("oab-req", "out_and_back", (start, *_over_the_top(start, ordered, reach)), mirrored=True))
            plans.append(Plan("oab-req-at", "out_and_back", (start, *ordered), mirrored=True))
        for seed in seeds:
            plans.append(
                Plan(f"oab-pass-{seed.name}", "out_and_back", (start, seed.point), mirrored=True, seeded_with=(seed.name or "",))
            )
        for b in range(0, 360, 45):
            plans.append(Plan(f"oab-{b}", "out_and_back", (start, destination(start, b, reach)), mirrored=True))

    else:  # a_to_b
        assert constraints.end is not None
        end = (constraints.end.place.lat, constraints.end.place.lon)
        if required:
            # Along the way, in order of how far along the start->end line.
            along = sorted(required, key=lambda p: _dist(start, p) - _dist(p, end))
            for alt in range(3):
                plans.append(Plan(f"ab-req-{alt}", "a_to_b", (start, *along, end), alternative=alt))
        for seed in seeds:
            plans.append(Plan(f"ab-pass-{seed.name}", "a_to_b", (start, seed.point, end), seeded_with=(seed.name or "",)))
        for alt in range(routing.MAX_ALTERNATIVE + 1):
            plans.append(Plan(f"ab-direct-{alt}", "a_to_b", (start, end), alternative=alt))
        direct_m = _dist(start, end)
        if target_km and target_km * 1000 > direct_m * road_factor * 1.15:
            half = target_km * 1000 / (2 * road_factor)
            for stretch in (1.0, 0.8):
                offset = math.sqrt(max(0.0, (half * stretch) ** 2 - (direct_m / 2) ** 2))
                mid = destination(start, bearing(start, end), direct_m / 2)
                for side in (90, -90):
                    detour = destination(mid, bearing(start, end) + side, offset)
                    plans.append(Plan(f"ab-detour-{side}-{stretch}", "a_to_b", (start, detour, end)))

    avoid = _avoid_points(constraints)
    protected = {start, *required, *(s.point for s in seeds)}
    if route_type == "a_to_b" and constraints.end is not None:
        protected.add((constraints.end.place.lat, constraints.end.place.lon))
    kept = []
    seen: set[tuple[tuple[LatLon, ...], int]] = set()
    for plan in plans:
        generated = [p for p in plan.points if p not in protected]
        if any(_dist(p, a) < AVOID_RADIUS_M for p in generated for a in avoid):
            continue
        # Different sizes can collapse to the same plan (a loop can't be
        # smaller than the circle reaching its required point): route it once.
        key = (tuple((round(p[0], 4), round(p[1], 4)) for p in plan.points), plan.alternative)
        if key in seen:
            continue
        seen.add(key)
        kept.append(plan)
    if abs(road_factor - ROAD_FACTOR) > 0.05:
        # Re-sized plans are new candidates, not the first round's again.
        kept = [dataclasses.replace(p, id=f"{p.id}@{road_factor:.2f}") for p in kept]
    return kept


def _climb_seeds(
    constraints: RouteConstraints,
    target_km: float | None,
    passes: list[KnownClimb],
    start_ele_m: float | None,
    start: LatLon,
    road_factor: float = ROAD_FACTOR,
) -> list[KnownClimb]:
    """Known passes to build candidates round, for a climb asked for by
    category rather than by name: those in reach whose height above the
    start best matches the hardest category wanted. Named climbs are
    required points already, so they need no seeding."""
    wanted = constraints.parsed.climbs.categories
    if not wanted or not passes:
        return []
    hardest = max(wanted, key=lambda c: CATEGORY_RANK[c])
    goal = CATEGORY_MIN_ASCENT_M[hardest] * 1.3
    reach = (target_km or 60) * 1000 / (2 * road_factor)
    in_reach = [p for p in passes if _dist(start, p.point) <= reach]
    if start_ele_m is not None:
        rated = [p for p in in_reach if p.ele_m is not None]
        rated.sort(key=lambda p: abs((p.ele_m - start_ele_m) - goal))  # type: ignore[operator]
        in_reach = rated or in_reach
    return in_reach[:3]


# ---- routing ------------------------------------------------------------------


@dataclass
class RoutedCandidate:
    plan: Plan
    coords: list[LatLon]
    elevations: list[float | None]
    distance_m: float
    surface: list[routing.SurfaceRun]
    cycleway_m: float


RouteFn = Callable[[list[LatLon], str, dict[str, object] | None, int], routing.RoutedLeg]


def _default_route(points: list[LatLon], profile: str, options: dict[str, object] | None, alternative: int) -> routing.RoutedLeg:
    return routing.route_via(points, profile, options, alternative=alternative)


def route_plan(plan: Plan, options: dict[str, object], route: RouteFn = _default_route) -> RoutedCandidate:
    leg = route(list(plan.points), ROUTING_PROFILE, options, plan.alternative)
    coords, elevations = list(leg.coords), list(leg.elevations)
    surface = list(leg.surface)
    distance_m, cycleway_m = leg.distance_m, leg.cycleway_m
    if plan.mirrored:
        coords += coords[-2::-1]
        elevations += elevations[-2::-1]
        surface += surface[::-1]
        distance_m *= 2
        cycleway_m *= 2
    return RoutedCandidate(plan, coords, elevations, distance_m, surface, cycleway_m)


def _resample_xy(coords: list[LatLon], step_m: float, ref_lat: float) -> list[tuple[float, float, float]]:
    """(x, y, metres along) every step_m along the route, in a local metric
    projection around ref_lat - for the grid-hash proximity checks below."""
    cumulative = cumulative_distances_m(coords)
    total = cumulative[-1] if cumulative else 0.0
    samples: list[tuple[float, float, float]] = []
    if len(coords) < 2 or total <= 0:
        return samples
    j = 0
    d = 0.0
    while d <= total:
        while j < len(cumulative) - 2 and cumulative[j + 1] < d:
            j += 1
        span = cumulative[j + 1] - cumulative[j]
        t = (d - cumulative[j]) / span if span > 0 else 0.0
        lat = coords[j][0] + (coords[j + 1][0] - coords[j][0]) * t
        lon = coords[j][1] + (coords[j + 1][1] - coords[j][1]) * t
        x, y = _to_local_xy(lat, lon, ref_lat)
        samples.append((x, y, d))
        d += step_m
    return samples


Grid = dict[tuple[int, int], list[tuple[float, float, float]]]


def _grid_add(grid: Grid, cell_m: float, sample: tuple[float, float, float]) -> None:
    grid.setdefault((math.floor(sample[0] / cell_m), math.floor(sample[1] / cell_m)), []).append(sample)


def _grid_near(grid: Grid, cell_m: float, x: float, y: float, within_m: float, accept=lambda other: True) -> bool:
    """Whether any sample in the grid (cell size >= within_m) lies within
    within_m of (x, y) and passes `accept`."""
    cx, cy = math.floor(x / cell_m), math.floor(y / cell_m)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for other in grid.get((cx + dx, cy + dy), ()):
                if math.hypot(x - other[0], y - other[1]) <= within_m and accept(other):
                    return True
    return False


def _is_duplicate(candidate: RoutedCandidate, of: RoutedCandidate) -> bool:
    if abs(candidate.distance_m - of.distance_m) > 0.1 * of.distance_m:
        return False
    ref_lat = of.coords[0][0]
    grid: Grid = {}
    # Dense enough that a point on the same road is always near a sample.
    for sample in _resample_xy(of.coords, DUPLICATE_NEAR_M, ref_lat):
        _grid_add(grid, DUPLICATE_NEAR_M, sample)
    samples = _resample_xy(candidate.coords, max(candidate.distance_m / 100, 1.0), ref_lat)
    near = sum(1 for x, y, _ in samples if _grid_near(grid, DUPLICATE_NEAR_M, x, y, DUPLICATE_NEAR_M))
    return near >= DUPLICATE_SHARE * len(samples)


def generate(
    plans: list[Plan],
    options: dict[str, object],
    route: RouteFn = _default_route,
    limit: int = MAX_CANDIDATES,
) -> list[RoutedCandidate]:
    """Routes up to `limit` plans and drops near-duplicates. A plan BRouter
    can't route is skipped; being rate limited stops everything (the caller
    passes the 429 on), since every later call would be refused too."""
    chosen = plans[:limit]
    results: list[RoutedCandidate | None] = [None] * len(chosen)

    def run(i: int) -> None:
        try:
            results[i] = route_plan(chosen[i], options, route)
        except routing.RoutingRateLimitedError:
            raise
        except routing.RoutingError as exc:
            logger.info("candidate %s not routable: %s", chosen[i].id, exc)

    with ThreadPoolExecutor(max_workers=ROUTING_WORKERS) as pool:
        for future in [pool.submit(run, i) for i in range(len(chosen))]:
            future.result()

    unique: list[RoutedCandidate] = []
    for candidate in results:
        if candidate is None or len(candidate.coords) < 2:
            continue
        if any(_is_duplicate(candidate, other) for other in unique):
            continue
        unique.append(candidate)
    return unique


# ---- metrics ------------------------------------------------------------------


@dataclass(frozen=True)
class ClimbSummary:
    start_km: float
    length_km: float
    ascent_m: float
    avg_grade_pct: float
    max_grade_pct: float
    summit_m: float
    category: ClimbCategory | None


@dataclass(frozen=True)
class Metrics:
    distance_km: float
    ascent_m: float
    descent_m: float
    max_grade_pct: float
    # Steepest over ROAD_GRADE_WINDOW_M, for the road-sanity check.
    steepest_road_pct: float
    climbs: list[ClimbSummary]
    difficulty: str
    difficulty_level: int
    difficulty_reason: str | None
    duration_h: float
    # Share of the distance per surface category (paved/cobbles/unpaved/unknown).
    surface_share: dict[str, float]
    cycleway_share: float
    # None when the POI database couldn't be asked.
    water_count: int | None
    repeated_share: float
    # The named climbs (as the visitor wrote them) the route goes over.
    named_climbs_passed: list[str]


def estimate_duration_h(
    distance_m: float,
    ascent_m: float,
    flat_speed_kmh: float = DEFAULT_FLAT_SPEED_KMH,
    vam_m_per_h: float = DEFAULT_VAM_M_PER_H,
) -> float:
    """distance / flat speed + ascent / VAM - the card's road-cycling model."""
    if distance_m <= 0 or flat_speed_kmh <= 0:
        return 0.0
    climbing = max(0.0, ascent_m) / vam_m_per_h if vam_m_per_h > 0 else 0.0
    return distance_m / 1000 / flat_speed_kmh + climbing


def repeated_share(coords: list[LatLon]) -> float:
    """The share of the route ridden over a stretch it already covered - a
    loop that goes out and back along the same road isn't much of a loop.
    Resamples every REPEAT_SAMPLE_M and checks each sample against earlier
    ones at least REPEAT_MIN_GAP_M back, with a grid hash so it stays fast."""
    if len(coords) < 2:
        return 0.0
    samples = _resample_xy(coords, REPEAT_SAMPLE_M, coords[0][0])
    if not samples:
        return 0.0
    grid: Grid = {}
    repeated = 0
    for sample in samples:
        x, y, along = sample
        if _grid_near(grid, REPEAT_NEAR_M, x, y, REPEAT_NEAR_M, lambda other: along - other[2] >= REPEAT_MIN_GAP_M):
            repeated += 1
        _grid_add(grid, REPEAT_NEAR_M, sample)
    return repeated / len(samples)


WaterFn = Callable[[list[LatLon]], int | None]


def _default_water(coords: list[LatLon]) -> int | None:
    try:
        return len(poi_db.query_pois_near_route("water", coords, WATER_NEAR_M))
    except (poi_db.PoiDbError, ValueError) as exc:
        logger.info("water lookup failed: %s", exc)
        return None


def measure(
    candidate: RoutedCandidate,
    constraints: RouteConstraints,
    flat_speed_kmh: float = DEFAULT_FLAT_SPEED_KMH,
    vam_m_per_h: float = DEFAULT_VAM_M_PER_H,
    water: WaterFn | None = _default_water,
) -> Metrics:
    """Everything we tell the visitor about a candidate, all computed here.
    water=None skips the POI lookup (water_count None) - it doesn't affect
    the ranking, so only the shortlist pays for it."""
    coords, elevations = candidate.coords, candidate.elevations
    distance_m = cumulative_distances_m(coords)[-1]
    gain, loss = elevation_gain_loss_m(elevations)
    max_grade = route_max_grade_pct(coords, elevations)
    climbs: list[Climb] = detect_climbs(coords, elevations, ROAD_CYCLING_CLIMBS)
    difficulty = route_difficulty(distance_m, gain, max_grade, climbs)

    surface_total = sum(run.distance_m for run in candidate.surface)
    share: dict[str, float] = {"paved": 0.0, "cobbles": 0.0, "unpaved": 0.0, "unknown": 0.0}
    if surface_total > 0:
        for run in candidate.surface:
            share[run.category] = share.get(run.category, 0.0) + run.distance_m / surface_total
    else:
        share["unknown"] = 1.0

    passed = [
        c.query
        for c in constraints.climbs
        if point_to_polyline_distance_m((c.place.lat, c.place.lon), coords) <= NAMED_CLIMB_HIT_M
    ]
    return Metrics(
        distance_km=distance_m / 1000,
        ascent_m=gain,
        descent_m=loss,
        max_grade_pct=max_grade,
        steepest_road_pct=route_max_grade_pct(coords, elevations, ROAD_GRADE_WINDOW_M),
        climbs=[
            ClimbSummary(
                start_km=c.start_m / 1000,
                length_km=c.length_m / 1000,
                ascent_m=c.ascent_m,
                avg_grade_pct=c.avg_grade_pct,
                max_grade_pct=c.max_grade_pct,
                summit_m=c.summit_m,
                category=c.category,
            )
            for c in climbs
        ],
        difficulty=difficulty.label,
        difficulty_level=difficulty.level,
        difficulty_reason=difficulty.reason,
        duration_h=estimate_duration_h(distance_m, gain, flat_speed_kmh, vam_m_per_h),
        surface_share=share,
        cycleway_share=candidate.cycleway_m / candidate.distance_m if candidate.distance_m > 0 else 0.0,
        water_count=water(coords) if water is not None else None,
        repeated_share=repeated_share(coords) if candidate.plan.kind == "loop" else 0.0,
        named_climbs_passed=passed,
    )


# ---- scoring ------------------------------------------------------------------


@dataclass(frozen=True)
class Miss:
    """One way a candidate falls short of the request, for ranking and for
    telling the visitor which constraint was relaxed."""

    constraint: str
    wanted: str
    got: str
    penalty: float


@dataclass
class ScoredCandidate:
    candidate: RoutedCandidate
    metrics: Metrics
    score: float
    misses: list[Miss] = field(default_factory=list)


def _range_miss(value: float, r: Range | None) -> float:
    """0 inside the range; outside, how far out in units of the range's width
    (at least 10% of its nearest bound, so an exact "80 km" still tolerates a
    few km at a small cost)."""
    if r is None or (r.min is None and r.max is None):
        return 0.0
    lo, hi = r.min, r.max
    width = (hi - lo) if lo is not None and hi is not None else 0.0
    if lo is not None and value < lo:
        return (lo - value) / max(width, 0.1 * lo, 1e-9)
    if hi is not None and value > hi:
        return (value - hi) / max(width, 0.1 * hi, 1e-9)
    return 0.0


def _fmt_range(r: Range, unit: str) -> str:
    if r.min is not None and r.max is not None:
        return f"{r.min:g}-{r.max:g} {unit}" if r.min != r.max else f"{r.min:g} {unit}"
    return f"at least {r.min:g} {unit}" if r.min is not None else f"at most {r.max:g} {unit}"


DIFFICULTY_LEVELS = {"easy": 0, "moderate": 1, "hard": 2, "very_hard": 3}


def score(
    metrics: Metrics,
    constraints: RouteConstraints,
    kind: PlanKind,
    shortest_km: float | None = None,
    weights: dict[str, float] = SCORING_WEIGHTS,
) -> tuple[float, list[Miss]]:
    """Weighted distance from the request (lower is better), and every miss."""
    parsed = constraints.parsed
    misses: list[Miss] = []

    def add(name: str, amount: float, wanted: str, got: str) -> None:
        if amount > 0:
            misses.append(Miss(name, wanted, got, weights[name] * amount))

    if parsed.route_type is not None and kind != parsed.route_type:
        add("route_shape", 1, parsed.route_type.replace("_", " "), kind.replace("_", " "))
    if constraints.distance_km is not None:
        add(
            "distance",
            _range_miss(metrics.distance_km, constraints.distance_km),
            _fmt_range(constraints.distance_km, "km"),
            f"{metrics.distance_km:.0f} km",
        )
    elif kind == "a_to_b" and shortest_km:
        add("detour", metrics.distance_km / shortest_km - 1, "the direct way", f"{metrics.distance_km:.0f} km")
    if parsed.ascent_m is not None:
        add("ascent", _range_miss(metrics.ascent_m, parsed.ascent_m), _fmt_range(parsed.ascent_m, "m"), f"{metrics.ascent_m:.0f} m")
    if parsed.max_gradient_pct is not None and metrics.max_grade_pct > parsed.max_gradient_pct:
        add(
            "max_gradient",
            (metrics.max_grade_pct - parsed.max_gradient_pct) / max(parsed.max_gradient_pct, 1),
            f"at most {parsed.max_gradient_pct:g}%",
            f"{metrics.max_grade_pct:.0f}%",
        )
    elif parsed.max_gradient_pct is None and metrics.steepest_road_pct > ROAD_MAX_SANE_GRADE_PCT:
        add(
            "road_gradient",
            (metrics.steepest_road_pct - ROAD_MAX_SANE_GRADE_PCT) / ROAD_MAX_SANE_GRADE_PCT,
            f"at most {ROAD_MAX_SANE_GRADE_PCT:g}% over {ROAD_GRADE_WINDOW_M:.0f} m (a road)",
            f"{metrics.steepest_road_pct:.0f}%",
        )
    if parsed.difficulty is not None:
        gap = abs(metrics.difficulty_level - DIFFICULTY_LEVELS[parsed.difficulty])
        add("difficulty", gap, parsed.difficulty.replace("_", " "), metrics.difficulty)
    if parsed.climbs.categories:
        # Each wanted category matched by a distinct climb at least that hard.
        available = sorted(
            (CATEGORY_RANK[c.category] for c in metrics.climbs if c.category is not None), reverse=True
        )
        unmet = 0
        for wanted in sorted(parsed.climbs.categories, key=lambda c: CATEGORY_RANK[c], reverse=True):
            if available and available[0] >= CATEGORY_RANK[wanted]:
                available.pop(0)
            else:
                unmet += 1
        got = ", ".join(("HC" if c.category == "HC" else f"Cat {c.category}") for c in metrics.climbs if c.category) or "none"
        add(
            "climb_categories",
            unmet,
            ", ".join(("HC" if c == "HC" else f"Cat {c}") for c in parsed.climbs.categories),
            got,
        )
    if constraints.climbs:
        missing = [c.query for c in constraints.climbs if c.query not in metrics.named_climbs_passed]
        add("named_climbs", len(missing), ", ".join(c.query for c in constraints.climbs), "misses " + ", ".join(missing))
    avoided = parsed.avoid.surfaces
    if avoided:
        bad = sum(metrics.surface_share.get(s, 0.0) for s in avoided)
        add("avoid_surface", bad * 10, "no " + " or ".join(avoided), f"{bad:.0%} " + "/".join(avoided))
    if kind == "loop":
        # A little repetition (a shared stretch near the start) is fine.
        add("repeated_road", max(0.0, metrics.repeated_share - 0.05) * 5, "a real loop", f"{metrics.repeated_share:.0%} ridden twice")
    return sum(m.penalty for m in misses), misses


# ---- explanation ----------------------------------------------------------------

EXPLAIN_SYSTEM_PROMPT = """\
You describe route options to a road cyclist, in one or two short sentences \
each, written in the language given. Use only the numbers and facts in the \
data: never invent places, roads, sights or numbers. Mention the distance, \
the climbing and what stands out (a categorised climb, gravel, water stops). \
When an option lists relaxed constraints, say plainly which wish it doesn't \
meet and by how much. Answer with JSON: {"options": [{"id": ..., "text": ...}]}, \
one entry per option, same ids.
"""

EXPLAIN_SCHEMA = {
    "type": "object",
    "properties": {
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "text": {"type": "string"}},
                "required": ["id", "text"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["options"],
    "additionalProperties": False,
}


def _facts(scored: ScoredCandidate) -> dict:
    m = scored.metrics
    return {
        "id": scored.candidate.plan.id,
        "shape": scored.candidate.plan.kind,
        "distance_km": round(m.distance_km, 1),
        "ascent_m": round(m.ascent_m),
        "max_gradient_pct": round(m.max_grade_pct),
        "estimated_hours": round(m.duration_h, 1),
        "difficulty": m.difficulty,
        "climbs": [
            {
                "category": c.category,
                "length_km": round(c.length_km, 1),
                "avg_gradient_pct": round(c.avg_grade_pct, 1),
                "summit_m": round(c.summit_m),
            }
            for c in m.climbs
        ],
        "named_climbs_ridden": m.named_climbs_passed,
        "unpaved_share_pct": round(m.surface_share.get("unpaved", 0) * 100),
        "water_points": m.water_count,
        "relaxed_constraints": [{"wish": x.constraint, "wanted": x.wanted, "got": x.got} for x in scored.misses],
    }


def template_explanation(scored: ScoredCandidate) -> str:
    """The fallback when the LLM can't be reached: plain English facts."""
    m = scored.metrics
    parts = [f"{m.distance_km:.0f} km with {m.ascent_m:,.0f} m of climbing ({m.difficulty.lower()})"]
    categorised = [c for c in m.climbs if c.category]
    if categorised:
        top = max(categorised, key=lambda c: CATEGORY_RANK[c.category])  # type: ignore[index]
        label = "HC" if top.category == "HC" else f"Cat {top.category}"
        parts.append(f"its hardest climb is a {label} of {top.length_km:.1f} km at {top.avg_grade_pct:.1f}%")
    text = ", ".join(parts) + "."
    if scored.misses:
        text += " Not quite what you asked: " + "; ".join(f"{x.constraint.replace('_', ' ')} {x.got} (wanted {x.wanted})" for x in scored.misses) + "."
    return text


def explain(
    shortlist: list[ScoredCandidate],
    language: str,
    model_spec: str = llm.DEFAULT_MODEL_SPEC,
    session: requests.Session | None = None,
) -> dict[str, str]:
    """An explanation per shortlisted candidate, keyed by plan id. Written by
    the LLM from the computed facts only; any candidate it skips, and every
    one if it fails, gets the template instead."""
    texts = {s.candidate.plan.id: template_explanation(s) for s in shortlist}
    if not shortlist:
        return texts
    data = {"language": language, "options": [_facts(s) for s in shortlist]}
    try:
        result = llm.complete_json(
            EXPLAIN_SYSTEM_PROMPT,
            f"<data>\n{json.dumps(data)}\n</data>",
            EXPLAIN_SCHEMA,
            "route_explanations",
            model_spec,
            session=session,
            temperature=0.3,
        )
        content = result.content.strip().strip("`").removeprefix("json").strip()
        for option in json.loads(content).get("options", []):
            if isinstance(option, dict) and option.get("id") in texts and isinstance(option.get("text"), str):
                text = option["text"].strip()
                if text:
                    texts[option["id"]] = text
    except (llm.LlmError, ValueError, AttributeError) as exc:
        logger.warning("route explanations fell back to the template: %s", exc)
    return texts


# ---- the pipeline -------------------------------------------------------------


def observed_road_factor(routed: list[RoutedCandidate]) -> float:
    """How much longer the routed roads came out than the straight lines
    through their plans' points (the median, clamped to ROAD_FACTOR_RANGE),
    or ROAD_FACTOR when nothing was routed."""
    ratios = []
    for c in routed:
        straight = _path_m(list(c.plan.points)) * (2 if c.plan.mirrored else 1)
        if straight > 0:
            ratios.append(c.distance_m / straight)
    if not ratios:
        return ROAD_FACTOR
    ratios.sort()
    mid = len(ratios) // 2
    median = ratios[mid] if len(ratios) % 2 else (ratios[mid - 1] + ratios[mid]) / 2
    return min(max(median, ROAD_FACTOR_RANGE[0]), ROAD_FACTOR_RANGE[1])



@dataclass
class Outcome:
    infeasible: Infeasible | None = None
    # Best first, at most SHORTLIST.
    options: list[ScoredCandidate] = field(default_factory=list)
    explanations: dict[str, str] = field(default_factory=dict)
    # How many candidates were routed - BRouter calls made.
    routed: int = 0


def generate_routes(
    constraints: RouteConstraints,
    flat_speed_kmh: float = DEFAULT_FLAT_SPEED_KMH,
    vam_m_per_h: float = DEFAULT_VAM_M_PER_H,
    route: RouteFn = _default_route,
    passes_fn: Callable[[LatLon, float], list[KnownClimb]] = find_passes,
    water: WaterFn = _default_water,
    explain_fn: Callable[[list[ScoredCandidate], str], dict[str, str]] = explain,
) -> Outcome:
    """Constraints with no questions left -> the best few routes, explained.

    Two routing rounds. The first FIRST_ROUND candidates measure how much
    longer the roads are than straight lines here (observed_road_factor) and
    the start's elevation (which the relief check and the choice of passes
    need); the rest of MAX_CANDIDATES are planned with both. Raises
    routing.RoutingRateLimitedError when BRouter throttles us, and
    routing.RoutingError when no candidate at all could be routed.
    """
    if constraints.start is None or constraints.questions:
        raise ValueError("constraints still have questions to ask")
    infeasible = check_feasibility(constraints)
    if infeasible:
        return Outcome(infeasible=infeasible)

    start = (constraints.start.place.lat, constraints.start.place.lon)
    target_km = target_distance_km(constraints)
    options = routing_options(constraints)
    passes: list[KnownClimb] = []
    if constraints.parsed.climbs.categories:
        passes = passes_fn(start, (target_km or 60) * 1000 / (2 * ROAD_FACTOR_RANGE[0]))

    first = plan_candidates(constraints, target_km)[:FIRST_ROUND]
    routed = generate(first, options, route)
    calls = len(first)
    start_ele = next((e for c in routed for e in c.elevations[:1] if e is not None), None)
    if passes or constraints.parsed.climbs.categories:
        infeasible = check_feasibility(constraints, passes, start_ele)
        if infeasible:
            return Outcome(infeasible=infeasible, routed=calls)

    factor = observed_road_factor(routed)
    done = {c.plan.id for c in routed}
    rest = [p for p in plan_candidates(constraints, target_km, passes, start_ele, factor) if p.id not in done]
    budget = MAX_CANDIDATES - calls
    more = generate(rest, options, route, limit=budget)
    calls += min(len(rest), budget)
    for candidate in more:
        if not any(_is_duplicate(candidate, other) for other in routed):
            routed.append(candidate)
    if not routed:
        raise routing.RoutingError("None of the candidate routes could be routed.")

    shortest = min(c.distance_m for c in routed) / 1000
    scored: list[ScoredCandidate] = []
    for candidate in routed:
        metrics = measure(candidate, constraints, flat_speed_kmh, vam_m_per_h, water=None)
        total, misses = score(metrics, constraints, candidate.plan.kind, shortest)
        scored.append(ScoredCandidate(candidate, metrics, total, misses))
    scored.sort(key=lambda s: s.score)
    shortlist = scored[:SHORTLIST]
    for s in shortlist:
        s.metrics = dataclasses.replace(s.metrics, water_count=water(s.candidate.coords))
    language = constraints.parsed.language or "en"
    return Outcome(options=shortlist, explanations=explain_fn(shortlist, language), routed=calls)
