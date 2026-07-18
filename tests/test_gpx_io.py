import gpxpy
import pytest

from waypointer.gpx_io import (
    OSM_ID_CLARK_TAG,
    add_waypoints,
    discard_waypoints,
    existing_osm_ids,
    infer_poi_type,
    is_duplicate_candidate,
    make_waypoint,
    parse_gpx,
    route_coordinates,
    route_elevations,
    stamp_poi_type,
    to_xml_bytes,
    total_ascent_m,
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
    waypoint = make_waypoint(node, "Water", distance_m=12.3)
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
    add_waypoints(gpx, [make_waypoint(node, "Water", distance_m=1.0)])
    reparsed = parse_gpx(to_xml_bytes(gpx))
    assert 99 in existing_osm_ids(reparsed)


def test_is_duplicate_candidate_by_marker(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    node = OsmNode(id=7, lat=48.1, lon=2.1, tags={})
    add_waypoints(gpx, [make_waypoint(node, "Water", distance_m=1.0)])
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
    add_waypoints(gpx, [make_waypoint(node, "Water", distance_m=1.0)])

    assert [w.name for w in gpx.waypoints] == ["New Fountain"]


def test_route_elevations_parallels_route_coordinates(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    assert route_elevations(gpx) == [35.0, 36.0, 37.0]
    assert len(route_elevations(gpx)) == len(route_coordinates(gpx))


def test_total_ascent_sums_positive_deltas(sample_route_bytes):
    # sample_route.gpx's three trkpts have ele 35.0 -> 36.0 -> 37.0.
    gpx = parse_gpx(sample_route_bytes)
    assert total_ascent_m(gpx) == pytest.approx(2.0)


def test_total_ascent_ignores_descents():
    gpx = gpxpy.parse(
        """<?xml version="1.0"?>
        <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <trk><trkseg>
            <trkpt lat="48.0" lon="2.0"><ele>100.0</ele></trkpt>
            <trkpt lat="48.001" lon="2.0"><ele>90.0</ele></trkpt>
            <trkpt lat="48.002" lon="2.0"><ele>105.0</ele></trkpt>
          </trkseg></trk>
        </gpx>"""
    )
    assert total_ascent_m(gpx) == pytest.approx(15.0)


def test_total_ascent_zero_when_no_elevation_data():
    gpx = gpxpy.parse(
        """<?xml version="1.0"?>
        <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <trk><trkseg>
            <trkpt lat="48.0" lon="2.0"></trkpt>
            <trkpt lat="48.001" lon="2.0"></trkpt>
          </trkseg></trk>
        </gpx>"""
    )
    assert total_ascent_m(gpx) == 0.0


def test_total_ascent_skips_gap_around_missing_elevation():
    # A point with no elevation shouldn't be bridged over - the delta across
    # it must be skipped rather than treated as adjacent to its neighbors.
    gpx = gpxpy.parse(
        """<?xml version="1.0"?>
        <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <trk><trkseg>
            <trkpt lat="48.0" lon="2.0"><ele>10.0</ele></trkpt>
            <trkpt lat="48.001" lon="2.0"></trkpt>
            <trkpt lat="48.002" lon="2.0"><ele>500.0</ele></trkpt>
          </trkseg></trk>
        </gpx>"""
    )
    assert total_ascent_m(gpx) == 0.0


def test_infer_poi_type_from_osm_id_marker(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    node = OsmNode(id=42, lat=48.0, lon=2.0, tags={"name": "Fontaine Wallace"})
    add_waypoints(gpx, [make_waypoint(node, "Water", distance_m=1.0)])
    reparsed = parse_gpx(to_xml_bytes(gpx))
    new_wpt = next(w for w in reparsed.waypoints if w.name == "Fontaine Wallace")
    assert infer_poi_type(new_wpt) == "water"


def test_infer_poi_type_from_symbol_hint(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    existing_wpt = next(w for w in gpx.waypoints if w.name == "Existing WPT")
    existing_wpt.symbol = "Drinking Water"
    assert infer_poi_type(existing_wpt) == "water"


def test_infer_poi_type_defaults_to_generic_when_unmatched(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    existing_wpt = next(w for w in gpx.waypoints if w.name == "Existing WPT")
    assert infer_poi_type(existing_wpt) == "generic"


def test_infer_poi_type_poi_type_marker_wins_over_osm_id_and_sym_hints(sample_route_bytes):
    # A stamped poi_type marker is authoritative - it must win even when the
    # waypoint also has the osm_id marker (which would otherwise imply
    # "water") and a <sym> that would otherwise sym-hint-match "water".
    gpx = parse_gpx(sample_route_bytes)
    node = OsmNode(id=42, lat=48.0, lon=2.0, tags={"name": "Fontaine Wallace"})
    waypoint = make_waypoint(node, "Water", distance_m=1.0)
    waypoint.symbol = "Drinking Water"
    stamp_poi_type(waypoint, "toilet")
    add_waypoints(gpx, [waypoint])
    reparsed = parse_gpx(to_xml_bytes(gpx))
    new_wpt = next(w for w in reparsed.waypoints if w.name == "Fontaine Wallace")
    assert infer_poi_type(new_wpt) == "toilet"


def test_is_duplicate_candidate_by_proximity_fallback(sample_route_bytes):
    gpx = parse_gpx(sample_route_bytes)
    close_node = OsmNode(id=555, lat=48.86001, lon=2.36001, tags={})
    far_node = OsmNode(id=556, lat=48.9, lon=2.5, tags={})
    assert is_duplicate_candidate(close_node, gpx) is True
    assert is_duplicate_candidate(far_node, gpx) is False
