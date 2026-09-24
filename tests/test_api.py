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
from waypointer.main import UPSTREAM_RETRY_AFTER_S, app
from waypointer.poi_db import OsmNode, PoiDbError
from waypointer.rate_limit import REQUESTS_PER_WINDOW, WINDOW_S
from waypointer.routing import ROUTING_URL

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


def test_find_pois_includes_candidate_details(sample_route_bytes, monkeypatch):
    # candidate_details carries the same tags/last_edited the OsmNode already
    # had (see poi_db.query_pois_near_route), keyed by osm_id - it's what
    # lets a route-search-found candidate's map popup show the same info as
    # a basemap-click lookup's (PoiLookupResult), rather than the bare
    # osm_id/name/distance fields Candidate itself carries.
    _stub_route_query(monkeypatch)
    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
    )
    assert response.status_code == 200
    data = response.json()
    assert {c["osm_id"] for c in data["candidates"]} == {1001}
    assert set(data["candidate_details"].keys()) == {"1001"}
    assert data["candidate_details"]["1001"] == {
        "tags": {"amenity": "drinking_water", "name": "Fontaine Wallace"},
        "last_edited": "2023-05-01T12:00:00Z",
    }


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


def _route_leg_form(profile: str = "fastbike", options: str | None = None) -> dict:
    form = {
        "start_lat": 47.376899,
        "start_lon": 8.541699,
        "end_lat": 47.38,
        "end_lon": 8.55,
        "profile": profile,
    }
    if options is not None:
        form["options"] = options
    return form


@responses.activate
def test_route_leg_returns_polyline_with_elevations(brouter_response_json):
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)
    response = client.post("/api/route-leg", data=_route_leg_form())

    assert response.status_code == 200
    data = response.json()
    assert data["coords"][0] == pytest.approx([47.376899, 8.541699])
    assert len(data["elevations"]) == len(data["coords"])
    assert data["elevations"][0] == pytest.approx(407.75)
    assert data["distance_m"] == pytest.approx(1840.0)
    assert data["surface"][0] == {"category": "paved", "distance_m": 1050.0}
    assert data["cycleway_m"] == pytest.approx(150.0)


def test_route_leg_rejects_unknown_profile():
    response = client.post("/api/route-leg", data=_route_leg_form(profile="car-fast"))
    assert response.status_code == 400


@responses.activate
def test_route_leg_forwards_routing_options(brouter_response_json):
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)
    response = client.post(
        "/api/route-leg", data=_route_leg_form(options='{"allow_steps": true, "consider_traffic": 0.5}')
    )

    assert response.status_code == 200
    sent = responses.calls[0].request.url
    assert "profile%3Aallow_steps=1" in sent
    assert "profile%3Aconsider_traffic=0.5" in sent


@pytest.mark.parametrize(
    "options",
    ["not json", "[1, 2]", '{"allow_motorways": true}', '{"allow_steps": "yes"}'],
)
def test_route_leg_rejects_invalid_options(options):
    response = client.post("/api/route-leg", data=_route_leg_form(options=options))
    assert response.status_code == 400


@responses.activate
def test_route_leg_maps_routing_failure_to_502():
    responses.add(responses.GET, ROUTING_URL, body="upstream exploded", status=500)
    response = client.post("/api/route-leg", data=_route_leg_form())
    assert response.status_code == 502


@responses.activate
def test_route_leg_passes_upstream_throttling_on_as_429():
    """A 429 from BRouter means back off, not "the service is broken" - the
    browser gets a 429 with a Retry-After so it pauses routing requests."""
    responses.add(responses.GET, ROUTING_URL, body="slow down", status=429)
    response = client.post("/api/route-leg", data=_route_leg_form())
    assert response.status_code == 429
    assert response.headers["Retry-After"] == str(UPSTREAM_RETRY_AFTER_S)


def _record_route_query_coords(monkeypatch) -> list[list[tuple[float, float]]]:
    """Like _stub_route_query, but records the route_coords each PostGIS
    query was handed - which is exactly what search_range is meant to scope."""
    received: list[list[tuple[float, float]]] = []

    def _query(poi_type, route_coords, radius_m):
        received.append([tuple(pt) for pt in route_coords])
        return _water_nodes()

    monkeypatch.setattr(main, "query_pois_near_route", _query)
    return received


FULL_ROUTE = [(48.8566, 2.3522), (48.857, 2.353), (48.8575, 2.354)]


