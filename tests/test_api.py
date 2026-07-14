import json

import responses
from fastapi.testclient import TestClient
from fit_tool.fit_file import FitFile
from fit_tool.profile.messages.course_point_message import CoursePointMessage

from waypointer.main import app
from waypointer.osm import OVERPASS_URL
from waypointer.rate_limit import REQUESTS_PER_WINDOW

client = TestClient(app)


@responses.activate
def test_find_fountains_returns_candidates_within_radius(sample_route_bytes, overpass_response_json):
    responses.add(responses.POST, OVERPASS_URL, json=overpass_response_json, status=200)
    response = client.post(
        "/api/find-fountains",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["point_count"] == 3
    assert data["existing_waypoint_count"] == 1
    # node 1002 (~400m away) must be excluded by the authoritative distance check
    assert [c["osm_id"] for c in data["candidates"]] == [1001]
    assert data["route_coords"]
    assert all(len(pt) == 2 for pt in data["route_coords"])


def test_find_fountains_rejects_invalid_gpx():
    response = client.post(
        "/api/find-fountains",
        files={"gpx_file": ("bad.gpx", b"not xml", "application/gpx+xml")},
    )
    assert response.status_code == 400


@responses.activate
def test_save_generic_round_trip(sample_route_bytes):
    selected = json.dumps(
        [{"osm_id": 1001, "name": "Fontaine Wallace", "lat": 48.8567, "lon": 2.3524, "distance_m": 12.0}]
    )
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={
            "selected_candidates": selected,
            "device": "generic",
            "water_symbol": "Water",
        },
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/gpx+xml")
    assert "route_waypoints.gpx" in response.headers["content-disposition"]
    assert b"Fontaine Wallace" in response.content
    assert b"<sym>Water</sym>" in response.content


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
        [{"osm_id": 1001, "name": "Fontaine Wallace", "lat": 48.8567, "lon": 2.3524, "distance_m": 12.0}]
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


def test_save_rejects_unknown_device(sample_route_bytes):
    response = client.post(
        "/api/save",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"selected_candidates": "[]", "device": "nonexistent"},
    )
    assert response.status_code == 400


@responses.activate
def test_rate_limit_blocks_after_threshold(sample_route_bytes):
    responses.add(responses.POST, OVERPASS_URL, json={"elements": []}, status=200)
    last_status = None
    for _ in range(REQUESTS_PER_WINDOW + 1):
        resp = client.post(
            "/api/find-fountains",
            files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        )
        last_status = resp.status_code
    assert last_status == 429
