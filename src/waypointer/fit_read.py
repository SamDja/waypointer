"""Reads a FIT course/route file back into GPX bytes.

The inverse direction of fit_io.py (which only *builds* FIT): this parses an
existing FIT file's record messages into a track and re-emits it as GPX, so a
route imported from Wahoo (Wahoo stores routes as FIT) can flow through the
rest of the app's GPX-only pipeline unchanged. Bytes in, bytes out, no
filesystem I/O - same contract as gpx_io.py.
"""

import gpxpy
import gpxpy.gpx
from fit_tool.fit_file import FitFile
from fit_tool.profile.messages.record_message import RecordMessage


def fit_route_to_gpx_bytes(fit_bytes: bytes, track_name: str | None = None) -> bytes:
    """Parses a FIT file's record-message track into a single-track GPX.

    fit-tool's position getters already return degrees (not raw semicircles),
    so no conversion is needed here. Records lacking a position are skipped
    (a FIT can carry position-less records). Altitude is copied through when
    present. Raises ValueError if no positioned records are found - the
    caller surfaces that as a 400 rather than emitting an empty GPX the
    downstream pipeline would reject anyway.
    """
    fit_file = FitFile.from_bytes(fit_bytes)

    gpx = gpxpy.gpx.GPX()
    track = gpxpy.gpx.GPXTrack(name=track_name)
    segment = gpxpy.gpx.GPXTrackSegment()
    track.segments.append(segment)
    gpx.tracks.append(track)

    for record in fit_file.records:
        if record.is_definition:
            continue
        message = record.message
        if not isinstance(message, RecordMessage):
            continue
        lat = message.position_lat
        lon = message.position_long
        if lat is None or lon is None:
            continue
        segment.points.append(
            gpxpy.gpx.GPXTrackPoint(latitude=lat, longitude=lon, elevation=message.altitude)
        )

    if not segment.points:
        raise ValueError("FIT file contained no positioned track points")

    return gpx.to_xml().encode("utf-8")
