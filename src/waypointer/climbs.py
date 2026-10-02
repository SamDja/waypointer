"""Climb detection, classification and route difficulty.

A port of frontend/src/lib/climbs.ts, which draws climbs on the elevation
profile; this one lets the route generator (route_candidates.py) measure and
rank candidates the same way. **Keep the two in step**: same constants, same
steps, same thresholds. tests/fixtures/climb_profile.json is a profile both
test suites check against the same expected climbs, so a change made on one
side only fails a test.
"""

from dataclasses import dataclass
from typing import Literal

from waypointer.geometry import LatLon, cumulative_distances_m

# The profile is resampled onto this fixed step before anything else, so the
# thresholds below mean the same thing on a dense GPS track and on a sparse
# routed one.
RESAMPLE_M = 25.0
# A moving average over this many samples (75m) irons out DEM steps.
SMOOTH_SAMPLES = 3
# A climb survives a dip below its highest point so far as long as the dip is
# no deeper than DIP_MIN_M (or DIP_FRACTION of its ascent so far, whichever is
# more, up to DIP_MAX_M)...
DIP_MIN_M = 10.0
DIP_FRACTION = 0.1
DIP_MAX_M = 40.0
# ...and the road gets back above that point within this distance.
MAX_FLAT_M = 1000.0
# Each end is trimmed while the stretch there is gentler than the minimum.
TRIM_WINDOW_M = 300.0
# The maximum gradient is the steepest average over this distance.
MAX_GRADE_WINDOW_M = 100.0

ClimbCategory = Literal["HC", "1", "2", "3", "4"]
# Strava's categories by score (length in m x average gradient in %).
CATEGORY_SCORES: tuple[tuple[ClimbCategory, float], ...] = (
    ("HC", 80_000),
    ("1", 64_000),
    ("2", 32_000),
    ("3", 16_000),
    ("4", 8_000),
)
CATEGORY_RANK: dict[str, int] = {"4": 1, "3": 2, "2": 3, "1": 4, "HC": 5}


@dataclass(frozen=True)
class ClimbRules:
    """What counts as a climb on an activity - MAP_STYLES' climbRules."""

    min_avg_grade_pct: float
    min_score: float | None = None
    min_ascent_m: float | None = None
    categorize: bool = True


@dataclass(frozen=True)
class DifficultyThresholds:
    """Where Moderate, Hard and Very hard start - MAP_STYLES' difficulty."""

    distance_km: tuple[float, float, float]
    ascent_m: tuple[float, float, float]
    max_grade_pct: tuple[float, float, float]
    climb_category: tuple[ClimbCategory, ClimbCategory, ClimbCategory] | None = None


# Hand mirrors of the road_cycling entry in frontend/src/lib/mapStyles.ts.
ROAD_CYCLING_CLIMBS = ClimbRules(min_avg_grade_pct=3, min_score=8000, categorize=True)
ROAD_CYCLING_DIFFICULTY = DifficultyThresholds(
    distance_km=(40, 80, 140),
    ascent_m=(500, 1200, 2200),
    max_grade_pct=(8, 12, 16),
    climb_category=("3", "1", "HC"),
)


@dataclass(frozen=True)
class Climb:
    start_m: float
    end_m: float
    # Into the route's own coordinates (nearest vertex).
    start_index: int
    end_index: int
    length_m: float
    ascent_m: float
    avg_grade_pct: float
    max_grade_pct: float
    summit_m: float
    score: float
    fiets: float
    category: ClimbCategory | None


@dataclass
class _Profile:
    distance_m: list[float]
    elevation: list[float]


def climb_category(score: float) -> ClimbCategory | None:
    for category, min_score in CATEGORY_SCORES:
        if score >= min_score:
            return category
    return None


def climb_category_label(category: ClimbCategory) -> str:
    return "HC" if category == "HC" else f"Cat {category}"


def fiets_index(ascent_m: float, length_m: float, summit_m: float) -> float:
    """H^2 / (D * 10) + (T - 1000) / 1000, the altitude term only above 1000m."""
    if length_m <= 0:
        return 0.0
    return (ascent_m * ascent_m) / (length_m * 10) + max(0.0, (summit_m - 1000) / 1000)


def _profiles(cumulative: list[float], elevations: list[float | None]) -> list[_Profile]:
    """One resampled, smoothed profile per stretch with elevation data."""
    out: list[_Profile] = []
    run_start = -1
    for i in range(len(cumulative) + 1):
        known = i < len(cumulative) and elevations[i] is not None
        if known and run_start < 0:
            run_start = i
        if not known and run_start >= 0:
            if i - run_start >= 2:
                out.append(_resample(cumulative, elevations, run_start, i - 1))  # type: ignore[arg-type]
            run_start = -1
    return [p for p in out if len(p.distance_m) >= 2]


