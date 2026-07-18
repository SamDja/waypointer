import base64
import json

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
from waypointer.rate_limit import REQUESTS_PER_WINDOW

client = TestClient(app)


@responses.activate
def test_find_pois_defaults_to_water_search(sample_route_bytes, overpass_response_json):
    # No poi_config form field sent - exercises the endpoint's default
    # fallback (water, at the registry's default_max_distance_m).
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
    # node 1002 (~400m away) must be excluded by the authoritative distance check
    assert [c["osm_id"] for c in data["candidates"]] == [1001]
    assert data["candidates"][0]["poi_type"] == "water"
    assert data["route_coords"]
    assert all(len(pt) == 2 for pt in data["route_coords"])


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


@responses.activate
def test_rate_limit_blocks_after_threshold(sample_route_bytes):
    responses.add(responses.POST, OVERPASS_URL, json={"elements": []}, status=200)
    last_status = None
    for _ in range(REQUESTS_PER_WINDOW + 1):
        resp = client.post(
            "/api/find-pois",
            files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        )
        last_status = resp.status_code
    assert last_status == 429
