"""Route candidates (route_candidates.py): planning, routing, metrics, scoring
and explanations. BRouter is replaced by a fake that draws straight lines
through the via points over a synthetic mountain, so the real metrics,
climb detection and scoring run on every candidate; nothing here reaches the
network or the POI database."""

import math

import pytest

from waypointer import llm, route_candidates, routing
from waypointer.route_candidates import (
    KnownClimb,
    Plan,
    check_feasibility,
    destination,
    estimate_duration_h,
    generate,
    generate_routes,
    measure,
    plan_candidates,
    repeated_share,
    route_plan,
    score,
    target_distance_km,
)
from waypointer.geometry import haversine_m
from waypointer.route_request import ParsedRequest, PlaceOption, Range, ResolvedPlace, RouteConstraints

START = (46.05, 11.45)  # Borgo Valsugana-ish
MOUNTAIN = (46.17, 11.44)  # Passo Manghen-ish


def _parsed(**overrides) -> ParsedRequest:
    base = {
        "out_of_scope": False,
        "language": "it",
        "sport": "road",
        "route_type": "loop",
        "start": "Borgo",
        "end": None,
        "via": [],
        "distance_km": {"min": 80, "max": 80},
        "ascent_m": None,
        "duration_h": None,
        "max_gradient_pct": None,
        "difficulty": None,
        "climbs": {"categories": [], "named": []},
        "avoid": {"places": [], "road_types": [], "surfaces": []},
        "missing": [],
    }
    return ParsedRequest.model_validate({**base, **overrides})


def _resolved(name: str, point) -> ResolvedPlace:
    return ResolvedPlace(query=name, place=PlaceOption(name=name, context="", lat=point[0], lon=point[1]))


def _constraints(parsed: ParsedRequest | None = None, **fields) -> RouteConstraints:
    parsed = parsed or _parsed()
    values = {
        "parsed": parsed,
        "start": _resolved("Borgo", START),
        "end": None,
        "via": [],
        "climbs": [],
        "avoid": [],
        "distance_km": parsed.distance_km,
        "questions": [],
    }
    values.update(fields)
    return RouteConstraints(**values)


def _elevation(p) -> float:
    """A mountain 1,600m above a 400m valley, about 6km across."""
    d = haversine_m(p[0], p[1], *MOUNTAIN)
    return 400 + 1600 * math.exp(-((d / 6000) ** 2))


