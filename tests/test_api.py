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

from waypointer import poi_types
from waypointer.fit_io import build_course_fit_bytes
from waypointer.geometry import project_onto_polyline_m
from waypointer.main import app
from waypointer.osm import OVERPASS_URL
from waypointer.rate_limit import (
    OVERPASS_REQUESTS_PER_WINDOW,
    ROUTING_REQUESTS_PER_WINDOW,
)
from waypointer.routing import ROUTING_URL

client = TestClient(app)


@responses.activate
def test_find_pois_defaults_to_default_visible_types(sample_route_bytes, overpass_response_json):
    # No poi_config form field sent - exercises the endpoint's default
    # fallback (DEFAULT_VISIBLE_POI_TYPES, each at its registry default_max_distance_m).
    # The mock responds identically to all 6 default types' Overpass queries,
    # so node 1001 comes back once per type rather than just for water - a
    # test-mocking artifact (real Overpass queries differ per tag_filter),
    # not a real dedup bug.
    responses.add(responses.POST, OVERPASS_URL, json=overpass_response_json, status=200)
    response = client.post(
        "/api/find-pois",
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
        "/api/find-pois",
        files={"gpx_file": ("bad.gpx", b"not xml", "application/gpx+xml")},
    )
    assert response.status_code == 400


def test_find_pois_rejects_unknown_poi_type(sample_route_bytes):
    response = client.post(
        "/api/find-pois",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": "bogus", "max_distance_m": 50}])},
    )
    assert response.status_code == 400


@responses.activate
def test_find_pois_clamps_out_of_range_distance(sample_route_bytes, overpass_response_json):
    responses.add(responses.POST, OVERPASS_URL, json=overpass_response_json, status=200)
    response = client.post(
        "/api/find-pois",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": "water", "max_distance_m": 99999}])},
    )
    assert response.status_code == 200
    sent_query = responses.calls[0].request.body
    if isinstance(sent_query, bytes):
        sent_query = sent_query.decode()
    # The Overpass-side radius is the clamped max_distance_m padded by
    # SIMPLIFY_TOLERANCE_M (see main.py) to avoid missing genuinely
    # in-range nodes on the simplified route.
    from waypointer.main import SIMPLIFY_TOLERANCE_M

    expected_radius = int(poi_types.POI_TYPES["water"].max_distance_m + SIMPLIFY_TOLERANCE_M)
    assert f"around:{expected_radius}," in sent_query


@responses.activate
def test_find_pois_small_radius_still_finds_close_node(sample_route_bytes, overpass_response_json):
    # Regression test: at a small requested radius, the Overpass query must
    # still be built with enough padding (SIMPLIFY_TOLERANCE_M) over the
    # simplified route to find a node the full-resolution check confirms is
    # genuinely within range - without that padding, Overpass's own "around"
    # search (run against the simplified, not full-resolution, route) can
    # exclude a genuinely close node before the authoritative check ever
    # sees it.
    from waypointer.main import SIMPLIFY_TOLERANCE_M

    responses.add(responses.POST, OVERPASS_URL, json=overpass_response_json, status=200)
    response = client.post(
        "/api/find-pois",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": "water", "max_distance_m": 1}])},
    )
    assert response.status_code == 200
    sent_query = responses.calls[0].request.body
    if isinstance(sent_query, bytes):
        sent_query = sent_query.decode()
    assert f"around:{int(1 + SIMPLIFY_TOLERANCE_M)}," in sent_query

    data = response.json()
    # node 1001 sits essentially on the route (see conftest fixtures) so it
    # must still be found even at this tight a requested radius.
    assert [c["osm_id"] for c in data["candidates"]] == [1001]


