"""GPX parsing, route extraction, dedup, and merge/write via gpxpy.

Everything here operates on in-memory bytes, never a filesystem path - the
server is stateless and never writes to disk.
"""

import xml.etree.ElementTree as ET

import gpxpy
import gpxpy.gpx

from waypointer.device_profiles import DeviceProfile, build_waypoint
from waypointer.geometry import LatLon, haversine_m
from waypointer.osm import OsmNode
from waypointer.poi_types import POI_TYPES

WAYPOINTER_NS = "https://github.com/SamDja/waypointer"
WAYPOINTER_PREFIX = "waypointer"
OSM_ID_LOCAL_NAME = "osm_id"
OSM_ID_CLARK_TAG = f"{{{WAYPOINTER_NS}}}{OSM_ID_LOCAL_NAME}"
# Stamped onto waypoints synthesized from a FIT file's course points (see
# fit_read.py) - carries the exact POI type recovered from the FIT
# course_point_type developer field, so infer_poi_type doesn't need to
# fall back to guessing from <sym>/<type> text for these.
POI_TYPE_LOCAL_NAME = "poi_type"
POI_TYPE_CLARK_TAG = f"{{{WAYPOINTER_NS}}}{POI_TYPE_LOCAL_NAME}"

# Fallback dedup radius for waypoints that lack our marker (hand-edited
# files, or files produced by another tool). Deliberately tight relative to
# the 50m search radius so it only catches true duplicates.
DUPLICATE_PROXIMITY_M = 5.0


def parse_gpx(content: bytes) -> gpxpy.gpx.GPX:
    return gpxpy.parse(content.decode("utf-8"))


def route_coordinates(gpx: gpxpy.gpx.GPX) -> list[LatLon]:
    """Flattens all track and route points, in document order, into one
    polyline - used both for the Overpass query and the authoritative
    50m distance check."""
    coords: list[LatLon] = []
    for track in gpx.tracks:
        for segment in track.segments:
            coords.extend((p.latitude, p.longitude) for p in segment.points)
    for route in gpx.routes:
        coords.extend((p.latitude, p.longitude) for p in route.points)
    return coords


def route_elevations(gpx: gpxpy.gpx.GPX) -> list[float | None]:
    """Elevation in meters for each point, in the same track/route document
    order as route_coordinates() - the two lists are meant to be zipped
    index-for-index. None where a point carries no <ele>."""
    elevations: list[float | None] = []
    for track in gpx.tracks:
        for segment in track.segments:
            elevations.extend(p.elevation for p in segment.points)
    for route in gpx.routes:
        elevations.extend(p.elevation for p in route.points)
    return elevations


def total_ascent_m(gpx: gpxpy.gpx.GPX) -> float:
    """Sum of positive elevation deltas between consecutive points that both
    carry elevation - a gap where one side lacks elevation is skipped rather
    than bridged. Files with no elevation data anywhere return 0.0 rather
    than raising - Wahoo's route push accepts an ascent of 0."""
    elevations = route_elevations(gpx)
    return sum(
        max(0.0, b - a)
        for a, b in zip(elevations, elevations[1:])
        if a is not None and b is not None
    )


def existing_osm_ids(gpx: gpxpy.gpx.GPX) -> set[int]:
    """OSM node ids already stamped onto waypoints by a previous run."""
    ids: set[int] = set()
    for wpt in gpx.waypoints:
        for ext in wpt.extensions:
            if ext.tag == OSM_ID_CLARK_TAG and ext.text:
                try:
                    ids.add(int(ext.text))
                except ValueError:
                    continue
    return ids


def existing_waypoint_coords(gpx: gpxpy.gpx.GPX) -> list[LatLon]:
    return [(w.latitude, w.longitude) for w in gpx.waypoints]


def _has_osm_id_marker(wpt: gpxpy.gpx.GPXWaypoint) -> bool:
    return any(ext.tag == OSM_ID_CLARK_TAG for ext in wpt.extensions)


def _poi_type_marker(wpt: gpxpy.gpx.GPXWaypoint) -> str | None:
    for ext in wpt.extensions:
        if ext.tag == POI_TYPE_CLARK_TAG and ext.text in POI_TYPES:
            return ext.text
    return None


