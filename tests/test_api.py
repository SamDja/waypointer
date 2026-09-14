import base64
import json
import time

import gpxpy
import pytest
import responses
from fastapi.testclient import TestClient
from fit_tool.fit_file import FitFile
from fit_tool.profile.messages.course_message import CourseMessage
from fit_tool.profile.messages.course_point_message import CoursePointMessage

from waypointer import main, poi_types
from waypointer.fit_io import build_course_fit_bytes
from waypointer.geometry import project_onto_polyline_m
from waypointer.main import app
from waypointer.poi_db import OsmNode, PoiDbError
from waypointer.rate_limit import REQUESTS_PER_WINDOW

client = TestClient(app)


def _water_nodes() -> list[OsmNode]:
    """Stand-in for what query_pois_near_route would return from the
    PostGIS pois table for poi_type="water" - mirrors the two nodes the old
    Overpass response fixture carried (one essentially on the route, one
    ~400m away that the authoritative distance check must still exclude)."""
    return [
        OsmNode(
            id=1001,
            lat=48.8567,
            lon=2.3524,
            tags={"amenity": "drinking_water", "name": "Fontaine Wallace"},
            timestamp="2023-05-01T12:00:00Z",
        ),
        OsmNode(id=1002, lat=48.8600, lon=2.3600, tags={"amenity": "drinking_water"}),
    ]


def _stub_route_query(monkeypatch, nodes_by_type: dict[str, list[OsmNode]] | None = None, **kwargs):
    """Monkeypatches main.query_pois_near_route with a fake that returns
    nodes_by_type[poi_type] (defaulting to _water_nodes() for every type,
    matching the old Overpass fixture's behavior of responding identically
    regardless of the query it was sent - a mocking artifact, not real
    per-type filtering). Returns the list of (poi_type, radius_m) calls
    made, for tests that need to assert on what was requested."""
    calls: list[tuple[str, float]] = []

    def _query(poi_type, route_coords, radius_m):
        calls.append((poi_type, radius_m))
        if nodes_by_type is not None:
            return nodes_by_type.get(poi_type, [])
        return _water_nodes()

    monkeypatch.setattr(main, "query_pois_near_route", _query)
    return calls


def test_find_pois_defaults_to_default_visible_types(sample_route_bytes, monkeypatch):
    # No poi_config form field sent - exercises the endpoint's default
    # fallback (DEFAULT_VISIBLE_POI_TYPES, each at its registry
    # default_max_distance_m).
    _stub_route_query(monkeypatch)
    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["point_count"] == 3
    route_coords = [(48.8566, 2.3522), (48.857, 2.353), (48.8575, 2.354)]
    distance_from_route_m, distance_from_start_m = project_onto_polyline_m((48.86, 2.36), route_coords)
    assert data["existing_waypoints"] == [
        {
            "index": 0,
            "name": "Existing WPT",
            "lat": 48.86,
            "lon": 2.36,
            "poi_type": "generic",
            "distance_from_route_m": pytest.approx(distance_from_route_m),
            "distance_from_start_m": pytest.approx(distance_from_start_m),
        }
    ]
    # node 1002 (~400m away) must be excluded by the authoritative distance
    # check for every default type queried.
    assert {c["osm_id"] for c in data["candidates"]} == {1001}
    assert {c["poi_type"] for c in data["candidates"]} == set(poi_types.DEFAULT_VISIBLE_POI_TYPES)
    assert data["route_coords"]
    assert all(len(pt) == 2 for pt in data["route_coords"])
    assert data["failed_poi_types"] == []


def test_find_pois_rejects_invalid_gpx():
    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("bad.gpx", b"not xml", "application/gpx+xml")},
    )
    assert response.status_code == 400


def test_find_pois_rejects_unknown_poi_type(sample_route_bytes):
    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": "bogus", "max_distance_m": 50}])},
    )
    assert response.status_code == 400


