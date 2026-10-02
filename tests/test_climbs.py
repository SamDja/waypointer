"""Mirrors frontend/src/lib/climbs.test.ts case for case, plus the shared
parity fixture both suites check (tests/fixtures/climb_profile.json)."""

import json
import math
from pathlib import Path

import pytest

from waypointer.climbs import (
    Climb,
    ClimbRules,
    DifficultyThresholds,
    climb_category,
    detect_climbs,
    fiets_index,
    route_difficulty,
    route_max_grade_pct,
)
from waypointer.geometry import cumulative_distances_m

CYCLING = ClimbRules(min_avg_grade_pct=3, min_score=8000, categorize=True)
HIKING = ClimbRules(min_avg_grade_pct=3, min_ascent_m=100, categorize=False)

M_PER_DEG_LAT = 111_195
PARITY_FIXTURE = Path(__file__).parent / "fixtures" / "climb_profile.json"


def route(length_m: float, elevation_at):
    """A straight route north along a meridian, one point every 10m."""
    coords, elevations = [], []
    d = 0
    while d <= length_m:
        coords.append((46 + d / M_PER_DEG_LAT, 11.0))
        elevations.append(elevation_at(d))
        d += 10
    return coords, elevations


def single_climb(length_m: float, pct: float, flat_m: float = 2000):
    return route(
        flat_m * 2 + length_m,
        lambda d: 500
        if d < flat_m
        else 500 + (d - flat_m) * pct / 100
        if d < flat_m + length_m
        else 500 + length_m * pct / 100,
    )


def test_finds_a_steady_climb():
    coords, elevations = single_climb(8000, 6)
    climbs = detect_climbs(coords, elevations, CYCLING)
    assert len(climbs) == 1
    climb = climbs[0]
    assert 7800 < climb.length_m < 8200
    assert 465 < climb.ascent_m < 485
    assert climb.avg_grade_pct == pytest.approx(6, abs=0.5)
    assert climb.max_grade_pct == pytest.approx(6, abs=0.5)
    # 8km x 6% = 48,000: Cat 2.
    assert climb.category == "2"
    assert 1900 < climb.start_m < 2100


def test_tolerates_a_short_dip():
    def elevation(d):
        if d < 2000:
            return 500
        if d < 5000:
            return 500 + (d - 2000) * 0.07
        if d < 5200:
            return 710 - (d - 5000) * 0.03
        if d < 8200:
            return 704 + (d - 5200) * 0.07
        return 914

    assert len(detect_climbs(*route(10_000, elevation), CYCLING)) == 1


def test_splits_two_climbs_separated_by_a_descent():
    def elevation(d):
        if d < 1000:
            return 500
        if d < 6000:
            return 500 + (d - 1000) * 0.06
        if d < 9000:
            return 800 - (d - 6000) * (200 / 3000)
        if d < 14_000:
            return 600 + (d - 9000) * 0.06
        return 900

    climbs = detect_climbs(*route(16_000, elevation), CYCLING)
    assert len(climbs) == 2
    assert climbs[0].end_m < climbs[1].start_m


def test_splits_a_climb_broken_by_a_long_flat():
    def elevation(d):
        if d < 1000:
            return 500
        if d < 5000:
            return 500 + (d - 1000) * 0.06
        if d < 7000:
            return 740
        if d < 11_000:
            return 740 + (d - 7000) * 0.06
        return 980

    assert len(detect_climbs(*route(12_000, elevation), CYCLING)) == 2


def test_finds_nothing_in_noise_on_the_flat():
    coords, elevations = route(10_000, lambda d: 500 + 3 * math.sin(d / 37) + 2 * math.cos(d / 11))
    assert detect_climbs(coords, elevations, CYCLING) == []


def test_ignores_a_long_drag_under_the_minimum():
    assert detect_climbs(*single_climb(10_000, 2), CYCLING) == []


def test_trims_a_false_flat_off_the_start():
    def elevation(d):
        if d < 3000:
            return 500 + d * 0.01
        if d < 7000:
            return 530 + (d - 3000) * 0.07
        return 810

    climb = detect_climbs(*route(10_000, elevation), CYCLING)[0]
    assert climb.start_m > 2800
    assert climb.avg_grade_pct > 6.5


