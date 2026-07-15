from waypointer.device_profiles import DEVICE_PROFILES
from waypointer.gpx_io import (
    OSM_ID_CLARK_TAG,
    add_waypoints,
    discard_waypoints,
    existing_osm_ids,
    is_duplicate_candidate,
    make_waypoint,
    parse_gpx,
    route_coordinates,
    to_xml_bytes,
)
from waypointer.osm import OsmNode


def test_route_coordinates_flattens_track(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    assert route_coordinates(gpx) == [
        (48.8566, 2.3522),
        (48.857, 2.353),
        (48.8575, 2.354),
    ]


def test_round_trip_preserves_original_and_adds_new_waypoint(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    original_track_points = [(p.latitude, p.longitude) for p in gpx.tracks[0].segments[0].points]
    original_waypoint_ext_tag = gpx.waypoints[0].extensions[0].tag

    node = OsmNode(id=42, lat=48.8567, lon=2.3524, tags={"name": "Fontaine Wallace"})
    waypoint = make_waypoint(node, DEVICE_PROFILES["generic"], distance_m=12.3)
    add_waypoints(gpx, [waypoint])

    reparsed = parse_gpx(to_xml_bytes(gpx))

    reparsed_track_points = [(p.latitude, p.longitude) for p in reparsed.tracks[0].segments[0].points]
    assert reparsed_track_points == original_track_points

    existing_wpt = next(w for w in reparsed.waypoints if w.name == "Existing WPT")
    assert existing_wpt.extensions[0].tag == original_waypoint_ext_tag

    new_wpt = next(w for w in reparsed.waypoints if w.name == "Fontaine Wallace")
    assert new_wpt.symbol == "Water"
    assert new_wpt.latitude == 48.8567
    assert new_wpt.longitude == 2.3524
    assert any(ext.tag == OSM_ID_CLARK_TAG and ext.text == "42" for ext in new_wpt.extensions)


def test_existing_osm_ids_detects_marker(sample_route_bytes):
    # Marker tags only resolve to their namespaced form after an XML
    # round-trip, which mirrors real usage: every request starts from a
    # freshly parse_gpx()'d upload, never an in-memory-only GPX object.
    gpx = parse_gpx(sample_route_bytes)
    node = OsmNode(id=99, lat=48.0, lon=2.0, tags={})
    add_waypoints(gpx, [make_waypoint(node, DEVICE_PROFILES["generic"], distance_m=1.0)])
    reparsed = parse_gpx(to_xml_bytes(gpx))
    assert 99 in existing_osm_ids(reparsed)


def test_is_duplicate_candidate_by_marker(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    node = OsmNode(id=7, lat=48.1, lon=2.1, tags={})
    add_waypoints(gpx, [make_waypoint(node, DEVICE_PROFILES["generic"], distance_m=1.0)])
    reparsed = parse_gpx(to_xml_bytes(gpx))
    # Same osm id but reported at a different location (e.g. OSM data
    # shifted slightly) must still be caught via the stored id, isolating
    # this from the separate proximity-fallback path.
    same_id_different_location = OsmNode(id=7, lat=48.2, lon=2.2, tags={})
    assert is_duplicate_candidate(same_id_different_location, reparsed) is True


def test_discard_waypoints_removes_by_original_index(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    assert len(gpx.waypoints) == 1

    discard_waypoints(gpx, {0})

    assert gpx.waypoints == []


def test_discard_waypoints_no_op_for_empty_set(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    original = list(gpx.waypoints)

    discard_waypoints(gpx, set())

    assert gpx.waypoints == original


def test_discard_waypoints_runs_before_add_waypoints(sample_route_bytes):
    # Indices refer to the pre-discard, original document order - discarding
    # must happen before any new waypoints are appended, or a discard index
    # could accidentally land on a freshly added waypoint instead.
    gpx = parse_gpx(sample_route_bytes)
    discard_waypoints(gpx, {0})
    node = OsmNode(id=1, lat=48.0, lon=2.0, tags={"name": "New Fountain"})
    add_waypoints(gpx, [make_waypoint(node, DEVICE_PROFILES["generic"], distance_m=1.0)])

    assert [w.name for w in gpx.waypoints] == ["New Fountain"]


def test_is_duplicate_candidate_by_proximity_fallback(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    close_node = OsmNode(id=555, lat=48.86001, lon=2.36001, tags={})
    far_node = OsmNode(id=556, lat=48.9, lon=2.5, tags={})
    assert is_duplicate_candidate(close_node, gpx) is True
    assert is_duplicate_candidate(far_node, gpx) is False
