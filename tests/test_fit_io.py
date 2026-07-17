import pytest
from fit_tool.fit_file import FitFile
from fit_tool.profile.messages.course_point_message import CoursePointMessage
from fit_tool.profile.messages.file_id_message import FileIdMessage
from fit_tool.profile.messages.record_message import RecordMessage
from fit_tool.profile.profile_type import FileType

from waypointer.fit_io import FitCoursePoint, build_course_fit_bytes
from waypointer.gpx_io import parse_gpx, route_coordinates, route_elevations


def _decode(fit_bytes: bytes) -> list:
    fit_file = FitFile.from_bytes(fit_bytes)
    return [r.message for r in fit_file.records if not r.is_definition]


def test_build_course_fit_bytes_round_trip(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    coords = route_coordinates(gpx)
    fountains = [FitCoursePoint(lat=48.8567, lon=2.3524, name="Fontaine Wallace", poi_type="water")]

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


def test_build_course_fit_bytes_uses_course_point_type_per_poi_type(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    coords = route_coordinates(gpx)
    points = [
        FitCoursePoint(lat=48.8567, lon=2.3524, name="Toilet", poi_type="toilet"),
        FitCoursePoint(lat=48.857, lon=2.353, name=None, poi_type="unknown_type"),
    ]

    fit_bytes = build_course_fit_bytes(coords, points, course_name="Test Route")
    messages = _decode(fit_bytes)

    course_points = [m for m in messages if isinstance(m, CoursePointMessage)]
    assert course_points[0].developer_fields[0].get_value(0) == 59  # toilet
    assert course_points[0].course_point_name == "Toilet"
    assert course_points[1].developer_fields[0].get_value(0) == 0  # unknown -> generic
    assert course_points[1].course_point_name == "Point of Interest"

    record_messages = [m for m in messages if isinstance(m, RecordMessage)]
    assert len(record_messages) == len(coords) == 3


def test_build_course_fit_bytes_sets_record_altitude_from_elevations(sample_route_bytes):
    # sample_route.gpx's three trkpts have ele 35.0 -> 36.0 -> 37.0.
    gpx = parse_gpx(sample_route_bytes)
    coords = route_coordinates(gpx)
    elevations = route_elevations(gpx)

    fit_bytes = build_course_fit_bytes(
        coords, [], course_name="Test Route", elevations_m=elevations
    )
    messages = _decode(fit_bytes)

    record_messages = [m for m in messages if isinstance(m, RecordMessage)]
    assert [round(r.altitude, 1) for r in record_messages] == [35.0, 36.0, 37.0]


def test_build_course_fit_bytes_without_elevations_leaves_altitude_unset(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    coords = route_coordinates(gpx)

    fit_bytes = build_course_fit_bytes(coords, [], course_name="Test Route")
    messages = _decode(fit_bytes)

    record_messages = [m for m in messages if isinstance(m, RecordMessage)]
    assert all(r.altitude is None for r in record_messages)


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