def _resample(cumulative: list[float], elevations: list[float], start: int, to: int) -> _Profile:
    distance_m: list[float] = []
    raw: list[float] = []
    j = start
    end_m = cumulative[to]
    d = cumulative[start]
    while True:
        at = min(d, end_m)
        while j < to - 1 and cumulative[j + 1] < at:
            j += 1
        span = cumulative[j + 1] - cumulative[j]
        t = (at - cumulative[j]) / span if span > 0 else 0.0
        distance_m.append(at)
        raw.append(elevations[j] + (elevations[j + 1] - elevations[j]) * min(max(t, 0.0), 1.0))
        if at >= end_m:
            break
        d += RESAMPLE_M
    half = SMOOTH_SAMPLES // 2
    elevation = []
    for i in range(len(raw)):
        lo = max(0, i - half)
        hi = min(len(raw) - 1, i + half)
        elevation.append(sum(raw[lo : hi + 1]) / (hi - lo + 1))
    return _Profile(distance_m, elevation)


def _grade_pct(p: _Profile, a: int, b: int) -> float:
    run = p.distance_m[b] - p.distance_m[a]
    return (p.elevation[b] - p.elevation[a]) / run * 100 if run > 0 else 0.0


def _steepest(p: _Profile, a: int, b: int, window_m: float = MAX_GRADE_WINDOW_M) -> float:
    window = max(1, round(window_m / RESAMPLE_M))
    if b - a < window:
        return max(0.0, _grade_pct(p, a, b))
    best = 0.0
    for i in range(a, b - window + 1):
        best = max(best, _grade_pct(p, i, i + window))
    return best


def _candidates(p: _Profile) -> list[tuple[int, int]]:
    found: list[tuple[int, int]] = []
    e = p.elevation
    start = 0
    summit: int | None = None
    for i in range(1, len(e)):
        if summit is None:
            if e[i] < e[start]:
                start = i
            elif e[i] > e[start]:
                summit = i
            continue
        # Strictly higher: a level plateau is flat, not more climb.
        if e[i] > e[summit]:
            summit = i
            continue
        ascent = e[summit] - e[start]
        tolerance = max(DIP_MIN_M, min(DIP_MAX_M, ascent * DIP_FRACTION))
        if e[summit] - e[i] > tolerance or p.distance_m[i] - p.distance_m[summit] > MAX_FLAT_M:
            found.append((start, summit))
            # The next climb starts from the lowest point since this one's top.
            low = summit + 1
            for k in range(summit + 1, i + 1):
                if e[k] < e[low]:
                    low = k
            start = low
            summit = None
            for k in range(low + 1, i + 1):
                if e[k] > e[summit if summit is not None else start]:
                    summit = k
    if summit is not None:
        found.append((start, summit))
    return found


def _trim(p: _Profile, start: int, end: int, min_pct: float) -> tuple[int, int]:
    window = max(1, round(TRIM_WINDOW_M / RESAMPLE_M))
    while end - start > window and _grade_pct(p, start, start + window) < min_pct:
        start += 1
    while end - start > window and _grade_pct(p, end - window, end) < min_pct:
        end -= 1
    while end - start > 1 and _grade_pct(p, start, start + 1) < min_pct:
        start += 1
    while end - start > 1 and _grade_pct(p, end - 1, end) < min_pct:
        end -= 1
    return start, end


def _nearest_index(cumulative: list[float], distance_m: float) -> int:
    lo, hi = 0, len(cumulative) - 1
    while hi - lo > 1:
        mid = (lo + hi) >> 1
        if cumulative[mid] <= distance_m:
            lo = mid
        else:
            hi = mid
    return lo if distance_m - cumulative[lo] <= cumulative[hi] - distance_m else hi


