import pytest
from fit_tool.fit_file import FitFile
from fit_tool.profile.messages.course_point_message import CoursePointMessage
from fit_tool.profile.messages.file_id_message import FileIdMessage
from fit_tool.profile.messages.record_message import RecordMessage
from fit_tool.profile.profile_type import FileType

from waypointer.fit_io import FitFountain, build_course_fit_bytes
from waypointer.gpx_io import parse_gpx, route_coordinates


def _decode(fit_bytes: bytes) -> list:
    fit_file = FitFile.from_bytes(fit_bytes)
    return [r.message for r in fit_file.records if not r.is_definition]


def test_build_course_fit_bytes_round_trip(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    coords = route_coordinates(gpx)
    fountains = [FitFountain(lat=48.8567, lon=2.3524, name="Fontaine Wallace")]

    fit_bytes = build_course_fit_bytes(coords, fountains, course_name="Test Route")
    messages = _decode(fit_bytes)

    file_id = next(m for m in messages if isinstance(m, FileIdMessage))
    assert file_id.type == FileType.COURSE.value

    course_point = next(m for m in messages if isinstance(m, CoursePointMessage))
    assert course_point.course_point_name == "Fontaine Wallace"
    assert round(course_point.position_lat, 4) == round(48.8567, 4)
    assert round(course_point.position_long, 4) == round(2.3524, 4)
    assert course_point.developer_fields[0].name == "course_point_type"
    assert course_point.developer_fields[0].get_value(0) == 16

    record_messages = [m for m in messages if isinstance(m, RecordMessage)]
    assert len(record_messages) == len(coords) == 3


def test_build_course_fit_bytes_rejects_empty_route():
    with pytest.raises(ValueError):
        build_course_fit_bytes([], [], course_name="x")


def test_build_course_fit_bytes_with_no_fountains_still_decodes(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    coords = route_coordinates(gpx)

    fit_bytes = build_course_fit_bytes(coords, [], course_name="Test Route")
    messages = _decode(fit_bytes)

    assert not any(isinstance(m, CoursePointMessage) for m in messages)
    assert len([m for m in messages if isinstance(m, RecordMessage)]) == len(coords)
