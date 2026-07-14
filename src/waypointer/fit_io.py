"""Builds a ridable FIT course file from a GPX route plus selected water
fountain candidates. Bytes in (already-parsed route coordinates), bytes
out, no filesystem I/O - same contract as gpx_io.py.

Scope limitation (intentional): only newly selected water fountain
candidates become course_point entries. Pre-existing GPX <wpt> elements
(e.g. a route's own cue-sheet markers) are NOT translated into FIT course
points - there's no confirmed developer-field mapping for those, so this
module never sees them; callers must not pass them in.

The water icon on a Wahoo ELEMNT ROAM v3 does not come from the standard
FIT course_point.type enum. It comes from a developer field named
"course_point_type" (uint8), confirmed by decoding a real FIT file
(produced by Komoot's Wahoo integration) that the water fountain icon
does render for - see the plan for the full investigation. Water points
there had course_point_type=16 and a native type of GENERIC (0), which
this module replicates exactly.
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

DEVELOPER_DATA_INDEX = 0
COURSE_POINT_TYPE_FIELD_NUM = 16  # mirrors the confirmed-working reference file
COURSE_POINT_TYPE_FIELD_NAME = "course_point_type"
WATER_COURSE_POINT_TYPE = 16  # confirmed value for water fountains
TIMESTAMP_STEP_MS = 10_000  # synthetic, monotonically increasing only - not real ride timing


@dataclass(frozen=True)
class FitFountain:
    lat: float
    lon: float
    name: str | None


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


def _record_messages(route_coords: list[LatLon], start_ts_ms: int) -> tuple[list[RecordMessage], list[float]]:
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
        records.append(record)

    return records, distances[1:]


def _nearest_route_point_index(point: LatLon, route_coords: list[LatLon]) -> int:
    return min(
        range(len(route_coords)),
        key=lambda i: haversine_m(point[0], point[1], route_coords[i][0], route_coords[i][1]),
    )


def _course_point_messages(
    fountains: list[FitFountain],
    route_coords: list[LatLon],
    route_distances: list[float],
    start_ts_ms: int,
) -> list[CoursePointMessage]:
    messages = []
    for fountain in fountains:
        idx = _nearest_route_point_index((fountain.lat, fountain.lon), route_coords)

        message = CoursePointMessage(developer_fields=[_course_point_type_field(WATER_COURSE_POINT_TYPE)])
        message.timestamp = start_ts_ms + idx * TIMESTAMP_STEP_MS
        message.position_lat = fountain.lat
        message.position_long = fountain.lon
        message.distance = route_distances[idx]
        message.type = CoursePoint.GENERIC
        message.course_point_name = fountain.name or "Water Fountain"
        messages.append(message)
    return messages


def build_course_fit_bytes(
    route_coords: list[LatLon],
    fountains: list[FitFountain],
    course_name: str,
) -> bytes:
    """Builds a full ridable FIT course: file_id, course, timer start
    event, one record per route point, developer field declarations, one
    course_point per fountain (native type=GENERIC, course_point_type
    developer field=16), timer stop event, and a lap. Returns encoded
    bytes - stateless, no filesystem I/O.
    """
    if not route_coords:
        raise ValueError("route_coords must contain at least one point")

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

    records, distances = _record_messages(route_coords, start_ts_ms)
    builder.add_all(records)

    builder.add_all(_developer_field_declaration_messages())
    builder.add_all(_course_point_messages(fountains, route_coords, distances, start_ts_ms))

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
    builder.add(lap)

    return builder.build().to_bytes()
