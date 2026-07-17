"""Distance and route-simplification helpers.

All functions operate on plain (lat, lon) tuples in degrees and return
distances in meters. Point-to-segment/polyline distance uses a local
equirectangular (flat-earth) projection around the points involved, which is
accurate to well under 1% error at the ~50-100m scale this app operates at.
"""

import math

EARTH_RADIUS_M = 6_371_000.0

LatLon = tuple[float, float]


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points, in meters."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def _to_local_xy(lat: float, lon: float, ref_lat: float) -> tuple[float, float]:
    x = math.radians(lon) * math.cos(math.radians(ref_lat)) * EARTH_RADIUS_M
    y = math.radians(lat) * EARTH_RADIUS_M
    return x, y


def _point_to_segment_projection(p: LatLon, a: LatLon, b: LatLon) -> tuple[float, float]:
    """Distance from p to segment a-b, and the fractional position t along
    a-b (clamped to [0, 1]) of the closest point - shared by
    point_to_segment_distance_m and project_onto_polyline_m, the latter
    needing t to compute cumulative distance along a polyline."""
    ref_lat = (p[0] + a[0] + b[0]) / 3
    px, py = _to_local_xy(p[0], p[1], ref_lat)
    ax, ay = _to_local_xy(a[0], a[1], ref_lat)
    bx, by = _to_local_xy(b[0], b[1], ref_lat)

    abx, aby = bx - ax, by - ay
    len_sq = abx * abx + aby * aby
    if len_sq == 0:
        return math.hypot(px - ax, py - ay), 0.0

    t = ((px - ax) * abx + (py - ay) * aby) / len_sq
    t = max(0.0, min(1.0, t))
    closest_x = ax + t * abx
    closest_y = ay + t * aby
    return math.hypot(px - closest_x, py - closest_y), t


def point_to_segment_distance_m(p: LatLon, a: LatLon, b: LatLon) -> float:
    """Distance from point p to the segment a-b, in meters."""
    return _point_to_segment_projection(p, a, b)[0]


def total_distance_m(coords: list[LatLon]) -> float:
    """Cumulative great-circle length of a polyline, in meters."""
    return sum(
        haversine_m(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
        for i in range(len(coords) - 1)
    )


def point_to_polyline_distance_m(p: LatLon, polyline: list[LatLon]) -> float:
    """Minimum distance from p to any segment of polyline, in meters."""
    if not polyline:
        raise ValueError("polyline must contain at least one point")
    if len(polyline) == 1:
        return haversine_m(p[0], p[1], polyline[0][0], polyline[0][1])
    return min(
        point_to_segment_distance_m(p, polyline[i], polyline[i + 1])
        for i in range(len(polyline) - 1)
    )


def project_onto_polyline_m(p: LatLon, polyline: list[LatLon]) -> tuple[float, float]:
    """Returns (distance_from_route_m, distance_from_start_m): p's
    perpendicular distance to the nearest segment of polyline, and the
    cumulative distance along polyline from its first point to that nearest
    projection. polyline must contain at least one point."""
    if not polyline:
        raise ValueError("polyline must contain at least one point")
    if len(polyline) == 1:
        return haversine_m(p[0], p[1], polyline[0][0], polyline[0][1]), 0.0

    best_distance_m = math.inf
    best_distance_from_start_m = 0.0
    cumulative_m = 0.0
    for i in range(len(polyline) - 1):
        a, b = polyline[i], polyline[i + 1]
        segment_len_m = haversine_m(a[0], a[1], b[0], b[1])
        distance_m, t = _point_to_segment_projection(p, a, b)
        if distance_m < best_distance_m:
            best_distance_m = distance_m
            best_distance_from_start_m = cumulative_m + t * segment_len_m
        cumulative_m += segment_len_m
    return best_distance_m, best_distance_from_start_m


def simplify_rdp(points: list[LatLon], tolerance_m: float = 8.0) -> list[LatLon]:
    """Ramer-Douglas-Peucker simplification, tolerance in meters.

    This is used ONLY to cap the number of coordinates sent to the Overpass
    API. The authoritative 50m accept/reject distance check must always run
    against the original, unsimplified route - using the simplified line for
    that decision would let real matches near cut corners slip through.
    """
    if len(points) < 3:
        return list(points)

    def _rdp(pts: list[LatLon]) -> list[LatLon]:
        if len(pts) < 3:
            return pts
        start, end = pts[0], pts[-1]
        max_dist = -1.0
        max_index = 0
        for i in range(1, len(pts) - 1):
            dist = point_to_segment_distance_m(pts[i], start, end)
            if dist > max_dist:
                max_dist = dist
                max_index = i
        if max_dist > tolerance_m:
            left = _rdp(pts[: max_index + 1])
            right = _rdp(pts[max_index:])
            return left[:-1] + right
        return [start, end]

    return _rdp(list(points))