def stamp_poi_type(waypoint: gpxpy.gpx.GPXWaypoint, poi_type: str) -> None:
    """Marks a waypoint with its exact, already-known POI type - used for
    waypoints synthesized from a FIT file's course points (fit_read.py),
    where the type comes from the course_point_type developer field rather
    than a guess. infer_poi_type reads this back verbatim, ahead of its
    other, fuzzier rules."""
    marker = ET.Element(f"{WAYPOINTER_PREFIX}:{POI_TYPE_LOCAL_NAME}")
    marker.text = poi_type
    waypoint.extensions.append(marker)


def infer_poi_type(wpt: gpxpy.gpx.GPXWaypoint) -> str:
    """Best-effort guess at which registered POI type a pre-existing
    waypoint represents - only a starting suggestion, since the frontend's
    AssignWaypointTypesDialog lets the visitor correct it before it ever
    affects export. A stamped poi_type marker (see stamp_poi_type) means the
    type is already known exactly - e.g. recovered from a FIT file's
    course_point_type developer field - so that always wins first. Otherwise
    a stamped osm_id marker means we added this waypoint ourselves on a
    previous export; since Find POIs only ever searches for "water" today
    that's unambiguous (revisit if search expands to other types). Otherwise
    falls back to a substring match of the waypoint's <sym>/<type> text
    against each registered type's sym_hints - best-effort for hand-edited
    files or other tools' exports, not exhaustive by design. Deliberately
    does not match against <name>, which is free text and would produce
    false positives (e.g. "Water Street Cafe"). Always resolves to a
    concrete registry key, "generic" at worst - never None."""
    marker_type = _poi_type_marker(wpt)
    if marker_type is not None:
        return marker_type
    if _has_osm_id_marker(wpt):
        return "water"
    text = f"{wpt.symbol or ''} {wpt.type or ''}".lower()
    for cfg in POI_TYPES.values():
        if any(hint in text for hint in cfg.sym_hints):
            return cfg.key
    return "generic"


def is_duplicate_candidate(node: OsmNode, gpx: gpxpy.gpx.GPX) -> bool:
    """True if node is already represented by a waypoint in gpx, either via
    our stored osm_id marker or, as a fallback, proximity to any existing
    waypoint."""
    if node.id in existing_osm_ids(gpx):
        return True
    return any(
        haversine_m(node.lat, node.lon, lat, lon) <= DUPLICATE_PROXIMITY_M
        for lat, lon in existing_waypoint_coords(gpx)
    )


def make_waypoint(
    node: OsmNode, profile: DeviceProfile, distance_m: float
) -> gpxpy.gpx.GPXWaypoint:
    """Builds the GPXWaypoint via device_profiles, then stamps the dedup
    marker - kept out of device_profiles so that module stays unaware of
    GPX extension/dedup mechanics."""
    waypoint = build_waypoint(node, profile, distance_m)
    marker = ET.Element(f"{WAYPOINTER_PREFIX}:{OSM_ID_LOCAL_NAME}")
    marker.text = str(node.id)
    waypoint.extensions.append(marker)
    return waypoint


def add_waypoints(gpx: gpxpy.gpx.GPX, waypoints: list[gpxpy.gpx.GPXWaypoint]) -> None:
    """Appends to gpx.waypoints in place. Never touches gpx.tracks/gpx.routes."""
    gpx.waypoints.extend(waypoints)
    if waypoints:
        gpx.nsmap[WAYPOINTER_PREFIX] = WAYPOINTER_NS


def discard_waypoints(gpx: gpxpy.gpx.GPX, indices: set[int]) -> None:
    """Removes gpx.waypoints entries by their position in the original,
    pre-discard document order (see ExistingWaypoint.index) - in place.
    Call before add_waypoints, since indices refer to the original list."""
    if not indices:
        return
    gpx.waypoints = [w for i, w in enumerate(gpx.waypoints) if i not in indices]


def to_xml_bytes(gpx: gpxpy.gpx.GPX) -> bytes:
    return gpx.to_xml().encode("utf-8")