def test_find_poi_at_location_returns_nearest_node(monkeypatch):
    monkeypatch.setattr(main, "query_poi_near_point", lambda poi_type, lat, lon, radius_m: _water_nodes()[0])
    response = client.post(
        "/api/find-pois/location",
        data={"lat": 48.8567, "lon": 2.3524, "poi_type": "water"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["osm_id"] == 1001
    assert data["osm_type"] == "node"
    assert data["poi_type"] == "water"
    assert data["name"] == "Fontaine Wallace"
    assert data["tags"] == {"amenity": "drinking_water", "name": "Fontaine Wallace"}
    assert data["last_edited"] == "2023-05-01T12:00:00Z"


def test_find_poi_at_location_returns_404_when_nothing_found(monkeypatch):
    monkeypatch.setattr(main, "query_poi_near_point", lambda poi_type, lat, lon, radius_m: None)
    response = client.post(
        "/api/find-pois/location",
        data={"lat": 48.8567, "lon": 2.3524, "poi_type": "water"},
    )
    assert response.status_code == 404


def test_find_poi_at_location_rejects_non_searchable_poi_type():
    response = client.post(
        "/api/find-pois/location",
        data={"lat": 48.8567, "lon": 2.3524, "poi_type": "warning"},
    )
    assert response.status_code == 400


def test_find_poi_at_location_rejects_unknown_poi_type():
    response = client.post(
        "/api/find-pois/location",
        data={"lat": 48.8567, "lon": 2.3524, "poi_type": "bogus"},
    )
    assert response.status_code == 400


def test_find_pois_queries_at_the_clamped_radius(sample_route_bytes, monkeypatch):
    calls = _stub_route_query(monkeypatch)
    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": "water", "max_distance_m": 99999}])},
    )
    assert response.status_code == 200
    # No Overpass-style radius padding needed anymore - query_pois_near_route
    # runs directly against the full-resolution route, so it's called with
    # exactly the clamped max_distance_m, not padded by SIMPLIFY_TOLERANCE_M.
    assert calls == [("water", poi_types.POI_TYPES["water"].max_distance_m)]


def test_find_pois_uses_nearest_way_vertex_not_far_centroid(sample_route_bytes, monkeypatch):
    # Regression test for the "malga mapped as a way" bug: a way/relation's
    # bounding-box centroid can sit far from the route even when one of its
    # own vertices is genuinely close (e.g. a large park with just one
    # corner near the route). The candidate must be positioned at the near
    # vertex - the one within radius - not the far one.
    near_point = (48.857, 2.35301)  # a few meters from the route
    far_point = (49.5, 3.5)  # far outside any reasonable radius
    way_node = OsmNode(
        id=175901590,
        lat=far_point[0],
        lon=far_point[1],
        tags={"amenity": "drinking_water"},
        osm_type="way",
        way_points=[far_point, near_point],
    )
    _stub_route_query(monkeypatch, {"water": [way_node]})
    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": "water", "max_distance_m": 50}])},
    )
    assert response.status_code == 200
    data = response.json()
    assert [c["osm_id"] for c in data["candidates"]] == [175901590]
    candidate = data["candidates"][0]
    assert candidate["lat"] == pytest.approx(near_point[0])
    assert candidate["lon"] == pytest.approx(near_point[1])


def test_find_pois_small_radius_still_finds_close_node(sample_route_bytes, monkeypatch):
    # Regression test: at a small requested radius, a node essentially on
    # the route must still be found by the authoritative distance check -
    # and query_pois_near_route must be called with that exact radius, not
    # padded (the old Overpass-based padding workaround no longer applies;
    # see poi_db.query_pois_near_route's docstring).
    calls = _stub_route_query(monkeypatch)
    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": "water", "max_distance_m": 1}])},
    )
    assert response.status_code == 200
    assert calls == [("water", 1.0)]

    data = response.json()
    # node 1001 sits essentially on the route (see _water_nodes above) so it
    # must still be found even at this tight a requested radius.
    assert [c["osm_id"] for c in data["candidates"]] == [1001]