def _densify(points, step_m=50.0):
    out = [points[0]]
    for a, b in zip(points, points[1:]):
        n = max(1, int(haversine_m(*a, *b) // step_m))
        out += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(1, n + 1)]
    return out


class FakeRouter:
    """Straight lines through the points, elevation from _elevation. Each
    alternative bends the route slightly, so alternatives differ."""

    def __init__(self, fail_ids=(), rate_limit=False):
        self.calls = []
        self.fail_points = set()
        self.rate_limit = rate_limit

    def __call__(self, points, profile, options, alternative):
        self.calls.append((tuple(points), profile, dict(options or {}), alternative))
        if self.rate_limit:
            raise routing.RoutingRateLimitedError("429")
        if tuple(points) in self.fail_points:
            raise routing.RoutingError("no route")
        pts = list(points)
        if alternative:
            a, b = pts[0], pts[1]
            mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            pts.insert(1, destination(mid, 90, 1500 * alternative))
        coords = _densify(pts)
        length = sum(haversine_m(*coords[i], *coords[i + 1]) for i in range(len(coords) - 1))
        return routing.RoutedLeg(
            coords=coords,
            elevations=[_elevation(p) for p in coords],
            distance_m=length,
            surface=(routing.SurfaceRun("paved", length * 0.9), routing.SurfaceRun("unpaved", length * 0.1)),
            cycleway_m=0.0,
        )


def _path_km(points) -> float:
    return sum(haversine_m(*points[i], *points[i + 1]) for i in range(len(points) - 1)) / 1000


# ---- sizing and planning ------------------------------------------------------


def test_target_distance_is_the_middle_of_the_range():
    assert target_distance_km(_constraints(_parsed(distance_km={"min": 60, "max": 80}))) == 70


def test_target_distance_from_ascent_or_difficulty():
    by_ascent = _parsed(distance_km=None, ascent_m={"min": 1500, "max": None})
    assert target_distance_km(_constraints(by_ascent)) == pytest.approx(100)
    by_difficulty = _parsed(distance_km=None, difficulty="easy")
    assert target_distance_km(_constraints(by_difficulty)) == 30


def test_an_unsized_a_to_b_has_no_target():
    parsed = _parsed(route_type="a_to_b", end="Trento", distance_km=None)
    assert target_distance_km(_constraints(parsed)) is None


def test_loops_start_and_end_at_the_start_and_are_sized_to_the_target():
    plans = plan_candidates(_constraints(), 80)
    assert plans
    for plan in plans:
        assert plan.kind == "loop"
        assert plan.points[0] == START and plan.points[-1] == START
    # Straight lines times the road factor land near the target.
    plain = [p for p in plans if p.id.startswith("loop-0-4")]
    assert _path_km(plain[0].points) * route_candidates.ROAD_FACTOR == pytest.approx(80, rel=0.25)


def test_loops_through_a_named_climb_all_go_over_it():
    constraints = _constraints(_parsed(climbs={"categories": [], "named": ["Passo Manghen"]}), climbs=[_resolved("Passo Manghen", MOUNTAIN)])
    plans = plan_candidates(constraints, 80)
    required = [p for p in plans if p.id.startswith("loop-req")]
    assert required
    assert all(MOUNTAIN in p.points for p in required)
    # And, in case no loop goes there on roads, there and back over it.
    fallback = [p for p in plans if p.id == "loop-as-oab"]
    assert fallback and fallback[0].mirrored and fallback[0].points[:2] == (START, MOUNTAIN)
    # The pass is ~13km out and 80km wants ~31km out: on over the top.
    beyond = fallback[0].points[2]
    assert haversine_m(*START, *beyond) / 1000 * 2 * route_candidates.ROAD_FACTOR == pytest.approx(80, rel=0.1)


def test_sizes_that_collapse_to_one_plan_are_planned_once():
    # 13km out, a 40km loop can't get smaller than the circle reaching it.
    constraints = _constraints(climbs=[_resolved("Passo Manghen", MOUNTAIN)])
    plans = plan_candidates(constraints, 40)
    keys = [(p.points, p.alternative) for p in plans]
    assert len(keys) == len(set(keys))
    assert sum(p.id.startswith("loop-req") for p in plans) < 8


def test_a_to_b_plans_direct_alternatives_and_detours():
    end = destination(START, 45, 30_000)
    parsed = _parsed(route_type="a_to_b", end="Trento", distance_km={"min": 70, "max": 80})
    plans = plan_candidates(_constraints(parsed, end=_resolved("Trento", end)), 75)
    direct = [p for p in plans if p.id.startswith("ab-direct")]
    assert [p.alternative for p in direct] == [0, 1, 2, 3]
    assert all(p.points == (START, end) for p in direct)
    detours = [p for p in plans if p.id.startswith("ab-detour")]
    assert len(detours) == 4
    assert all(p.points[0] == START and p.points[-1] == end for p in detours)


def test_out_and_back_turns_round_at_half_the_distance():
    plans = plan_candidates(_constraints(_parsed(route_type="out_and_back")), 80)
    assert plans and all(p.mirrored and len(p.points) == 2 for p in plans)
    reach = haversine_m(*plans[0].points[0], *plans[0].points[1]) / 1000
    assert reach * 2 * route_candidates.ROAD_FACTOR == pytest.approx(80, rel=0.05)


def test_generated_points_near_a_place_to_avoid_are_dropped():
    avoid = destination(START, 0, 2 * 80_000 / (2 * math.pi * route_candidates.ROAD_FACTOR))
    without = plan_candidates(_constraints(), 80)
    with_avoid = plan_candidates(_constraints(avoid=[_resolved("Somewhere", avoid)]), 80)
    assert 0 < len(with_avoid) < len(without)
    for plan in with_avoid:
        assert all(haversine_m(*p, *avoid) >= route_candidates.AVOID_RADIUS_M for p in plan.points)


def test_category_wishes_seed_loops_with_known_passes():
    passes = [KnownClimb("Passo Manghen", MOUNTAIN, 2047), KnownClimb("Too far", (47.5, 11.4), 2500)]
    constraints = _constraints(_parsed(climbs={"categories": ["1"], "named": []}))
    plans = plan_candidates(constraints, 80, passes, start_ele_m=400)
    seeded = [p for p in plans if p.seeded_with]
    assert seeded and all(p.seeded_with == ("Passo Manghen",) for p in seeded)
    assert all(MOUNTAIN in p.points for p in seeded)


def test_main_roads_and_ferries_become_routing_options():
    constraints = _constraints(_parsed(avoid={"places": [], "road_types": ["main_roads", "ferries"], "surfaces": []}))
    options = route_candidates.routing_options(constraints)
    assert options == {"allow_ferries": False, "consider_traffic": 1.0}
    # And they're valid for the profile.
    routing.resolve_options(route_candidates.ROUTING_PROFILE, options)


# ---- snapping to villages ----------------------------------------------------------


def test_only_generated_points_are_snapped():
    constraints = _constraints(climbs=[_resolved("Passo Manghen", MOUNTAIN)])
    plans = plan_candidates(constraints, 80)
    village = (46.0, 11.0)
    snapped = route_candidates.snap_plans(plans, lambda p: village)
    for before, after in zip(plans, snapped):
        assert before.generated, before.id
        for i, (b, a) in enumerate(zip(before.points, after.points)):
            if i in before.generated:
                assert a == village
            else:
                # The start and the named climb never move.
                assert a == b and b in (START, MOUNTAIN)


def test_a_point_with_no_village_near_stays_and_avoided_villages_are_refused():
    plan = Plan("p", "loop", (START, (46.2, 11.5), (46.1, 11.7), START), generated=(1, 2))
    avoid_here = (46.3, 11.5)
    snapped = route_candidates.snap_plans(
        [plan], lambda p: avoid_here if p == (46.2, 11.5) else None, avoid=[avoid_here]
    )[0]
    assert snapped.points == plan.points


def test_snapping_asks_once_per_point():
    asked = []
    plans = plan_candidates(_constraints(), 80)
    route_candidates.snap_plans(plans, lambda p: asked.append(p) or None)
    assert len(asked) == len(set(asked))


def test_the_pipeline_routes_through_the_snapped_villages():
    router = FakeRouter()
    village = destination(START, 45, 9000)
    generate_routes(
        _constraints(),
        route=router,
        passes_fn=lambda s, r: [],
        snap=lambda p: village,
        water=lambda c: None,
        explain_fn=lambda s, l: {},
    )
    assert router.calls and all(points[1] == village for points, *_ in router.calls)


# ---- routing --------------------------------------------------------------------


def test_out_and_back_is_routed_once_and_mirrored():
    router = FakeRouter()
    turn = destination(START, 0, 10_000)
    candidate = route_plan(Plan("oab", "out_and_back", (START, turn), mirrored=True), {}, router)
    assert len(router.calls) == 1
    assert candidate.coords[0] == candidate.coords[-1] == START
    assert candidate.distance_m == pytest.approx(20_000, rel=0.01)
    assert candidate.elevations == candidate.elevations[::-1]


def test_generate_drops_duplicates_and_unroutable_plans():
    router = FakeRouter()
    a = destination(START, 0, 20_000)
    b = destination(START, 90, 20_000)
    router.fail_points.add((START, b, START))
    plans = [
        Plan("one", "loop", (START, a, START)),
        Plan("same", "loop", (START, a, START)),
        Plan("broken", "loop", (START, b, START)),
    ]
    routed = generate(plans, {}, router)
    assert [c.plan.id for c in routed] == ["one"]
    assert len(router.calls) == 3


def test_generate_caps_the_routing_calls():
    router = FakeRouter()
    plans = plan_candidates(_constraints(), 80)
    assert len(plans) > route_candidates.MAX_CANDIDATES
    generate(plans, {}, router)
    assert len(router.calls) == route_candidates.MAX_CANDIDATES


def test_being_rate_limited_stops_generation():
    with pytest.raises(routing.RoutingRateLimitedError):
        generate([Plan("one", "loop", (START, destination(START, 0, 9000), START))], {}, FakeRouter(rate_limit=True))


# ---- metrics --------------------------------------------------------------------


def test_repeated_share_tells_a_loop_from_an_out_and_back():
    turn = destination(START, 0, 10_000)
    there_and_back = _densify([START, turn, START])
    assert repeated_share(there_and_back) == pytest.approx(0.5, abs=0.05)
    square = _densify([START, destination(START, 0, 5000), destination(destination(START, 0, 5000), 90, 5000), destination(START, 90, 5000), START])
    assert repeated_share(square) < 0.02


def test_measure_finds_the_climb_over_the_mountain():
    constraints = _constraints(climbs=[_resolved("Passo Manghen", MOUNTAIN)])
    candidate = route_plan(Plan("oab", "out_and_back", (START, MOUNTAIN), mirrored=True), {}, FakeRouter())
    metrics = measure(candidate, constraints, water=lambda coords: 4)
    assert metrics.named_climbs_passed == ["Passo Manghen"]
    assert metrics.ascent_m > 1400
    assert metrics.climbs and metrics.climbs[0].category in ("HC", "1")
    assert metrics.surface_share["unpaved"] == pytest.approx(0.1)
    assert metrics.water_count == 4
    # Out-and-backs repeat by design, so they aren't measured for it.
    assert metrics.repeated_share == 0
    assert metrics.duration_h == pytest.approx(estimate_duration_h(metrics.distance_km * 1000, metrics.ascent_m))


def test_the_road_factor_is_measured_from_what_was_routed():
    plan = Plan("p", "loop", (START, destination(START, 0, 10_000), START))

    def routed(distance_m, mirrored=False):
        candidate = route_plan(plan, {}, FakeRouter())
        candidate.distance_m = distance_m
        return candidate

    # 20km of straight line routed as 30, 34 and 40km: the median, 1.7.
    assert route_candidates.observed_road_factor([routed(30_000), routed(34_000), routed(40_000)]) == pytest.approx(1.7)
    assert route_candidates.observed_road_factor([]) == route_candidates.ROAD_FACTOR
    assert route_candidates.observed_road_factor([routed(200_000)]) == route_candidates.ROAD_FACTOR_RANGE[1]


def test_plans_resized_for_a_measured_factor_are_new_candidates():
    plain = plan_candidates(_constraints(), 80)
    winding = plan_candidates(_constraints(), 80, road_factor=1.8)
    assert {p.id for p in plain}.isdisjoint(p.id for p in winding)
    # Windier roads, smaller circle.
    assert _path_km(winding[0].points) < _path_km(plain[0].points)


def test_duration_is_flat_time_plus_climbing_time():
    assert estimate_duration_h(50_000, 700) == pytest.approx(50 / 25 + 1)
    assert estimate_duration_h(50_000, 800, flat_speed_kmh=20, vam_m_per_h=800) == pytest.approx(3.5)


# ---- scoring --------------------------------------------------------------------


def _metrics(**overrides):
    base = dict(
        distance_km=80,
        ascent_m=1000,
        descent_m=1000,
        max_grade_pct=8,
        steepest_road_pct=6,
        climbs=[],
        difficulty="Moderate",
        difficulty_level=1,
        difficulty_reason=None,
        duration_h=4,
        surface_share={"paved": 1.0, "cobbles": 0.0, "unpaved": 0.0, "unknown": 0.0},
        cycleway_share=0,
        water_count=None,
        repeated_share=0.0,
        named_climbs_passed=[],
    )
    base.update(overrides)
    return route_candidates.Metrics(**base)


def test_a_candidate_inside_every_range_misses_nothing():
    total, misses = score(_metrics(distance_km=81), _constraints(_parsed(distance_km={"min": 75, "max": 85})), "loop")
    assert total == 0 and misses == []


def test_further_from_the_distance_scores_worse():
    constraints = _constraints()
    near, _ = score(_metrics(distance_km=84), constraints, "loop")
    far, misses = score(_metrics(distance_km=100), constraints, "loop")
    assert 0 < near < far
    assert misses[0].constraint == "distance" and misses[0].got == "100 km"


def test_missing_a_named_climb_is_named():
    constraints = _constraints(climbs=[_resolved("Passo Manghen", MOUNTAIN)])
    _, misses = score(_metrics(), constraints, "loop")
    assert [m.constraint for m in misses] == ["named_climbs"]
    assert "Passo Manghen" in misses[0].got


def test_each_wanted_category_needs_its_own_climb():
    summary = route_candidates.ClimbSummary(0, 8, 400, 5, 8, 1200, "2")
    constraints = _constraints(_parsed(climbs={"categories": ["2", "2"], "named": []}))
    one, misses = score(_metrics(climbs=[summary]), constraints, "loop")
    two, _ = score(_metrics(climbs=[summary, summary]), constraints, "loop")
    assert two == 0 < one
    assert misses[0].constraint == "climb_categories"


def test_a_road_too_steep_to_ride_costs_even_unasked():
    total, misses = score(_metrics(steepest_road_pct=28), _constraints(), "loop")
    assert total > 0 and misses[0].constraint == "road_gradient" and misses[0].got == "28%"
    # Over 100m, hairpins in the DEM read steep on any mountain road: only the
    # longer window counts.
    assert score(_metrics(max_grade_pct=30, steepest_road_pct=12), _constraints(), "loop")[0] == 0


def test_another_shape_than_asked_is_a_relaxed_constraint():
    total, misses = score(_metrics(), _constraints(), "out_and_back")
    assert total > 0 and (misses[0].constraint, misses[0].wanted, misses[0].got) == ("route_shape", "loop", "out and back")


def test_loops_are_penalised_for_riding_roads_twice():
    oab = _constraints(_parsed(route_type="out_and_back"))
    a, _ = score(_metrics(repeated_share=0.4), _constraints(), "loop")
    b, _ = score(_metrics(repeated_share=0.4), oab, "out_and_back")
    assert a > 0 == b


def test_avoided_surfaces_cost():
    constraints = _constraints(_parsed(avoid={"places": [], "road_types": [], "surfaces": ["unpaved"]}))
    gravel = _metrics(surface_share={"paved": 0.8, "cobbles": 0.0, "unpaved": 0.2, "unknown": 0.0})
    total, misses = score(gravel, constraints, "loop")
    assert total > 0 and misses[0].got == "20% unpaved"


# ---- feasibility ------------------------------------------------------------------


def test_too_much_climbing_per_km_is_infeasible():
    parsed = _parsed(distance_km={"min": 20, "max": 30}, ascent_m={"min": 2000, "max": None})
    verdict = check_feasibility(_constraints(parsed))
    assert verdict is not None and verdict.reason == "ascent_per_km"
    assert verdict.suggested_distance_km.min == math.ceil(2000 / route_candidates.MAX_ASCENT_M_PER_KM)


def test_too_short_is_infeasible():
    verdict = check_feasibility(_constraints(_parsed(distance_km={"min": 2, "max": 3})))
    assert verdict is not None and verdict.reason == "distance"


def test_a_big_climb_needs_a_high_enough_pass():
    constraints = _constraints(_parsed(climbs={"categories": ["HC"], "named": []}))
    low = [KnownClimb("Low pass", MOUNTAIN, 700)]
    verdict = check_feasibility(constraints, low, start_ele_m=400)
    assert verdict is not None and verdict.reason == "climb_relief"
    # 300m of relief is 80% of a Cat 2 (320m), the hardest it allows.
    assert verdict.suggested_climb_categories == ["2"]
    high = [KnownClimb("Manghen", MOUNTAIN, 2047)]
    assert check_feasibility(constraints, high, start_ele_m=400) is None


def test_a_reasonable_request_is_feasible():
    assert check_feasibility(_constraints()) is None


# ---- explanations ------------------------------------------------------------------


def _scored(plan_id="loop-1"):
    candidate = route_plan(Plan(plan_id, "loop", (START, destination(START, 0, 9000), START)), {}, FakeRouter())
    return route_candidates.ScoredCandidate(candidate, _metrics(), 0.0, [])


def test_explanations_use_the_llm_text(monkeypatch):
    seen = {}

    def fake(system, user, schema, name, model_spec, session=None, temperature=0.0):
        seen["user"] = user
        return llm.LlmResult('{"options": [{"id": "loop-1", "text": "Un bel giro."}]}', "m", "p", 0.1, 1, 1, None)

    monkeypatch.setattr(llm, "complete_json", fake)
    texts = route_candidates.explain([_scored()], "it")
    assert texts == {"loop-1": "Un bel giro."}
    # Only computed facts go in: the metrics, never the request text.
    assert '"distance_km": 80' in seen["user"] and "Borgo" not in seen["user"]


def test_explanations_fall_back_to_the_template(monkeypatch):
    def broken(*args, **kwargs):
        raise llm.LlmError("down")

    monkeypatch.setattr(llm, "complete_json", broken)
    texts = route_candidates.explain([_scored()], "it")
    assert texts["loop-1"].startswith("80 km with 1,000 m of climbing")


# ---- the whole pipeline ------------------------------------------------------------


def test_generate_routes_ranks_the_named_climb_first():
    router = FakeRouter()
    constraints = _constraints(
        _parsed(distance_km={"min": 50, "max": 90}, climbs={"categories": [], "named": ["Passo Manghen"]}),
        climbs=[_resolved("Passo Manghen", MOUNTAIN)],
    )
    outcome = generate_routes(
        constraints,
        route=router,
        passes_fn=lambda start, radius: [],
        snap=None,
        water=lambda coords: 2,
        explain_fn=lambda shortlist, language: {s.candidate.plan.id: "ok" for s in shortlist},
    )
    assert outcome.infeasible is None
    assert 1 <= len(outcome.options) <= route_candidates.SHORTLIST
    assert outcome.routed == len(router.calls) <= route_candidates.MAX_CANDIDATES
    best = outcome.options[0]
    assert best.metrics.named_climbs_passed == ["Passo Manghen"]
    assert [o.score for o in outcome.options] == sorted(o.score for o in outcome.options)
    # Water is only looked up for the shortlist.
    assert all(o.metrics.water_count == 2 for o in outcome.options)
    assert set(outcome.explanations) == {o.candidate.plan.id for o in outcome.options}


def test_generate_routes_with_categories_learns_the_start_elevation_first():
    router = FakeRouter()
    asked = []

    def passes(start, radius):
        asked.append(radius)
        return [KnownClimb("Passo Manghen", MOUNTAIN, 2047)]

    constraints = _constraints(_parsed(distance_km={"min": 60, "max": 90}, climbs={"categories": ["1"], "named": []}))
    outcome = generate_routes(constraints, route=router, passes_fn=passes, snap=None, water=lambda c: None, explain_fn=lambda s, l: {})
    assert asked
    assert outcome.routed == len(router.calls) <= route_candidates.MAX_CANDIDATES
    assert any(o.candidate.plan.seeded_with for o in outcome.options)


def test_generate_routes_stops_at_an_infeasible_request():
    router = FakeRouter()
    parsed = _parsed(distance_km={"min": 20, "max": 30}, ascent_m={"min": 2000, "max": None})
    outcome = generate_routes(_constraints(parsed), route=router, passes_fn=lambda s, r: [], snap=None, explain_fn=lambda s, l: {})
    assert outcome.infeasible is not None and router.calls == []


def test_generate_routes_refuses_constraints_with_questions():
    from waypointer.route_request import Question

    with pytest.raises(ValueError):
        generate_routes(_constraints(questions=[Question(kind="missing", field="start", detail=None, options=[])]))


def test_range_helper_scales_by_width():
    assert route_candidates._range_miss(90, Range(min=70, max=80)) == pytest.approx(1.0)
    assert route_candidates._range_miss(75, Range(min=70, max=80)) == 0
    assert route_candidates._range_miss(88, Range(min=80, max=80)) == pytest.approx(1.0)