def test_find_pois_search_range_narrows_db_query_only(sample_route_bytes, monkeypatch):
    """The whole point of search_range: the PostGIS query covers only the
    requested slice, while every distance still comes from the full route.

    Node 1001 sits by the route's *first* point, so a search_range covering
    only the last two points must leave that point out of the query - yet
    the candidate that is returned must still report a distance_from_start_m
    measured from the full route's start, not from the slice's start.
    """
    received = _record_route_query_coords(monkeypatch)
    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "poi_config": json.dumps([{"poi_type": "water", "max_distance_m": 100}]),
            "search_range": json.dumps({"start_index": 1, "end_index": 2}),
        },
    )
    assert response.status_code == 200
    assert received == [FULL_ROUTE[1:3]]

    _, expected_from_start = project_onto_polyline_m((48.8567, 2.3524), FULL_ROUTE)
    candidate = next(c for c in response.json()["candidates"] if c["osm_id"] == 1001)
    assert candidate["distance_from_start_m"] == pytest.approx(expected_from_start)


def test_find_pois_search_range_still_returns_the_whole_route_coords(
    sample_route_bytes, monkeypatch
):
    """route_coords is what the frontend draws as *the route*, so a ranged
    search must still describe the whole thing - returning the sub-range
    here would visibly truncate the map's route line after a re-search."""
    _stub_route_query(monkeypatch)
    ranged = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"search_range": json.dumps({"start_index": 2, "end_index": 2})},
    )
    whole = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
    )
    assert ranged.status_code == 200
    assert ranged.json()["route_coords"] == whole.json()["route_coords"]
    assert ranged.json()["point_count"] == whole.json()["point_count"]


def test_find_pois_without_search_range_queries_whole_route(sample_route_bytes, monkeypatch):
    received = _record_route_query_coords(monkeypatch)
    client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": "water", "max_distance_m": 100}])},
    )
    assert received == [FULL_ROUTE]


@pytest.mark.parametrize(
    "bad_range",
    [
        {"start_index": 1, "end_index": 0},
        {"start_index": -1, "end_index": 2},
        {"start_index": 0, "end_index": 99},
    ],
)
def test_find_pois_rejects_out_of_range_search_range(sample_route_bytes, bad_range, monkeypatch):
    _stub_route_query(monkeypatch)
    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"search_range": json.dumps(bad_range)},
    )
    assert response.status_code == 400


def test_find_pois_rejects_malformed_search_range(sample_route_bytes, monkeypatch):
    _stub_route_query(monkeypatch)
    response = client.post(
        "/api/find-pois/route",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"search_range": "not json"},
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
    # The whole window's budget was spent just now, so a slot frees up
    # within the window - never "retry immediately" (0) or past it.
    assert 1 <= int(resp.headers["Retry-After"]) <= WINDOW_S


@responses.activate
def test_rate_limit_buckets_are_independent(sample_route_bytes, brouter_response_json, monkeypatch):
    """Exhausting the POI search budget must leave route planning usable, and
    vice versa - the whole reason rate_limit.py keys on (bucket, ip)."""
    _stub_route_query(monkeypatch, {})
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)

    last_status = None
    for _ in range(REQUESTS_PER_WINDOW + 1):
        last_status = client.post(
            "/api/find-pois/route",
            files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        ).status_code
    assert last_status == 429

    routing_response = client.post("/api/route-leg", data=_route_leg_form())
    assert routing_response.status_code == 200


@responses.activate
def test_geocode_returns_places(photon_json):
    from waypointer.geocode import GEOCODE_URL

    responses.add(responses.GET, GEOCODE_URL, json=photon_json, status=200)
    response = client.get("/api/geocode", params={"q": "Trento", "lat": 46.07, "lon": 11.12})

    assert response.status_code == 200
    data = response.json()
    assert data[0]["name"] == "Trento"
    assert len(data[0]["bbox"]) == 4


def test_geocode_rejects_a_too_short_query():
    assert client.get("/api/geocode", params={"q": "ab"}).status_code == 400


@responses.activate
def test_geocode_maps_failure_to_502():
    from waypointer.geocode import GEOCODE_URL

    responses.add(responses.GET, GEOCODE_URL, body="busy", status=503)
    assert client.get("/api/geocode", params={"q": "Trento"}).status_code == 502


