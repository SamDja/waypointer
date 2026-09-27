"""Strava connection and route import (strava.py and /api/strava/*). Strava
itself is stubbed with `responses`; the shapes follow Strava's API reference
(token exchange with its `athlete` summary, route lists carrying `id_str`)."""

from urllib.parse import parse_qs, urlparse

import pytest
import responses
from fastapi.testclient import TestClient

from waypointer import strava
from waypointer.gpx_io import parse_gpx, route_coordinates, route_elevations
from waypointer.main import app

TOKEN_URL = f"{strava.STRAVA_OAUTH_BASE}/token"
DEAUTHORIZE_URL = f"{strava.STRAVA_OAUTH_BASE}/deauthorize"
ATHLETE_ID = 1234
ROUTES_URL = f"{strava.STRAVA_API_BASE}/athletes/{ATHLETE_ID}/routes"
# Past 2**53, as real Strava route ids are - why the API is read by id_str.
ROUTE_ID = "3344556677889900112"
EXPORT_URL = f"{strava.STRAVA_API_BASE}/routes/{ROUTE_ID}/export_gpx"
ACTIVITIES_URL = f"{strava.STRAVA_API_BASE}/athlete/activities"
ACTIVITY_ID = "15551234567"
STREAMS_URL = f"{strava.STRAVA_API_BASE}/activities/{ACTIVITY_ID}/streams"
BEARER = {"Authorization": "Bearer visitor-token"}

client = TestClient(app)


@pytest.fixture(autouse=True)
def _strava_credentials(monkeypatch):
    monkeypatch.setenv("STRAVA_CLIENT_ID", "4242")
    monkeypatch.setenv("STRAVA_CLIENT_SECRET", "s3cret")


def _token_json(with_athlete: bool = True) -> dict:
    data = {
        "token_type": "Bearer",
        "access_token": "access-1",
        "refresh_token": "refresh-1",
        "expires_at": 1_790_000_000,
        "expires_in": 21600,
    }
    if with_athlete:
        data["athlete"] = {"id": ATHLETE_ID, "firstname": "Ada", "lastname": "Lovelace"}
    return data


def _route_json(route_id: str, name: str) -> dict:
    return {
        "id": int(route_id),
        "id_str": route_id,
        "name": name,
        "distance": 42_195.5,
        "elevation_gain": 812.0,
        "created_at": "2026-09-01T08:00:00Z",
    }


def test_authorize_url_carries_client_scope_and_callback():
    response = client.get(
        "/api/strava/authorize-url",
        params={"redirect_uri": "https://example.org/strava-callback.html", "state": "xyz"},
    )
    assert response.status_code == 200
    url = urlparse(response.json()["url"])
    query = parse_qs(url.query)
    assert url.netloc == "www.strava.com" and url.path == "/oauth/authorize"
    assert query["client_id"] == ["4242"]
    assert query["scope"] == ["read,read_all,activity:read_all"]
    assert query["redirect_uri"] == ["https://example.org/strava-callback.html"]
    assert query["state"] == ["xyz"]
    assert "client_secret" not in query


@pytest.mark.parametrize(
    "redirect_uri",
    ["https://example.org/elsewhere.html", "javascript:alert(1)", "/strava-callback.html"],
)
def test_authorize_url_only_for_our_callback_page(redirect_uri):
    response = client.get("/api/strava/authorize-url", params={"redirect_uri": redirect_uri, "state": "x"})
    assert response.status_code == 400


def test_not_configured_is_a_503(monkeypatch):
    monkeypatch.delenv("STRAVA_CLIENT_SECRET")
    response = client.get(
        "/api/strava/authorize-url",
        params={"redirect_uri": "https://example.org/strava-callback.html", "state": "x"},
    )
    assert response.status_code == 503


@responses.activate
def test_code_exchange_sends_the_secret_and_returns_the_athlete():
    responses.add(responses.POST, TOKEN_URL, json=_token_json(), status=200)
    response = client.post("/api/strava/token", data={"code": "the-code"})

    assert response.status_code == 200
    assert response.json() == {
        "access_token": "access-1",
        "refresh_token": "refresh-1",
        "expires_at": 1_790_000_000,
        "athlete_id": ATHLETE_ID,
        "athlete_label": "Ada Lovelace",
    }
    sent = parse_qs(responses.calls[0].request.body)
    assert sent["client_secret"] == ["s3cret"]
    assert sent["grant_type"] == ["authorization_code"]
    assert sent["code"] == ["the-code"]


