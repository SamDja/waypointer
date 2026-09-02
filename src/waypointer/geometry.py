"""Distance and route-simplification helpers.

All functions operate on plain (lat, lon) tuples in degrees and return
distances in meters. Point-to-segment/polyline distance uses a local
equirectangular (flat-earth) projection around the points involved, which is
accurate to well under 1% error at the ~50-100m scale this app operates at.
"""

import math
from dataclasses import dataclass

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


@dataclass(frozen=True)
class PolylineIndex:
    """Grid spatial index over a polyline, built once per route so
    project_onto_polyline_indexed_m doesn't have to linearly scan every
    segment for every query point. See project_onto_polyline_indexed_m for
    the correctness argument."""

    polyline: list[LatLon]
    cell_size_m: float
    ref_lat: float
    cells: dict[tuple[int, int], list[int]]
    # cumulative_m[i] = distance along polyline from point 0 to point i.
    cumulative_m: list[float]
    # Upper bound on how many rings a query could ever need to expand
    # through before hitting the safety-valve fallback below.
    max_ring_radius: int


def build_polyline_index(polyline: list[LatLon], cell_size_m: float = 250.0) -> PolylineIndex:
    """Builds a PolylineIndex over polyline (intended to be the
    full-resolution route). cell_size_m only affects query speed, never
    correctness - project_onto_polyline_indexed_m always returns the exact
    same result as project_onto_polyline_m regardless of cell size."""
    if not polyline:
        raise ValueError("polyline must contain at least one point")

    ref_lat = polyline[0][0]
    xs: list[float] = []
    ys: list[float] = []
    cumulative_m = [0.0] * len(polyline)
    for i, (lat, lon) in enumerate(polyline):
        x, y = _to_local_xy(lat, lon, ref_lat)
        xs.append(x)
        ys.append(y)
        if i > 0:
            cumulative_m[i] = cumulative_m[i - 1] + haversine_m(
                polyline[i - 1][0], polyline[i - 1][1], lat, lon
            )

    cells: dict[tuple[int, int], list[int]] = {}
    for i in range(len(polyline) - 1):
        min_x, max_x = sorted((xs[i], xs[i + 1]))
        min_y, max_y = sorted((ys[i], ys[i + 1]))
        cx0, cx1 = math.floor(min_x / cell_size_m), math.floor(max_x / cell_size_m)
        cy0, cy1 = math.floor(min_y / cell_size_m), math.floor(max_y / cell_size_m)
        for cx in range(cx0, cx1 + 1):
            for cy in range(cy0, cy1 + 1):
                cells.setdefault((cx, cy), []).append(i)

    if xs:
        span_x = (max(xs) - min(xs)) / cell_size_m
        span_y = (max(ys) - min(ys)) / cell_size_m
        max_ring_radius = int(math.ceil(max(span_x, span_y))) + 2
    else:
        max_ring_radius = 2

    return PolylineIndex(
        polyline=polyline,
        cell_size_m=cell_size_m,
        ref_lat=ref_lat,
        cells=cells,
        cumulative_m=cumulative_m,
        max_ring_radius=max_ring_radius,
    )


def project_onto_polyline_indexed_m(p: LatLon, index: PolylineIndex) -> tuple[float, float]:
    """Same contract and return value as project_onto_polyline_m(p,
    index.polyline), just faster: uses index's grid to only examine
    segments near p instead of scanning the whole polyline.

    Correctness argument: cells are searched outward in expanding square
    rings from p's own cell. After each ring is checked, if the best
    distance found so far is already <= (ring radius) * cell_size_m, no
    unchecked cell (which is at least (ring radius) * cell_size_m away, in
    the worst case where p sits at its cell's edge) can possibly contain a
    closer segment, so the search stops. This is exact, not approximate.
    """
    polyline = index.polyline
    if len(polyline) == 1:
        return haversine_m(p[0], p[1], polyline[0][0], polyline[0][1]), 0.0

    px, py = _to_local_xy(p[0], p[1], index.ref_lat)
    cx = math.floor(px / index.cell_size_m)
    cy = math.floor(py / index.cell_size_m)

    def _consider(i: int) -> tuple[float, float] | None:
        a, b = polyline[i], polyline[i + 1]
        distance_m, t = _point_to_segment_projection(p, a, b)
        segment_len_m = index.cumulative_m[i + 1] - index.cumulative_m[i]
        return distance_m, index.cumulative_m[i] + t * segment_len_m

    checked_segments: set[int] = set()
    best_distance_m = math.inf
    best_distance_from_start_m = 0.0
    radius = 0
    while True:
        ring_segments: set[int] = set()
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                if max(abs(dx), abs(dy)) != radius:
                    continue
                segs = index.cells.get((cx + dx, cy + dy))
                if segs:
                    ring_segments.update(segs)
        for i in ring_segments - checked_segments:
            distance_m, distance_from_start_m = _consider(i)
            if distance_m < best_distance_m:
                best_distance_m = distance_m
                best_distance_from_start_m = distance_from_start_m
        checked_segments |= ring_segments

        if best_distance_m <= radius * index.cell_size_m:
            return best_distance_m, best_distance_from_start_m

        radius += 1
        if radius > index.max_ring_radius:
            # Safety valve - shouldn't trigger given max_ring_radius is
            # derived from the route's own bounding box, but fall back to a
            # full scan of whatever segments haven't been checked yet
            # rather than risk an incorrect answer.
            for i in range(len(polyline) - 1):
                if i in checked_segments:
                    continue
                distance_m, distance_from_start_m = _consider(i)
                if distance_m < best_distance_m:
                    best_distance_m = distance_m
                    best_distance_from_start_m = distance_from_start_m
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