@responses.activate
def test_find_pois_handles_multiple_poi_types(sample_route_bytes, overpass_response_json, monkeypatch):
    # Injects a second, fake POI type for the duration of this test only
    # (not a real registry entry) to prove the find_pois loop handles more
    # than one requested type: two separate Overpass calls, correct
    # poi_type tagging per candidate, and a merged/sorted result.
    bench_response = {
        "version": 0.6,
        "generator": "Overpass API",
        "elements": [
            {"type": "node", "id": 2001, "lat": 48.8567, "lon": 2.3524, "tags": {"amenity": "bench"}},
        ],
    }
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
    responses.add(responses.POST, OVERPASS_URL, json=overpass_response_json, status=200)
    responses.add(responses.POST, OVERPASS_URL, json=bench_response, status=200)

    response = client.post(
        "/api/find-pois",
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
    assert len(responses.calls) == 2
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


@responses.activate
def test_find_pois_calls_are_concurrent_not_sequential(sample_route_bytes, monkeypatch):
    # Registers several fake POI types whose mocked Overpass calls each
    # sleep briefly - if find_pois still called Overpass sequentially, total
    # wall time would be roughly num_types * SLEEP_S; run concurrently via
    # asyncio.to_thread, it should be much closer to a single SLEEP_S.
    num_types = 4
    sleep_s = 0.2
    keys = _register_fake_poi_types(monkeypatch, num_types)

    def _slow_callback(request):
        time.sleep(sleep_s)
        return 200, {}, json.dumps({"version": 0.6, "generator": "test", "elements": []})

    responses.add_callback(responses.POST, OVERPASS_URL, callback=_slow_callback, content_type="application/json")

    start = time.monotonic()
    response = client.post(
        "/api/find-pois",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": k, "max_distance_m": 20} for k in keys])},
    )
    elapsed = time.monotonic() - start

    assert response.status_code == 200
    assert len(responses.calls) == num_types
    # Sequential would take >= num_types * sleep_s; concurrent should stay
    # well under half that, with generous margin for test-environment noise.
    assert elapsed < num_types * sleep_s * 0.6


@responses.activate
def test_find_pois_one_type_failure_does_not_block_others(sample_route_bytes, overpass_response_json, monkeypatch):
    keys = _register_fake_poi_types(monkeypatch, 1)
    failing_key = keys[0]

    def _dispatch(request):
        body = request.body.decode() if isinstance(request.body, bytes) else request.body
        if failing_key in body:
            return 500, {}, "overpass down"
        return 200, {}, json.dumps(overpass_response_json)

    responses.add_callback(responses.POST, OVERPASS_URL, callback=_dispatch, content_type="application/json")

    response = client.post(
        "/api/find-pois",
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


@responses.activate
def test_find_pois_all_types_fail_returns_502(sample_route_bytes, monkeypatch):
    keys = _register_fake_poi_types(monkeypatch, 2)
    responses.add(responses.POST, OVERPASS_URL, status=500, body="overpass down")

    response = client.post(
        "/api/find-pois",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": k, "max_distance_m": 20} for k in keys])},
    )
    assert response.status_code == 502


@responses.activate
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


@responses.activate
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


@responses.activate
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


def _route_leg_form(profile: str = "fastbike-lowtraffic") -> dict:
    return {
        "start_lat": 47.376899,
        "start_lon": 8.541699,
        "end_lat": 47.38,
        "end_lon": 8.55,
        "profile": profile,
    }


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


def test_route_leg_rejects_unknown_profile():
    response = client.post("/api/route-leg", data=_route_leg_form(profile="car-fast"))
    assert response.status_code == 400


@responses.activate
def test_route_leg_maps_routing_failure_to_502():
    responses.add(responses.GET, ROUTING_URL, body="upstream exploded", status=500)
    response = client.post("/api/route-leg", data=_route_leg_form())
    assert response.status_code == 502


@responses.activate
def test_find_pois_search_range_narrows_overpass_query_only(
    sample_route_bytes, overpass_response_json
):
    """The whole point of search_range: the upstream query covers only the
    requested slice, while every distance still comes from the full route.

    Node 1001 sits by the route's *first* point, so a search_range covering
    only the last two points must leave it out of the Overpass `around`
    clause - yet the candidate that is returned must still report a
    distance_from_start_m measured from the full route's start, not from the
    slice's start.
    """
    responses.add(responses.POST, OVERPASS_URL, json=overpass_response_json, status=200)
    response = client.post(
        "/api/find-pois",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "poi_config": json.dumps([{"poi_type": "water", "max_distance_m": 100}]),
            "search_range": json.dumps({"start_index": 1, "end_index": 2}),
        },
    )
    assert response.status_code == 200

    sent_query = responses.calls[0].request.body
    if isinstance(sent_query, bytes):
        sent_query = sent_query.decode()
    # Only points 1 and 2 of the 3-point fixture route are in the around clause.
    assert "48.857,2.353" in sent_query
    assert "48.8575,2.354" in sent_query
    assert "48.8566,2.3522" not in sent_query

    # ...but distances are still measured against all 3 points. Node 1001 is
    # nearest the route's first point, so a slice-relative distance_from_start_m
    # would be 0 here; the full-route value is not.
    full_route = [(48.8566, 2.3522), (48.857, 2.353), (48.8575, 2.354)]
    _, expected_from_start = project_onto_polyline_m((48.8567, 2.3524), full_route)
    candidate = next(c for c in response.json()["candidates"] if c["osm_id"] == 1001)
    assert candidate["distance_from_start_m"] == pytest.approx(expected_from_start)


@responses.activate
def test_find_pois_search_range_still_returns_the_whole_route_coords(
    sample_route_bytes, overpass_response_json
):
    """route_coords is what the frontend draws as *the route*, so a ranged
    search must still describe the whole thing - returning the sub-range
    here would visibly truncate the map's route line after a re-search."""
    responses.add(responses.POST, OVERPASS_URL, json=overpass_response_json, status=200)
    ranged = client.post(
        "/api/find-pois",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"search_range": json.dumps({"start_index": 2, "end_index": 2})},
    )
    whole = client.post(
        "/api/find-pois",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
    )
    assert ranged.json()["route_coords"] == whole.json()["route_coords"]
    assert ranged.json()["point_count"] == whole.json()["point_count"]


