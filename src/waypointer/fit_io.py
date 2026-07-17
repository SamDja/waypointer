"""Builds a ridable FIT course file from a GPX route plus a list of course
points - both newly selected search candidates and kept pre-existing GPX
<wpt> entries (main.py's callers build this combined list; see
_build_fit_course_points). Bytes in (already-parsed route coordinates),
bytes out, no filesystem I/O - same contract as gpx_io.py.

Icon selection on a Wahoo ELEMNT ROAM v3 does not come from the standard
FIT course_point.type enum. It comes from a developer field named
"course_point_type" (uint8), confirmed by decoding a real FIT file
(produced by Komoot's Wahoo integration) that the water fountain icon
does render for - see the plan for the full investigation. That file's
water points had course_point_type=16 and a native type of GENERIC (0),
which this module replicates exactly for every point regardless of POI
type. The full course_point_type value per POI type key lives in
poi_types.py (PoiTypeConfig.course_point_type), sourced from
dev_tools/wahoo_poi_mapping.json's reverse-engineered 0-99 range.
"""

import datetime
from dataclasses import dataclass

from fit_tool.base_type import BaseType
from fit_tool.developer_field import DeveloperField
from fit_tool.fit_file_builder import FitFileBuilder
from fit_tool.profile.messages.course_message import CourseMessage
from fit_tool.profile.messages.course_point_message import CoursePointMessage
from fit_tool.profile.messages.developer_data_id_message import DeveloperDataIdMessage
from fit_tool.profile.messages.event_message import EventMessage
from fit_tool.profile.messages.field_description_message import FieldDescriptionMessage
from fit_tool.profile.messages.file_id_message import FileIdMessage
from fit_tool.profile.messages.lap_message import LapMessage
from fit_tool.profile.messages.record_message import RecordMessage
from fit_tool.profile.profile_type import (
    CoursePoint,
    Event,
    EventType,
    FileType,
    Manufacturer,
    Sport,
)

from waypointer.geometry import LatLon, haversine_m
from waypointer.poi_types import POI_TYPES

DEVELOPER_DATA_INDEX = 0
COURSE_POINT_TYPE_FIELD_NUM = 16  # mirrors the confirmed-working reference file
COURSE_POINT_TYPE_FIELD_NAME = "course_point_type"
TIMESTAMP_STEP_MS = 10_000  # synthetic, monotonically increasing only - not real ride timing


@dataclass(frozen=True)
class FitCoursePoint:
    lat: float
    lon: float
    name: str | None
    poi_type: str


def _now_ms() -> int:
    return round(datetime.datetime.now(tz=datetime.timezone.utc).timestamp() * 1000)


def _developer_field_declaration_messages() -> list:
    developer_data_id = DeveloperDataIdMessage()
    developer_data_id.developer_data_index = DEVELOPER_DATA_INDEX

    field_description = FieldDescriptionMessage()
    field_description.developer_data_index = DEVELOPER_DATA_INDEX
    field_description.field_definition_number = COURSE_POINT_TYPE_FIELD_NUM
    field_description.fit_base_type_id = BaseType.UINT8
    field_description.field_name = COURSE_POINT_TYPE_FIELD_NAME
    field_description.units = ""

    return [developer_data_id, field_description]


def _course_point_type_field(value: int) -> DeveloperField:
    field = DeveloperField(
        developer_data_index=DEVELOPER_DATA_INDEX,
        field_id=COURSE_POINT_TYPE_FIELD_NUM,
        size=1,
        name=COURSE_POINT_TYPE_FIELD_NAME,
        base_type=BaseType.UINT8,
    )
    field.set_value(0, value)
    return field


def _record_messages(
    route_coords: list[LatLon], elevations_m: list[float | None], start_ts_ms: int
) -> tuple[list[RecordMessage], list[float]]:
    records = []
    distances = [0.0]
    distance = 0.0
    prev: LatLon | None = None

    for i, (lat, lon) in enumerate(route_coords):
        if prev is not None:
            distance += haversine_m(prev[0], prev[1], lat, lon)
        distances.append(distance)
        prev = (lat, lon)

        record = RecordMessage()
        record.position_lat = lat
        record.position_long = lon
        record.distance = distance
        record.timestamp = start_ts_ms + i * TIMESTAMP_STEP_MS
        # Left unset (rather than defaulted to 0) when the source GPX point
        # has no <ele> - an explicit 0m would otherwise look like sea-level
        # elevation instead of "unknown" (see main.py's callers, which
        # source this from gpx_io.route_elevations()).
        elevation = elevations_m[i] if i < len(elevations_m) else None
        if elevation is not None:
            record.altitude = elevation
        records.append(record)

    return records, distances[1:]


@dataclass(frozen=True)
class _ElevationStats:
    total_ascent: float
    total_descent: float
    avg_altitude: float
    max_altitude: float
    min_altitude: float