def detect_climbs(
    coords: list[LatLon], elevations: list[float | None], rules: ClimbRules = ROAD_CYCLING_CLIMBS
) -> list[Climb]:
    """The climbs along a route, in ride order. elevations is index-parallel
    with coords; None where a point has no elevation."""
    cumulative = cumulative_distances_m(coords)
    climbs: list[Climb] = []
    for p in _profiles(cumulative, elevations):
        for raw_start, raw_end in _candidates(p):
            start, end = _trim(p, raw_start, raw_end, rules.min_avg_grade_pct)
            length_m = p.distance_m[end] - p.distance_m[start]
            ascent_m = p.elevation[end] - p.elevation[start]
            if length_m <= 0 or ascent_m <= 0:
                continue
            avg = ascent_m / length_m * 100
            score = length_m * avg
            if avg < rules.min_avg_grade_pct:
                continue
            if rules.min_score is not None and score < rules.min_score:
                continue
            if rules.min_ascent_m is not None and ascent_m < rules.min_ascent_m:
                continue
            summit_m = p.elevation[end]
            climbs.append(
                Climb(
                    start_m=p.distance_m[start],
                    end_m=p.distance_m[end],
                    start_index=_nearest_index(cumulative, p.distance_m[start]),
                    end_index=_nearest_index(cumulative, p.distance_m[end]),
                    length_m=length_m,
                    ascent_m=ascent_m,
                    avg_grade_pct=avg,
                    max_grade_pct=_steepest(p, start, end),
                    summit_m=summit_m,
                    score=score,
                    fiets=fiets_index(ascent_m, length_m, summit_m),
                    category=climb_category(score) if rules.categorize else None,
                )
            )
    return climbs


def route_max_grade_pct(
    coords: list[LatLon], elevations: list[float | None], window_m: float = MAX_GRADE_WINDOW_M
) -> float:
    """The steepest climbing gradient anywhere on the route, over window_m.

    window_m is a Python-only addition (climbs.ts always uses
    MAX_GRADE_WINDOW_M): the route generator's road-sanity check reads a
    longer window, since over 100m the DEM's noise at mountain hairpins
    already reads as 30%."""
    cumulative = cumulative_distances_m(coords)
    return max(
        (_steepest(p, 0, len(p.distance_m) - 1, window_m) for p in _profiles(cumulative, elevations)), default=0.0
    )


# ---- route difficulty -------------------------------------------------------

DIFFICULTY_LABELS = ("Easy", "Moderate", "Hard", "Very hard")


@dataclass(frozen=True)
class DifficultyCriterion:
    name: str
    value: str
    level: int
    label: str


@dataclass(frozen=True)
class Difficulty:
    level: int
    label: str
    # What made it this hard, e.g. "1,800 m of climbing"; None when Easy.
    reason: str | None
    # Every criterion, the deciding one first.
    criteria: tuple[DifficultyCriterion, ...]


def _level_for(value: float, starts: tuple[float, float, float]) -> int:
    return 3 if value >= starts[2] else 2 if value >= starts[1] else 1 if value >= starts[0] else 0


def hardest_category(climbs: list[Climb]) -> ClimbCategory | None:
    best: ClimbCategory | None = None
    for climb in climbs:
        if climb.category is None:
            continue
        if best is None or CATEGORY_RANK[climb.category] > CATEGORY_RANK[best]:
            best = climb.category
    return best


def route_difficulty(
    distance_m: float,
    gain_m: float,
    max_grade_pct: float,
    climbs: list[Climb],
    thresholds: DifficultyThresholds = ROAD_CYCLING_DIFFICULTY,
) -> Difficulty:
    """As hard as the hardest criterion - mirrors climbs.ts' routeDifficulty."""
    criteria: list[tuple[str, str, int, str]] = [
        ("Climbing", f"{round(gain_m):,} m", _level_for(gain_m, thresholds.ascent_m), f"{round(gain_m):,} m of climbing"),
        (
            "Distance",
            f"{distance_m / 1000:.0f} km",
            _level_for(distance_m / 1000, thresholds.distance_km),
            f"{distance_m / 1000:.0f} km long",
        ),
        (
            f"Steepest {MAX_GRADE_WINDOW_M:.0f} m",
            f"{round(max_grade_pct)}%",
            _level_for(max_grade_pct, thresholds.max_grade_pct),
            f"up to {round(max_grade_pct)}% steep",
        ),
    ]
    hardest = hardest_category(climbs)
    if thresholds.climb_category and hardest is not None:
        ranks = tuple(CATEGORY_RANK[c] for c in thresholds.climb_category)
        label = climb_category_label(hardest)
        criteria.insert(
            0,
            (
                "Hardest climb",
                label,
                _level_for(CATEGORY_RANK[hardest], ranks),  # type: ignore[arg-type]
                f"{'an' if hardest == 'HC' else 'a'} {label} climb",
            ),
        )
    # The first criterion reaching the highest level decides, as in climbs.ts.
    top = criteria[0]
    for c in criteria[1:]:
        if c[2] > top[2]:
            top = c
    ordered = [top, *(c for c in criteria if c is not top)]
    return Difficulty(
        level=top[2],
        label=DIFFICULTY_LABELS[top[2]],
        reason=top[3] if top[2] > 0 else None,
        criteria=tuple(DifficultyCriterion(n, v, lvl, DIFFICULTY_LABELS[lvl]) for n, v, lvl, _ in ordered),
    )
