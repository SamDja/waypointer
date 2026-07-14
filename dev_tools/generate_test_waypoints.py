"""Generate a FIT course file with 100 course points (course_point_type
developer field values 0-99) clustered around a fixed location, for
manually testing which values map to which icons on a Wahoo device.

Run with the waypointer project's environment (fit-tool is already a
dependency there): `uv run python generate_test_waypoints.py`
"""

import datetime
import math

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
from fit_tool.profile.profile_type import CoursePoint, Event, EventType, FileType, Manufacturer, Sport

# Center position, given as raw FIT semicircle integers - convert to degrees.
CENTER_LAT_SEMICIRCLES = 548834734
CENTER_LON_SEMICIRCLES = 133613461
SEMICIRCLE_TO_DEGREES = 180 / (2 ** 31)

CENTER_LAT = CENTER_LAT_SEMICIRCLES * SEMICIRCLE_TO_DEGREES
CENTER_LON = CENTER_LON_SEMICIRCLES * SEMICIRCLE_TO_DEGREES

DEVELOPER_DATA_INDEX = 0
COURSE_POINT_TYPE_FIELD_NUM = 16
COURSE_POINT_TYPE_FIELD_NAME = "course_point_type"

GRID_SIZE = 10  # 10x10 = 100 points, values 0..99
SPACING_M = 8.0  # meters between adjacent grid points

TIMESTAMP_STEP_MS = 10_000
OUTPUT_PATH = "course_point_type_test.fit"


def grid_offset(index: int) -> tuple[float, float]:
    """Returns a (lat, lon) offset in degrees for a small grid around CENTER."""
    row, col = divmod(index, GRID_SIZE)
    lat_step_deg = SPACING_M / 111_320
    lon_step_deg = SPACING_M / (111_320 * math.cos(math.radians(CENTER_LAT)))
    return row * lat_step_deg, col * lon_step_deg


def now_ms() -> int:
    return round(datetime.datetime.now(tz=datetime.timezone.utc).timestamp() * 1000)


def main() -> None:
    builder = FitFileBuilder(auto_define=True, min_string_size=50)
    start_ts_ms = now_ms()

    file_id = FileIdMessage()
    file_id.type = FileType.COURSE
    file_id.manufacturer = Manufacturer.DEVELOPMENT.value
    file_id.product = 0
    file_id.time_created = start_ts_ms
    file_id.serial_number = 0x12345678
    builder.add(file_id)

    course = CourseMessage()
    course.course_name = "course_point_type test grid"
    course.sport = Sport.CYCLING
    builder.add(course)

    start_event = EventMessage()
    start_event.event = Event.TIMER
    start_event.event_type = EventType.START
    start_event.timestamp = start_ts_ms
    builder.add(start_event)

    points = []
    for i in range(100):
        d_lat, d_lon = grid_offset(i)
        points.append((CENTER_LAT + d_lat, CENTER_LON + d_lon))

    # One record per test point so the file is a valid, "ridable" course.
    records = []
    distance = 0.0
    prev = None
    for i, (lat, lon) in enumerate(points):
        if prev is not None:
            # Cheap flat-earth distance estimate - fine at this scale.
            dlat_m = (lat - prev[0]) * 111_320
            dlon_m = (lon - prev[1]) * 111_320 * math.cos(math.radians(CENTER_LAT))
            distance += math.hypot(dlat_m, dlon_m)
        prev = (lat, lon)

        record = RecordMessage()
        record.position_lat = lat
        record.position_long = lon
        record.distance = distance
        record.timestamp = start_ts_ms + i * TIMESTAMP_STEP_MS
        records.append(record)
    builder.add_all(records)

    # Declare the developer field once.
    developer_data_id = DeveloperDataIdMessage()
    developer_data_id.developer_data_index = DEVELOPER_DATA_INDEX
    builder.add(developer_data_id)

    field_description = FieldDescriptionMessage()
    field_description.developer_data_index = DEVELOPER_DATA_INDEX
    field_description.field_definition_number = COURSE_POINT_TYPE_FIELD_NUM
    field_description.fit_base_type_id = BaseType.UINT8
    field_description.field_name = COURSE_POINT_TYPE_FIELD_NAME
    field_description.units = ""
    builder.add(field_description)

    # One course_point per test value 0..99, native type left as GENERIC.
    course_points = []
    for i, (lat, lon) in enumerate(points):
        dev_field = DeveloperField(
            developer_data_index=DEVELOPER_DATA_INDEX,
            field_id=COURSE_POINT_TYPE_FIELD_NUM,
            size=1,
            name=COURSE_POINT_TYPE_FIELD_NAME,
            base_type=BaseType.UINT8,
        )
        dev_field.set_value(0, i)

        cp = CoursePointMessage(developer_fields=[dev_field])
        cp.timestamp = start_ts_ms + i * TIMESTAMP_STEP_MS
        cp.position_lat = lat
        cp.position_long = lon
        cp.distance = records[i].distance
        cp.type = CoursePoint.GENERIC
        cp.course_point_name = f"Type {i}"
        course_points.append(cp)
    builder.add_all(course_points)

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
    lap.start_position_lat = points[0][0]
    lap.start_position_long = points[0][1]
    lap.end_position_lat = points[-1][0]
    lap.end_position_long = points[-1][1]
    lap.total_distance = records[-1].distance
    builder.add(lap)

    fit_bytes = builder.build().to_bytes()
    with open(OUTPUT_PATH, "wb") as f:
        f.write(fit_bytes)
    print(f"Wrote {len(fit_bytes)} bytes to {OUTPUT_PATH}")
    print(f"Center: {CENTER_LAT:.6f}, {CENTER_LON:.6f}")


if __name__ == "__main__":
    main()