@responses.activate
def test_refresh_has_no_athlete():
    responses.add(responses.POST, TOKEN_URL, json=_token_json(with_athlete=False), status=200)
    response = client.post("/api/strava/token", data={"refresh_token": "refresh-0"})

    assert response.status_code == 200
    assert response.json()["athlete_id"] is None
    sent = parse_qs(responses.calls[0].request.body)
    assert sent["grant_type"] == ["refresh_token"]
    assert sent["refresh_token"] == ["refresh-0"]


@pytest.mark.parametrize("data", [{}, {"code": "a", "refresh_token": "b"}])
def test_token_needs_exactly_one_grant(data):
    assert client.post("/api/strava/token", data=data).status_code == 400


@responses.activate
def test_refused_code_is_a_401():
    # Strava answers a bad or reused code with a 400.
    responses.add(responses.POST, TOKEN_URL, json={"message": "Bad Request"}, status=400)
    assert client.post("/api/strava/token", data={"code": "stale"}).status_code == 401


@responses.activate
def test_routes_page_until_a_short_page(monkeypatch):
    monkeypatch.setattr(strava, "ROUTES_PER_PAGE", 2)
    responses.add(
        responses.GET, ROUTES_URL, json=[_route_json(ROUTE_ID, "A"), _route_json("11", "B")], status=200
    )
    responses.add(responses.GET, ROUTES_URL, json=[_route_json("12", "C")], status=200)

    response = client.get("/api/strava/routes", params={"athlete_id": ATHLETE_ID}, headers=BEARER)

    assert response.status_code == 200
    routes = response.json()
    assert [r["name"] for r in routes] == ["A", "B", "C"]
    # id_str survives exactly, where the numeric id would lose digits in JS.
    assert routes[0]["id"] == ROUTE_ID
    assert routes[0]["distance_m"] == 42_195.5 and routes[0]["ascent_m"] == 812.0
    assert len(responses.calls) == 2
    assert responses.calls[0].request.headers["Authorization"] == "Bearer visitor-token"


def test_routes_need_a_token():
    assert client.get("/api/strava/routes", params={"athlete_id": ATHLETE_ID}).status_code == 401


@responses.activate
def test_upstream_401_and_429_pass_through():
    responses.add(responses.GET, ROUTES_URL, json={"message": "Authorization Error"}, status=401)
    assert (
        client.get("/api/strava/routes", params={"athlete_id": ATHLETE_ID}, headers=BEARER).status_code == 401
    )

    responses.replace(responses.GET, ROUTES_URL, json={"message": "Rate Limit Exceeded"}, status=429)
    response = client.get("/api/strava/routes", params={"athlete_id": ATHLETE_ID}, headers=BEARER)
    assert response.status_code == 429
    assert response.headers["Retry-After"]


@responses.activate
def test_upstream_failure_is_a_502():
    responses.add(responses.GET, ROUTES_URL, body="oops", status=500)
    assert (
        client.get("/api/strava/routes", params={"athlete_id": ATHLETE_ID}, headers=BEARER).status_code == 502
    )


@responses.activate
def test_import_returns_the_exported_gpx(sample_route_bytes):
    responses.add(responses.GET, EXPORT_URL, body=sample_route_bytes, status=200)
    response = client.post("/api/strava/import-route", data={"route_id": ROUTE_ID}, headers=BEARER)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/gpx+xml")
    assert response.content == sample_route_bytes


@pytest.mark.parametrize("route_id", ["12/../../athlete", "abc", "１２３", ""])
def test_import_refuses_anything_but_a_numeric_id(route_id):
    response = client.post("/api/strava/import-route", data={"route_id": route_id}, headers=BEARER)
    # An empty form field fails FastAPI's own validation (422) before ours.
    assert response.status_code in (400, 422)


@responses.activate
def test_import_refuses_an_unreadable_export():
    responses.add(responses.GET, EXPORT_URL, body=b"<html>not gpx</html>", status=200)
    response = client.post("/api/strava/import-route", data={"route_id": ROUTE_ID}, headers=BEARER)
    assert response.status_code == 400


@responses.activate
def test_deauthorize_sends_the_token():
    responses.add(responses.POST, DEAUTHORIZE_URL, json={"access_token": "visitor-token"}, status=200)
    assert client.post("/api/strava/deauthorize", headers=BEARER).status_code == 204
    assert parse_qs(responses.calls[0].request.body)["access_token"] == ["visitor-token"]


def _activity_json(activity_id: int, name: str, **overrides) -> dict:
    data = {
        "id": activity_id,
        "name": name,
        "sport_type": "GravelRide",
        "type": "Ride",
        "distance": 61_000.0,
        "total_elevation_gain": 1_020.0,
        "start_date": "2026-09-14T07:30:00Z",
        "start_latlng": [46.07, 11.12],
        "trainer": False,
        "manual": False,
    }
    data.update(overrides)
    return data