def _elevation_stats(elevations_m: list[float | None]) -> _ElevationStats | None:
    """Lap-level ascent/descent/avg/min/max altitude, mirroring
    gpx_io.total_ascent_m()'s pairwise skip-gap rule (a delta only counts
    when both consecutive points carry elevation - gaps aren't bridged).
    Returns None when no point has elevation, so the caller can leave the
    Lap's altitude fields unset rather than defaulting to 0 - a course with
    an all-zero elevation summary looks identical to a genuinely flat one,
    which is exactly the "no elevation data" bug this exists to prevent.
    """
    known = [e for e in elevations_m if e is not None]
    if not known:
        return None

    ascent = 0.0
    descent = 0.0
    for a, b in zip(elevations_m, elevations_m[1:]):
        if a is None or b is None:
            continue
        delta = b - a
        if delta > 0:
            ascent += delta
        else:
            descent += -delta

    return _ElevationStats(
        total_ascent=ascent,
        total_descent=descent,
        avg_altitude=sum(known) / len(known),
        max_altitude=max(known),
        min_altitude=min(known),
    )


def _nearest_route_point_index(point: LatLon, route_coords: list[LatLon]) -> int:
    return min(
        range(len(route_coords)),
        key=lambda i: haversine_m(point[0], point[1], route_coords[i][0], route_coords[i][1]),
    )


def _course_point_messages(
    points: list[FitCoursePoint],
    route_coords: list[LatLon],
    route_distances: list[float],
    start_ts_ms: int,
) -> list[CoursePointMessage]:
    messages = []
    for point in points:
        idx = _nearest_route_point_index((point.lat, point.lon), route_coords)
        cfg = POI_TYPES.get(point.poi_type, POI_TYPES["generic"])

        message = CoursePointMessage(developer_fields=[_course_point_type_field(cfg.course_point_type)])
        message.timestamp = start_ts_ms + idx * TIMESTAMP_STEP_MS
        message.position_lat = point.lat
        message.position_long = point.lon
        message.distance = route_distances[idx]
        message.type = CoursePoint.GENERIC
        message.course_point_name = point.name or cfg.default_name
        messages.append(message)
    return messages


def build_course_fit_bytes(
    route_coords: list[LatLon],
    course_points: list[FitCoursePoint],
    course_name: str,
    elevations_m: list[float | None] | None = None,
) -> bytes:
    """Builds a full ridable FIT course: file_id, course, timer start
    event, one record per route point, developer field declarations, one
    course_point per course_points entry (native type=GENERIC, course_point_type
    developer field looked up per entry's poi_type), timer stop event, and a
    lap. Returns encoded bytes - stateless, no filesystem I/O.

    elevations_m, if given, must be index-parallel to route_coords (see
    gpx_io.route_elevations()) and is used to set each record's altitude,
    plus the lap's total_ascent/total_descent/avg_altitude/max_altitude/
    min_altitude (see _elevation_stats) - without both, Wahoo has no
    elevation data to show for the course at all, and per-record altitude
    alone was observed to still render the route as a flat, uncolored
    line on a Wahoo ELEMNT ROAM's navigation map. Defaults to all-None (no
    altitude data at all) so callers that only have a plain polyline (no
    source GPX) still work.
    """
    if not route_coords:
        raise ValueError("route_coords must contain at least one point")
    if elevations_m is None:
        elevations_m = [None] * len(route_coords)

    builder = FitFileBuilder(auto_define=True, min_string_size=50)
    start_ts_ms = _now_ms()

    file_id = FileIdMessage()
    file_id.type = FileType.COURSE
    file_id.manufacturer = Manufacturer.DEVELOPMENT.value
    file_id.product = 0
    file_id.time_created = start_ts_ms
    file_id.serial_number = 0x12345678
    builder.add(file_id)

    course = CourseMessage()
    course.course_name = course_name
    course.sport = Sport.CYCLING
    builder.add(course)

    start_event = EventMessage()
    start_event.event = Event.TIMER
    start_event.event_type = EventType.START
    start_event.timestamp = start_ts_ms
    builder.add(start_event)

    records, distances = _record_messages(route_coords, elevations_m, start_ts_ms)
    builder.add_all(records)

    builder.add_all(_developer_field_declaration_messages())
    builder.add_all(_course_point_messages(course_points, route_coords, distances, start_ts_ms))

    end_ts_ms = records[-1].timestamp
    stop_event = EventMessage()
    stop_event.event = Event.TIMER
    stop_event.event_type = EventType.STOP_ALL
    stop_event.timestamp = end_ts_ms
    builder.add(stop_event)

    lap = LapMessage()
    lap.timestamp = end_ts_ms
    lap.start_time = start_ts_ms
    lap.total_elapsed_time = (end_ts_ms - start_ts_ms) / 1000
    lap.total_timer_time = (end_ts_ms - start_ts_ms) / 1000
    lap.start_position_lat = route_coords[0][0]
    lap.start_position_long = route_coords[0][1]
    lap.end_position_lat = route_coords[-1][0]
    lap.end_position_long = route_coords[-1][1]
    lap.total_distance = distances[-1]
    elevation_stats = _elevation_stats(elevations_m)
    if elevation_stats is not None:
        lap.total_ascent = round(elevation_stats.total_ascent)
        lap.total_descent = round(elevation_stats.total_descent)
        lap.avg_altitude = elevation_stats.avg_altitude
        lap.max_altitude = elevation_stats.max_altitude
        lap.min_altitude = elevation_stats.min_altitude
    builder.add(lap)

    return builder.build().to_bytes()
