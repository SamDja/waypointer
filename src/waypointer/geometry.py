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


def point_to_segment_distance_m(p: LatLon, a: LatLon, b: LatLon) -> float:
    """Distance from point p to the segment a-b, in meters."""
    ref_lat = (p[0] + a[0] + b[0]) / 3
    px, py = _to_local_xy(p[0], p[1], ref_lat)
    ax, ay = _to_local_xy(a[0], a[1], ref_lat)
    bx, by = _to_local_xy(b[0], b[1], ref_lat)

    abx, aby = bx - ax, by - ay
    len_sq = abx * abx + aby * aby
    if len_sq == 0:
        return math.hypot(px - ax, py - ay)

    t = ((px - ax) * abx + (py - ay) * aby) / len_sq
    t = max(0.0, min(1.0, t))
    closest_x = ax + t * abx
    closest_y = ay + t * aby
    return math.hypot(px - closest_x, py - closest_y)


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