def test_find_pois_handles_multiple_poi_types(sample_route_bytes, monkeypatch):
    # Injects a second, fake POI type for the duration of this test only
    # (not a real registry entry) to prove the find_pois loop handles more
    # than one requested type: two separate PostGIS queries, correct
    # poi_type tagging per candidate, and a merged/sorted result.
    monkeypatch.setitem(
        poi_types.POI_TYPES,
        "bench",
        poi_types.PoiTypeConfig(
            key="bench",
            label="Benches",
            course_point_type=0,
            tag_filter='node["amenity"="bench"]',
            default_max_distance_m=20.0,
            min_distance_m=10.0,
            max_distance_m=500.0,
            default_name="Bench",
        ),
    )
    bench_node = OsmNode(id=2001, lat=48.8567, lon=2.3524, tags={"amenity": "bench"})
    calls = _stub_route_query(monkeypatch, {"water": _water_nodes(), "bench": [bench_node]})

    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "poi_config": json.dumps(
                [
                    {"poi_type": "water", "max_distance_m": 10},
                    {"poi_type": "bench", "max_distance_m": 20},
                ]
            )
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert len(calls) == 2
    found_types = {c["poi_type"] for c in data["candidates"]}
    assert found_types == {"water", "bench"}


def _register_fake_poi_types(monkeypatch, count: int) -> list[str]:
    keys = [f"fake_type_{i}" for i in range(count)]
    for key in keys:
        monkeypatch.setitem(
            poi_types.POI_TYPES,
            key,
            poi_types.PoiTypeConfig(
                key=key,
                label=key,
                course_point_type=0,
                tag_filter=f'node["fake"="{key}"]',
                default_max_distance_m=20.0,
                min_distance_m=10.0,
                max_distance_m=500.0,
                default_name=key,
            ),
        )
    return keys


def test_find_pois_calls_are_concurrent_not_sequential(sample_route_bytes, monkeypatch):
    # Registers several fake POI types whose stubbed PostGIS queries each
    # sleep briefly - if find_pois still queried sequentially, total wall
    # time would be roughly num_types * SLEEP_S; run concurrently via
    # asyncio.to_thread, it should be much closer to a single SLEEP_S.
    num_types = 4
    sleep_s = 0.2
    keys = _register_fake_poi_types(monkeypatch, num_types)
    calls: list[str] = []

    def _slow_query(poi_type, route_coords, radius_m):
        calls.append(poi_type)
        time.sleep(sleep_s)
        return []

    monkeypatch.setattr(main, "query_pois_near_route", _slow_query)

    start = time.monotonic()
    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": k, "max_distance_m": 20} for k in keys])},
    )
    elapsed = time.monotonic() - start

    assert response.status_code == 200
    assert len(calls) == num_types
    # Sequential would take >= num_types * sleep_s; concurrent should stay
    # well under half that, with generous margin for test-environment noise.
    assert elapsed < num_types * sleep_s * 0.6


def test_find_pois_one_type_failure_does_not_block_others(sample_route_bytes, monkeypatch):
    keys = _register_fake_poi_types(monkeypatch, 1)
    failing_key = keys[0]

    def _query(poi_type, route_coords, radius_m):
        if poi_type == failing_key:
            raise PoiDbError("PostGIS down")
        return _water_nodes()

    monkeypatch.setattr(main, "query_pois_near_route", _query)

    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "poi_config": json.dumps(
                [
                    {"poi_type": "water", "max_distance_m": 10},
                    {"poi_type": failing_key, "max_distance_m": 20},
                ]
            )
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert {c["poi_type"] for c in data["candidates"]} == {"water"}
    assert [f["poi_type"] for f in data["failed_poi_types"]] == [failing_key]
    assert data["failed_poi_types"][0]["error"]


def test_find_pois_all_types_fail_returns_502(sample_route_bytes, monkeypatch):
    keys = _register_fake_poi_types(monkeypatch, 2)

    def _query(poi_type, route_coords, radius_m):
        raise PoiDbError("PostGIS down")

    monkeypatch.setattr(main, "query_pois_near_route", _query)

    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": k, "max_distance_m": 20} for k in keys])},
    )
    assert response.status_code == 502


