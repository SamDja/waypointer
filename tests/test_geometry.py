import random

import pytest

from waypointer.geometry import (
    build_polyline_index,
    haversine_m,
    point_to_polyline_distance_m,
    point_to_segment_distance_m,
    project_onto_polyline_indexed_m,
    project_onto_polyline_m,
    simplify_rdp,
    total_distance_m,
)


def test_haversine_known_city_pair():
    paris = (48.8566, 2.3522)
    london = (51.5074, -0.1278)
    dist = haversine_m(*paris, *london)
    assert 330_000 < dist < 360_000


def test_haversine_small_distance():
    dist = haversine_m(48.0, 2.0, 48.0009, 2.0)
    assert 95 < dist < 105


def test_point_to_segment_on_segment():
    a = (48.0, 2.0)
    b = (48.001, 2.0)
    midpoint = (48.0005, 2.0)
    assert point_to_segment_distance_m(midpoint, a, b) < 0.5


def test_point_to_segment_beyond_endpoint():
    a = (48.0, 2.0)
    b = (48.001, 2.0)
    beyond = (48.002, 2.0)
    dist_to_b = haversine_m(*beyond, *b)
    dist = point_to_segment_distance_m(beyond, a, b)
    assert abs(dist - dist_to_b) < 1.0


def test_point_to_segment_perpendicular():
    a = (48.0, 2.0)
    b = (48.0, 2.01)
    p = (48.0009, 2.005)
    dist = point_to_segment_distance_m(p, a, b)
    assert 90 < dist < 110


def test_point_to_polyline_takes_minimum():
    polyline = [(48.0, 2.0), (48.001, 2.0), (48.002, 2.0)]
    p = (48.0015, 2.0001)
    expected = min(
        point_to_segment_distance_m(p, polyline[i], polyline[i + 1])
        for i in range(len(polyline) - 1)
    )
    assert point_to_polyline_distance_m(p, polyline) == pytest.approx(expected)


def test_point_to_polyline_requires_points():
    with pytest.raises(ValueError):
        point_to_polyline_distance_m((48.0, 2.0), [])


def test_project_onto_polyline_returns_distance_and_position():
    polyline = [(48.0, 2.0), (48.001, 2.0), (48.002, 2.0)]
    seg0_len = haversine_m(*polyline[0], *polyline[1])
    seg1_len = haversine_m(*polyline[1], *polyline[2])
    p = (48.0015, 2.0)  # on the line, midway along the second segment
    distance_from_route_m, distance_from_start_m = project_onto_polyline_m(p, polyline)
    assert distance_from_route_m < 0.5
    assert distance_from_start_m == pytest.approx(seg0_len + 0.5 * seg1_len, rel=1e-3)


def test_project_onto_polyline_requires_points():
    with pytest.raises(ValueError):
        project_onto_polyline_m((48.0, 2.0), [])


def test_simplify_rdp_straight_line_collapses():
    points = [(48.0 + i * 0.0001, 2.0) for i in range(10)]
    simplified = simplify_rdp(points, tolerance_m=5.0)
    assert len(simplified) == 2
    assert simplified[0] == points[0]
    assert simplified[-1] == points[-1]


def test_simplify_rdp_keeps_corner():
    points = [
        (48.0, 2.0),
        (48.001, 2.0),
        (48.002, 2.0),
        (48.002, 2.001),
        (48.002, 2.002),
    ]
    simplified = simplify_rdp(points, tolerance_m=1.0)
    assert (48.002, 2.0) in simplified


def test_simplify_rdp_respects_tolerance():
    points = [(48.0 + i * 0.00005, 2.0 + (0.00002 if i % 2 else 0)) for i in range(20)]
    simplified = simplify_rdp(points, tolerance_m=8.0)
    for p in points:
        assert point_to_polyline_distance_m(p, simplified) <= 8.0 + 1e-6


def test_total_distance_sums_consecutive_segments():
    points = [(48.0, 2.0), (48.001, 2.0), (48.001, 2.001)]
    expected = haversine_m(*points[0], *points[1]) + haversine_m(*points[1], *points[2])
    assert total_distance_m(points) == pytest.approx(expected)


def test_total_distance_empty_or_single_point_is_zero():
    assert total_distance_m([]) == 0.0
    assert total_distance_m([(48.0, 2.0)]) == 0.0


def _make_synthetic_route(num_points: int = 300) -> list[tuple[float, float]]:
    """A zig-zagging route with corners, spanning a few km, deterministic."""
    rng = random.Random(1234)
    route = []
    lat, lon = 48.0, 2.0
    for i in range(num_points):
        lat += 0.00003 + rng.uniform(-0.00001, 0.00001)
        lon += (0.00004 if i % 7 < 3 else -0.00002) + rng.uniform(-0.00001, 0.00001)
        route.append((lat, lon))
    return route


def test_polyline_index_matches_naive_projection_on_fixture_route():
    route = _make_synthetic_route()
    index = build_polyline_index(route, cell_size_m=200.0)
    rng = random.Random(42)

    query_points = []
    # Points near the route.
    for p in route[::5]:
        query_points.append((p[0] + rng.uniform(-0.0002, 0.0002), p[1] + rng.uniform(-0.0002, 0.0002)))
    # Points on vertices/shared segment endpoints exactly.
    query_points.extend(route[::11])
    # Points far outside the cell size, in an empty region.
    query_points.append((49.5, 3.5))
    query_points.append((46.0, 0.0))

    for p in query_points:
        naive = project_onto_polyline_m(p, route)
        indexed = project_onto_polyline_indexed_m(p, index)
        assert indexed[0] == pytest.approx(naive[0], abs=1e-6)
        assert indexed[1] == pytest.approx(naive[1], abs=1e-6)


def test_polyline_index_handles_query_far_outside_cell_size():
    route = _make_synthetic_route(50)
    # A large cell size relative to the route's own span, and a query point
    # geographically far from every segment, exercises the ring-expansion
    # safety-valve path rather than an early single-ring hit.
    index = build_polyline_index(route, cell_size_m=5.0)
    p = (60.0, 20.0)
    naive = project_onto_polyline_m(p, route)
    indexed = project_onto_polyline_indexed_m(p, index)
    assert indexed[0] == pytest.approx(naive[0], abs=1e-6)
    assert indexed[1] == pytest.approx(naive[1], abs=1e-6)


def test_polyline_index_single_point_route():
    route = [(48.0, 2.0)]
    index = build_polyline_index(route)
    p = (48.001, 2.001)
    naive = project_onto_polyline_m(p, route)
    indexed = project_onto_polyline_indexed_m(p, index)
    assert indexed == naive


def test_polyline_index_two_point_route():
    route = [(48.0, 2.0), (48.001, 2.0005)]
    index = build_polyline_index(route)
    p = (48.0005, 2.0002)
    naive = project_onto_polyline_m(p, route)
    indexed = project_onto_polyline_indexed_m(p, index)
    assert indexed[0] == pytest.approx(naive[0], abs=1e-6)
    assert indexed[1] == pytest.approx(naive[1], abs=1e-6)


def test_polyline_index_requires_points():
    with pytest.raises(ValueError):
        build_polyline_index([])