def test_does_not_measure_across_missing_elevation():
    coords, elevations = single_climb(8000, 6)
    for i in range(550, 650):
        elevations[i] = None
    for climb in detect_climbs(coords, elevations, CYCLING):
        assert climb.end_m < 5600 or climb.start_m > 6400


def test_hiking_never_categorizes_and_keeps_climbs_by_ascent():
    climbs = detect_climbs(*single_climb(1000, 15), HIKING)
    assert len(climbs) == 1
    assert climbs[0].category is None
    assert detect_climbs(*single_climb(500, 10), HIKING) == []


def test_maps_climbs_back_to_route_vertices():
    climb = detect_climbs(*single_climb(8000, 6), CYCLING)[0]
    assert 190 < climb.start_index < 210
    assert climb.end_index > climb.start_index


def test_climb_category_follows_strava():
    assert climb_category(7_999) is None
    assert climb_category(8_000) == "4"
    assert climb_category(16_000) == "3"
    assert climb_category(32_000) == "2"
    assert climb_category(64_000) == "1"
    assert climb_category(79_999) == "1"
    assert climb_category(80_000) == "HC"


def test_fiets_index():
    assert fiets_index(1071, 13_800, 1850) == pytest.approx(9.16, abs=0.05)
    assert fiets_index(100, 1000, 600) == pytest.approx(1, abs=1e-5)


def test_route_max_grade_is_the_steepest_stretch():
    assert route_max_grade_pct(*single_climb(2000, 9)) == pytest.approx(9, abs=0.5)


CYCLING_DIFFICULTY = DifficultyThresholds(
    distance_km=(40, 80, 140), ascent_m=(500, 1200, 2200), max_grade_pct=(8, 12, 16), climb_category=("3", "1", "HC")
)


def climb_of(category) -> Climb:
    return Climb(0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, category)


def test_difficulty_easy():
    difficulty = route_difficulty(30_000, 200, 5, [], CYCLING_DIFFICULTY)
    assert difficulty.label == "Easy"
    assert difficulty.reason is None
    assert all(c.level == 0 for c in difficulty.criteria)


def test_difficulty_takes_the_hardest_criterion():
    difficulty = route_difficulty(60_000, 1800, 9, [], CYCLING_DIFFICULTY)
    assert difficulty.label == "Hard"
    assert difficulty.reason == "1,800 m of climbing"
    assert [(c.name, c.label) for c in difficulty.criteria] == [
        ("Climbing", "Hard"),
        ("Distance", "Moderate"),
        ("Steepest 100 m", "Moderate"),
    ]


def test_difficulty_counts_the_hardest_climb():
    difficulty = route_difficulty(30_000, 300, 5, [climb_of("4"), climb_of("HC")], CYCLING_DIFFICULTY)
    assert difficulty.label == "Very hard"
    assert difficulty.reason == "an HC climb"


def test_difficulty_ignores_categories_without_them():
    hiking = DifficultyThresholds(distance_km=(40, 80, 140), ascent_m=(500, 1200, 2200), max_grade_pct=(8, 12, 16))
    assert route_difficulty(1000, 0, 0, [climb_of("HC")], hiking).level == 0


def test_matches_the_shared_parity_fixture():
    """The same profile and expected climbs climbs.test.ts checks, so a change
    to either implementation alone fails one of the two suites."""
    fixture = json.loads(PARITY_FIXTURE.read_text())
    coords = [(46 + d / M_PER_DEG_LAT, 11.0) for d in fixture["distances_m"]]
    # Sanity: the fixture's spacing is what both sides rebuild.
    assert cumulative_distances_m(coords)[-1] > 0
    climbs = detect_climbs(coords, fixture["elevations"], CYCLING)
    got = [
        {
            "start_index": c.start_index,
            "end_index": c.end_index,
            "length_m": round(c.length_m, 1),
            "ascent_m": round(c.ascent_m, 1),
            "max_grade_pct": round(c.max_grade_pct, 2),
            "category": c.category,
        }
        for c in climbs
    ]
    assert got == fixture["expected_climbs"]
    assert round(route_max_grade_pct(coords, fixture["elevations"]), 2) == fixture["expected_max_grade_pct"]