def test_save_generic_round_trip(sample_route_bytes):
    selected = json.dumps(
        [
            {
                "osm_id": 1001,
                "poi_type": "water",
                "name": "Fontaine Wallace",
                "lat": 48.8567,
                "lon": 2.3524,
                "distance_m": 12.0,
                "distance_from_start_m": 34.0,
            }
        ]
    )
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "selected_candidates": selected,
            "device": "generic",
        },
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/gpx+xml")
    assert "route_waypoints.gpx" in response.headers["content-disposition"]
    assert b"Fontaine Wallace" in response.content
    # No explicit symbols form field - falls back to POI_TYPES["water"]'s
    # default_gpx_symbol.
    assert b"<sym>Water</sym>" in response.content


def test_save_keeps_existing_waypoints_by_default(sample_route_bytes):
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"selected_candidates": "[]", "device": "generic"},
    )
    assert response.status_code == 200
    assert b"Existing WPT" in response.content


def test_save_generic_applies_per_type_symbol_overrides(sample_route_bytes):
    # sample_route.gpx's one pre-existing waypoint has no <sym>/type marker,
    # so it infers as "generic" unless existing_waypoint_types overrides it.
    selected = json.dumps(
        [
            {
                "osm_id": 1001,
                "poi_type": "water",
                "name": "Fontaine Wallace",
                "lat": 48.8567,
                "lon": 2.3524,
                "distance_m": 12.0,
                "distance_from_start_m": 34.0,
            }
        ]
    )
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "selected_candidates": selected,
            "device": "generic",
            "symbols": json.dumps({"water": "Potable Water", "generic": "Misc"}),
        },
    )
    assert response.status_code == 200
    assert b"<sym>Potable Water</sym>" in response.content
    assert b"<sym>Misc</sym>" in response.content


def test_save_discards_selected_existing_waypoints(sample_route_bytes):
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "selected_candidates": "[]",
            "device": "generic",
            "discarded_waypoint_indices": json.dumps([0]),
        },
    )
    assert response.status_code == 200
    assert b"Existing WPT" not in response.content


def test_save_rejects_invalid_discarded_indices_json(sample_route_bytes):
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "selected_candidates": "[]",
            "device": "generic",
            "discarded_waypoint_indices": "not json",
        },
    )
    assert response.status_code == 400


def test_save_gpx_rejects_invalid_selection_json(sample_route_bytes):
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"selected_candidates": "not json", "device": "generic"},
    )
    assert response.status_code == 400


def test_save_wahoo_returns_fit_file(sample_route_bytes):
    selected = json.dumps(
        [
            {
                "osm_id": 1001,
                "poi_type": "water",
                "name": "Fontaine Wallace",
                "lat": 48.8567,
                "lon": 2.3524,
                "distance_m": 12.0,
                "distance_from_start_m": 34.0,
            }
        ]
    )
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"selected_candidates": selected, "device": "wahoo_elemnt_roam_v3"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert "route_waypoints.fit" in response.headers["content-disposition"]

    fit_file = FitFile.from_bytes(response.content)
    messages = [r.message for r in fit_file.records if not r.is_definition]
    course_point = next(m for m in messages if isinstance(m, CoursePointMessage))
    assert course_point.developer_fields[0].name == "course_point_type"
    assert course_point.developer_fields[0].get_value(0) == 16


def test_save_wahoo_includes_kept_existing_waypoint_with_assigned_type(sample_route_bytes):
    # sample_route.gpx's fixture has one pre-existing waypoint ("Existing
    # WPT") at index 0 - the visitor assigns it "toilet" via
    # AssignWaypointTypesDialog, and it must show up as a second course
    # point (kept, not discarded) with toilet's course_point_type, right
    # alongside the newly-selected water candidate.
    selected = json.dumps(
        [
            {
                "osm_id": 1001,
                "poi_type": "water",
                "name": "Fontaine Wallace",
                "lat": 48.8567,
                "lon": 2.3524,
                "distance_m": 12.0,
                "distance_from_start_m": 34.0,
            }
        ]
    )
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "selected_candidates": selected,
            "device": "wahoo_elemnt_roam_v3",
            "existing_waypoint_types": json.dumps({"0": "toilet"}),
        },
    )
    assert response.status_code == 200

    fit_file = FitFile.from_bytes(response.content)
    messages = [r.message for r in fit_file.records if not r.is_definition]
    course_points = [m for m in messages if isinstance(m, CoursePointMessage)]
    assert len(course_points) == 2
    assert course_points[0].developer_fields[0].get_value(0) == 16  # water
    assert course_points[1].developer_fields[0].get_value(0) == 59  # toilet
    assert course_points[1].course_point_name == "Existing WPT"


