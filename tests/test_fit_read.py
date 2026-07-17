import gpxpy
import pytest

from waypointer.fit_io import FitCoursePoint, build_course_fit_bytes
from waypointer.fit_read import fit_route_to_gpx_bytes
from waypointer.gpx_io import infer_poi_type, parse_gpx


def test_fit_route_to_gpx_round_trip():
    coords = [(48.8566, 2.3522), (48.857, 2.353), (48.8575, 2.354)]
    elevations = [35.0, 36.0, 37.0]
    fit_bytes = build_course_fit_bytes(coords, [], course_name="Test Route", elevations_m=elevations)

    gpx = gpxpy.parse(fit_route_to_gpx_bytes(fit_bytes, track_name="Test Route").decode("utf-8"))

    points = [p for track in gpx.tracks for segment in track.segments for p in segment.points]
    assert len(points) == len(coords)
    for point, (lat, lon), ele in zip(points, coords, elevations):
        assert point.latitude == pytest.approx(lat, abs=1e-4)
        assert point.longitude == pytest.approx(lon, abs=1e-4)
        assert point.elevation == pytest.approx(ele, abs=0.5)


def test_fit_route_to_gpx_rejects_non_fit_bytes():
    # fit-tool raises on malformed input; the endpoint maps that to a 400.
    with pytest.raises(Exception):
        fit_route_to_gpx_bytes(b"not a fit file")


def test_fit_route_to_gpx_imports_course_points_as_waypoints():
    coords = [(48.8566, 2.3522), (48.857, 2.353), (48.8575, 2.354)]
    course_points = [FitCoursePoint(lat=48.857, lon=2.353, name="Restroom", poi_type="toilet")]
    fit_bytes = build_course_fit_bytes(coords, course_points, course_name="Test Route")

    gpx = parse_gpx(fit_route_to_gpx_bytes(fit_bytes, track_name="Test Route"))

    assert len(gpx.waypoints) == 1
    waypoint = gpx.waypoints[0]
    assert waypoint.name == "Restroom"
    assert waypoint.latitude == pytest.approx(48.857, abs=1e-4)
    assert waypoint.longitude == pytest.approx(2.353, abs=1e-4)
    # The recovered type must be exact (from the course_point_type developer
    # field), not a <sym>/<type> guess - this waypoint has neither set.
    assert infer_poi_type(waypoint) == "toilet"


def test_fit_route_to_gpx_with_no_course_points_has_no_waypoints():
    coords = [(48.8566, 2.3522), (48.857, 2.353), (48.8575, 2.354)]
    fit_bytes = build_course_fit_bytes(coords, [], course_name="Test Route")

    gpx = parse_gpx(fit_route_to_gpx_bytes(fit_bytes, track_name="Test Route"))

    assert gpx.waypoints == []