@responses.activate
def test_find_pois_without_search_range_queries_whole_route(
    sample_route_bytes, overpass_response_json
):
    responses.add(responses.POST, OVERPASS_URL, json=overpass_response_json, status=200)
    client.post(
        "/api/find-pois",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"poi_config": json.dumps([{"poi_type": "water", "max_distance_m": 100}])},
    )
    sent_query = responses.calls[0].request.body
    if isinstance(sent_query, bytes):
        sent_query = sent_query.decode()
    assert "48.8566,2.3522" in sent_query


@pytest.mark.parametrize(
    "bad_range",
    [
        {"start_index": 1, "end_index": 0},
        {"start_index": -1, "end_index": 2},
        {"start_index": 0, "end_index": 99},
    ],
)
def test_find_pois_rejects_out_of_range_search_range(sample_route_bytes, bad_range):
    response = client.post(
        "/api/find-pois",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"search_range": json.dumps(bad_range)},
    )
    assert response.status_code == 400


def test_find_pois_rejects_malformed_search_range(sample_route_bytes):
    response = client.post(
        "/api/find-pois",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"search_range": "not json"},
    )
    assert response.status_code == 400


@responses.activate
def test_rate_limit_blocks_after_threshold(sample_route_bytes):
    responses.add(responses.POST, OVERPASS_URL, json={"elements": []}, status=200)
    last_status = None
    for _ in range(OVERPASS_REQUESTS_PER_WINDOW + 1):
        resp = client.post(
            "/api/find-pois",
            files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        )
        last_status = resp.status_code
    assert last_status == 429


@responses.activate
def test_rate_limit_buckets_are_independent(sample_route_bytes, brouter_response_json):
    """Exhausting the Overpass budget must leave route planning usable, and
    vice versa - the whole reason rate_limit.py keys on (bucket, ip)."""
    responses.add(responses.POST, OVERPASS_URL, json={"elements": []}, status=200)
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)

    for _ in range(OVERPASS_REQUESTS_PER_WINDOW + 1):
        client.post(
            "/api/find-pois",
            files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        )

    routing_response = client.post(
        "/api/route-leg",
        data={
            "start_lat": 47.376899,
            "start_lon": 8.541699,
            "end_lat": 47.38,
            "end_lon": 8.55,
            "profile": "fastbike-lowtraffic",
        },
    )
    assert routing_response.status_code == 200
    assert ROUTING_REQUESTS_PER_WINDOW > OVERPASS_REQUESTS_PER_WINDOW
