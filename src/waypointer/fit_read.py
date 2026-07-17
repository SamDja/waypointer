"""Reads a FIT course/route file back into GPX bytes.

The inverse direction of fit_io.py (which only *builds* FIT): this parses an
existing FIT file's record messages into a track, and its course points into
waypoints, re-emitting both as GPX so a route imported from Wahoo (Wahoo
stores routes as FIT) can flow through the rest of the app's GPX-only
pipeline unchanged - including the existing-waypoint review step. Bytes in,
bytes out, no filesystem I/O - same contract as gpx_io.py.
"""

import gpxpy
import gpxpy.gpx
from fit_tool.fit_file import FitFile
from fit_tool.profile.messages.course_point_message import CoursePointMessage
from fit_tool.profile.messages.record_message import RecordMessage

from waypointer.fit_io import COURSE_POINT_TYPE_FIELD_NAME
from waypointer.gpx_io import add_waypoints, stamp_poi_type
from waypointer.poi_types import POI_TYPE_BY_COURSE_POINT_TYPE, POI_TYPES


def _course_point_type(message: CoursePointMessage) -> int | None:
    for field in message.developer_fields:
        if field.name == COURSE_POINT_TYPE_FIELD_NAME:
            return field.get_value(0)
    return None


def _course_point_to_waypoint(message: CoursePointMessage) -> gpxpy.gpx.GPXWaypoint | None:
    lat = message.position_lat
    lon = message.position_long
    if lat is None or lon is None:
        return None

    # The developer field is only present on FIT files that use the same
    # course_point_type convention this app's own writer uses (confirmed for
    # Wahoo-hosted routes, see fit_io.py) - absent/unrecognized just means
    # "generic" rather than failing the whole import.
    course_point_type = _course_point_type(message)
    poi_type = POI_TYPE_BY_COURSE_POINT_TYPE.get(course_point_type, "generic")
    cfg = POI_TYPES[poi_type]
    name = message.course_point_name or cfg.default_name

    waypoint = gpxpy.gpx.GPXWaypoint(latitude=lat, longitude=lon, name=name)
    stamp_poi_type(waypoint, poi_type)
    return waypoint


def fit_route_to_gpx_bytes(fit_bytes: bytes, track_name: str | None = None) -> bytes:
    """Parses a FIT file's record-message track into a single-track GPX, and
    its course-point messages into <wpt> waypoints (each stamped with its
    recovered POI type via gpx_io.stamp_poi_type - see
    POI_TYPE_BY_COURSE_POINT_TYPE).

    fit-tool's position getters already return degrees (not raw semicircles),
    so no conversion is needed here. Records/course points lacking a position
    are skipped (a FIT can carry position-less ones). Altitude is copied
    through for track points when present. Raises ValueError if no positioned
    track points are found - the caller surfaces that as a 400 rather than
    emitting an empty GPX the downstream pipeline would reject anyway (a FIT
    with course points but no track is not a usable route either way).
    """
    fit_file = FitFile.from_bytes(fit_bytes)

    gpx = gpxpy.gpx.GPX()
    track = gpxpy.gpx.GPXTrack(name=track_name)
    segment = gpxpy.gpx.GPXTrackSegment()
    track.segments.append(segment)
    gpx.tracks.append(track)

    waypoints: list[gpxpy.gpx.GPXWaypoint] = []
    for record in fit_file.records:
        if record.is_definition:
            continue
        message = record.message
        if isinstance(message, RecordMessage):
            lat = message.position_lat
            lon = message.position_long
            if lat is None or lon is None:
                continue
            segment.points.append(
                gpxpy.gpx.GPXTrackPoint(latitude=lat, longitude=lon, elevation=message.altitude)
            )
        elif isinstance(message, CoursePointMessage):
            waypoint = _course_point_to_waypoint(message)
            if waypoint is not None:
                waypoints.append(waypoint)

    if not segment.points:
        raise ValueError("FIT file contained no positioned track points")

    add_waypoints(gpx, waypoints)

    return gpx.to_xml().encode("utf-8")