def test_save_wahoo_excludes_discarded_existing_waypoint(sample_route_bytes):
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "selected_candidates": "[]",
            "device": "wahoo_elemnt_roam_v3",
            "discarded_waypoint_indices": "[0]",
            "existing_waypoint_types": json.dumps({"0": "toilet"}),
        },
    )
    assert response.status_code == 200

    fit_file = FitFile.from_bytes(response.content)
    messages = [r.message for r in fit_file.records if not r.is_definition]
    assert not any(isinstance(m, CoursePointMessage) for m in messages)


def test_save_honors_custom_route_name(sample_route_bytes):
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"selected_candidates": "[]", "device": "generic", "route_name": "My Weekend Ride!"},
    )
    assert response.status_code == 200
    # The download filename is sanitized for filesystem safety - non-
    # alphanumeric runs become a single underscore.
    assert "My_Weekend_Ride_waypoints.gpx" in response.headers["content-disposition"]


def test_save_wahoo_course_name_preserves_custom_route_name(sample_route_bytes):
    # Unlike the download filename above, the FIT course_name (shown
    # on-device) must keep the name as typed - spaces included.
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "selected_candidates": "[]",
            "device": "wahoo_elemnt_roam_v3",
            "route_name": "My Weekend Ride!",
        },
    )
    assert response.status_code == 200
    assert "My_Weekend_Ride_waypoints.fit" in response.headers["content-disposition"]

    fit_file = FitFile.from_bytes(response.content)
    messages = [r.message for r in fit_file.records if not r.is_definition]
    course = next(m for m in messages if isinstance(m, CourseMessage))
    assert course.course_name == "My Weekend Ride!"


def test_save_rejects_unknown_device(sample_route_bytes):
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"selected_candidates": "[]", "device": "nonexistent"},
    )
    assert response.status_code == 400


def test_wahoo_route_payload_returns_fit_and_metadata(sample_route_bytes):
    selected = json.dumps(
        [
            {
                "osm_id": 1001,
                "poi_type": "water",
                "name": "Fontaine Wallace",
                "lat": 48.8567,
                "lon": 2.3524,
                "distance_m": 12.0,
                "distance_from_start_m": 34.0,
            }
        ]
    )
    response = client.post(
        "/api/wahoo/route-payload",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"selected_candidates": selected},
    )
    assert response.status_code == 200
    data = response.json()

    assert data["filename"] == "route.fit"
    # sample_route.gpx's three trkpts have ele 35.0 -> 36.0 -> 37.0.
    assert data["ascent_m"] == pytest.approx(2.0)
    assert data["distance_m"] > 0
    assert data["start_lat"] == pytest.approx(48.8566)
    assert data["start_lng"] == pytest.approx(2.3522)

    fit_bytes = base64.b64decode(data["fit_base64"])
    fit_file = FitFile.from_bytes(fit_bytes)
    messages = [r.message for r in fit_file.records if not r.is_definition]
    course_point = next(m for m in messages if isinstance(m, CoursePointMessage))
    assert course_point.developer_fields[0].get_value(0) == 16


def test_wahoo_route_payload_includes_kept_existing_waypoint_with_assigned_type(sample_route_bytes):
    response = client.post(
        "/api/wahoo/route-payload",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "selected_candidates": "[]",
            "existing_waypoint_types": json.dumps({"0": "toilet"}),
        },
    )
    assert response.status_code == 200
    data = response.json()

    fit_bytes = base64.b64decode(data["fit_base64"])
    fit_file = FitFile.from_bytes(fit_bytes)
    messages = [r.message for r in fit_file.records if not r.is_definition]
    course_point = next(m for m in messages if isinstance(m, CoursePointMessage))
    assert course_point.developer_fields[0].get_value(0) == 59  # toilet