@responses.activate
def test_activities_skip_ones_without_a_gps_track():
    responses.add(
        responses.GET,
        ACTIVITIES_URL,
        json=[
            _activity_json(int(ACTIVITY_ID), "Morning gravel"),
            _activity_json(2, "Zwift", start_latlng=[], trainer=True),
            _activity_json(3, "Logged by hand", start_latlng=None, manual=True),
        ],
        status=200,
    )
    response = client.get("/api/strava/activities", headers=BEARER)

    assert response.status_code == 200
    assert response.json() == {
        "activities": [
            {
                "id": ACTIVITY_ID,
                "name": "Morning gravel",
                "sport_type": "GravelRide",
                "distance_m": 61_000.0,
                "ascent_m": 1_020.0,
                "start_date": "2026-09-14T07:30:00Z",
            }
        ],
        # Strava sent fewer than a full page: that was the last one.
        "has_more": False,
    }
    assert responses.calls[0].request.headers["Authorization"] == "Bearer visitor-token"


@responses.activate
def test_activities_come_one_page_of_twenty_at_a_time():
    # A full page from Strava - all indoor rides, so none of them shown -
    # still means there may be more, rather than ending the list.
    responses.add(
        responses.GET,
        ACTIVITIES_URL,
        json=[_activity_json(i, "Zwift", start_latlng=[], trainer=True) for i in range(20)],
        status=200,
    )
    response = client.get("/api/strava/activities", params={"page": 3}, headers=BEARER)

    assert response.status_code == 200
    assert response.json() == {"activities": [], "has_more": True}
    assert len(responses.calls) == 1
    query = parse_qs(urlparse(responses.calls[0].request.url).query)
    assert query["page"] == ["3"] and query["per_page"] == ["20"]


@pytest.mark.parametrize("page", [0, -1, "x"])
def test_activities_refuse_a_bad_page(page):
    assert client.get("/api/strava/activities", params={"page": page}, headers=BEARER).status_code == 422


@responses.activate
def test_activities_without_the_scope_ask_to_reconnect():
    # What Strava answers a token granted before activity:read_all was asked for.
    responses.add(
        responses.GET,
        ACTIVITIES_URL,
        json={"message": "Authorization Error", "errors": [{"field": "activity:read_permission", "code": "missing"}]},
        status=401,
    )
    assert client.get("/api/strava/activities", headers=BEARER).status_code == 401


@responses.activate
def test_import_activity_builds_a_gpx_track_with_elevation():
    responses.add(
        responses.GET,
        STREAMS_URL,
        json={
            "latlng": {"data": [[46.07, 11.12], [46.08, 11.13], [46.09, 11.15]]},
            "altitude": {"data": [194.0, 210.5, 250.0]},
            "distance": {"data": [0.0, 1300.0, 2900.0]},
        },
        status=200,
    )
    response = client.post(
        "/api/strava/import-activity", data={"activity_id": ACTIVITY_ID, "name": "Morning gravel"}, headers=BEARER
    )

    assert response.status_code == 200
    gpx = parse_gpx(response.content)
    assert gpx.tracks[0].name == "Morning gravel"
    assert route_coordinates(gpx) == [(46.07, 11.12), (46.08, 11.13), (46.09, 11.15)]
    assert route_elevations(gpx) == [194.0, 210.5, 250.0]
    query = parse_qs(urlparse(responses.calls[0].request.url).query)
    assert query["keys"] == ["latlng,altitude"] and query["key_by_type"] == ["true"]


@responses.activate
def test_import_activity_without_altitude_still_imports():
    responses.add(
        responses.GET, STREAMS_URL, json={"latlng": {"data": [[46.07, 11.12], [46.08, 11.13]]}}, status=200
    )
    response = client.post("/api/strava/import-activity", data={"activity_id": ACTIVITY_ID}, headers=BEARER)

    assert response.status_code == 200
    assert route_elevations(parse_gpx(response.content)) == [None, None]


@responses.activate
def test_import_activity_without_gps_is_a_400():
    responses.add(responses.GET, STREAMS_URL, json={"time": {"data": [0, 1, 2]}}, status=200)
    response = client.post("/api/strava/import-activity", data={"activity_id": ACTIVITY_ID}, headers=BEARER)
    assert response.status_code == 400
    assert "no GPS track" in response.json()["detail"]


@pytest.mark.parametrize("activity_id", ["12/../../athlete", "abc", "１２３"])
def test_import_activity_refuses_anything_but_a_numeric_id(activity_id):
    response = client.post("/api/strava/import-activity", data={"activity_id": activity_id}, headers=BEARER)
    assert response.status_code == 400
    assert "isn't a Strava activity id" in response.json()["detail"]
