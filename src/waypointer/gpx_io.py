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

WAYPOINTER_NS = "https://github.com/SamDja/waypointer"
WAYPOINTER_PREFIX = "waypointer"
OSM_ID_LOCAL_NAME = "osm_id"
OSM_ID_CLARK_TAG = f"{{{WAYPOINTER_NS}}}{OSM_ID_LOCAL_NAME}"

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


def to_xml_bytes(gpx: gpxpy.gpx.GPX) -> bytes:
    return gpx.to_xml().encode("utf-8")