@responses.activate
def test_geocode_passes_upstream_throttling_on_as_429():
    from waypointer.geocode import GEOCODE_URL

    responses.add(responses.GET, GEOCODE_URL, body="slow down", status=429)
    response = client.get("/api/geocode", params={"q": "Trento"})
    assert response.status_code == 429
    assert response.headers["Retry-After"] == str(UPSTREAM_RETRY_AFTER_S)


def _hut_nodes() -> list[tuple[str, OsmNode]]:
    return [
        (
            "lodging",
            OsmNode(
                id=2001,
                lat=46.62,
                lon=12.30,
                tags={"tourism": "wilderness_hut", "name": "Bivacco"},
                osm_type="node",
            ),
        ),
        (
            "lodging",
            OsmNode(id=2002, lat=46.63, lon=12.31, tags={"tourism": "alpine_hut"}, osm_type="way"),
        ),
    ]


def test_map_pois_returns_pois_in_bounds(monkeypatch):
    monkeypatch.setattr(main, "query_pois_in_bounds", lambda *args, **kwargs: _hut_nodes())
    response = client.get(
        "/api/map-pois",
        params={
            "min_lat": 46.6,
            "min_lon": 12.2,
            "max_lat": 46.7,
            "max_lon": 12.4,
            "poi_types": "lodging",
        },
    )
    assert response.status_code == 200
    pois = response.json()["pois"]
    assert [p["osm_id"] for p in pois] == [2001, 2002]
    assert pois[0]["name"] == "Bivacco"
    assert pois[0]["poi_type"] == "lodging"
    # An unnamed hut is still worth drawing, so the name is simply absent.
    assert pois[1]["name"] is None
    assert pois[1]["osm_type"] == "way"


def test_map_pois_narrows_a_coarse_registry_type_to_what_it_draws(monkeypatch):
    """`lodging` is every kind of bed for searching; on the map it's huts.

    Without this the overlay would put every town hotel on a hiking map -
    and the hut that can't come from the basemap at all (OpenMapTiles has no
    wilderness_hut) would be lost among them under the row limit.
    """
    captured: dict[str, object] = {}

    def fake(poi_types, min_lat, min_lon, max_lat, max_lon, limit, tag_matches=None):
        captured["poi_types"] = poi_types
        captured["tag_matches"] = tag_matches
        captured["limit"] = limit
        return []

    monkeypatch.setattr(main, "query_pois_in_bounds", fake)
    client.get(
        "/api/map-pois",
        params={
            "min_lat": 46.6,
            "min_lon": 12.2,
            "max_lat": 46.7,
            "max_lon": 12.4,
            "poi_types": "lodging",
        },
    )
    assert captured["poi_types"] == ["lodging"]
    # Only what the basemap can't draw: OpenMapTiles has no wilderness_hut,
    # while alpine_hut reaches the tiles and is drawn from them - including
    # outside the region our own extract covers.
    assert captured["tag_matches"] == [{"tourism": "wilderness_hut"}]
    assert captured["limit"] == main.MAP_POI_LIMIT


def test_map_pois_rejects_a_viewport_too_big_to_answer(monkeypatch):
    called = False

    def fake(*args, **kwargs):
        nonlocal called
        called = True
        return []

    monkeypatch.setattr(main, "query_pois_in_bounds", fake)
    response = client.get(
        "/api/map-pois",
        params={
            "min_lat": 40.0,
            "min_lon": 2.0,
            "max_lat": 48.0,
            "max_lon": 12.0,
            "poi_types": "lodging",
        },
    )
    assert response.status_code == 400
    # The point is to never reach PostGIS with a continent-sized box.
    assert not called


def test_map_pois_rejects_unknown_and_unsearchable_types():
    for poi_type in ("bogus", "warning"):
        response = client.get(
            "/api/map-pois",
            params={
                "min_lat": 46.6,
                "min_lon": 12.2,
                "max_lat": 46.7,
                "max_lon": 12.4,
                "poi_types": poi_type,
            },
        )
        assert response.status_code == 400, poi_type


def test_map_pois_surfaces_a_db_failure_as_502(monkeypatch):
    def boom(*args, **kwargs):
        raise main.PoiDbError("down")

    monkeypatch.setattr(main, "query_pois_in_bounds", boom)
    response = client.get(
        "/api/map-pois",
        params={
            "min_lat": 46.6,
            "min_lon": 12.2,
            "max_lat": 46.7,
            "max_lon": 12.4,
            "poi_types": "lodging",
        },
    )
    assert response.status_code == 502