def test_wahoo_route_payload_excludes_discarded_existing_waypoint(sample_route_bytes):
    response = client.post(
        "/api/wahoo/route-payload",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"selected_candidates": "[]", "discarded_waypoint_indices": "[0]"},
    )
    assert response.status_code == 200
    data = response.json()

    fit_bytes = base64.b64decode(data["fit_base64"])
    fit_file = FitFile.from_bytes(fit_bytes)
    messages = [r.message for r in fit_file.records if not r.is_definition]
    assert not any(isinstance(m, CoursePointMessage) for m in messages)


def test_wahoo_route_payload_honors_custom_route_name(sample_route_bytes):
    response = client.post(
        "/api/wahoo/route-payload",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"selected_candidates": "[]", "route_name": "My Weekend Ride!"},
    )
    assert response.status_code == 200
    data = response.json()
    # filename is sanitized for filesystem safety...
    assert data["filename"] == "My_Weekend_Ride.fit"
    # ...but route_name (Wahoo's display title) preserves the typed name as-is.
    assert data["route_name"] == "My Weekend Ride!"

    fit_bytes = base64.b64decode(data["fit_base64"])
    fit_file = FitFile.from_bytes(fit_bytes)
    messages = [r.message for r in fit_file.records if not r.is_definition]
    course = next(m for m in messages if isinstance(m, CourseMessage))
    # The FIT course_name (shown on-device) is likewise unsanitized.
    assert course.course_name == "My Weekend Ride!"


def test_wahoo_route_payload_rejects_invalid_selection_json(sample_route_bytes):
    response = client.post(
        "/api/wahoo/route-payload",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"selected_candidates": "not json"},
    )
    assert response.status_code == 400


def test_wahoo_route_payload_rejects_invalid_gpx():
    response = client.post(
        "/api/wahoo/route-payload",
        files={"gpx_file": ("bad.gpx", b"not xml", "application/gpx+xml")},
        data={"selected_candidates": "[]"},
    )
    assert response.status_code == 400


WAHOO_FILE_URL = "https://cdn.wahooligan.com/uploads/route/file/abc/route.fit"


@responses.activate
def test_wahoo_import_route_converts_fit_to_gpx():
    coords = [(48.8566, 2.3522), (48.857, 2.353), (48.8575, 2.354)]
    fit_bytes = build_course_fit_bytes(coords, [], course_name="Imported", elevations_m=[35.0, 36.0, 37.0])
    responses.add(responses.GET, WAHOO_FILE_URL, body=fit_bytes, status=200)

    response = client.post("/api/wahoo/import-route", data={"file_url": WAHOO_FILE_URL})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/gpx+xml")
    gpx = gpxpy.parse(response.content.decode("utf-8"))
    points = [p for t in gpx.tracks for s in t.segments for p in s.points]
    assert len(points) == 3
    assert points[0].latitude == pytest.approx(48.8566, abs=1e-4)


def test_wahoo_import_route_rejects_non_wahoo_host():
    response = client.post(
        "/api/wahoo/import-route",
        data={"file_url": "https://evil.example.com/route.fit"},
    )
    assert response.status_code == 400


def test_wahoo_import_route_rejects_lookalike_host():
    # A host that merely contains the suffix as a substring (not a real
    # subdomain) must not slip past the endswith guard.
    response = client.post(
        "/api/wahoo/import-route",
        data={"file_url": "https://wahooligan.com.evil.example.com/route.fit"},
    )
    assert response.status_code == 400


def test_rate_limit_blocks_after_threshold(sample_route_bytes, monkeypatch):
    _stub_route_query(monkeypatch, {})
    last_status = None
    for _ in range(REQUESTS_PER_WINDOW + 1):
        resp = client.post(
            "/api/find-pois/route",
            files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        )
        last_status = resp.status_code
    assert last_status == 429
