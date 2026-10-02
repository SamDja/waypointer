"""Strava/Wahoo connections stored with an account (connections.py) and the
endpoints that use them, against the throwaway account database (see
conftest.py's account_db). Strava and Wahoo themselves are mocked with
`responses`."""

import time
from urllib.parse import parse_qs, urlparse

import psycopg
import pytest
import responses

from account_helpers import ACCOUNT_PASSWORD, signup_and_verify
from waypointer import strava, token_crypto, wahoo

STRAVA_TOKEN_URL = f"{strava.STRAVA_OAUTH_BASE}/token"
WAHOO_TOKEN_URL = f"{wahoo.WAHOO_API_BASE}/oauth/token"
VERIFIER = "v" * 64
WAHOO_REDIRECT = "http://testserver/wahoo-callback.html"


@pytest.fixture(autouse=True)
def _apps(account_db, monkeypatch):
    monkeypatch.setenv("STRAVA_CLIENT_ID", "strava-id")
    monkeypatch.setenv("STRAVA_CLIENT_SECRET", "strava-secret")
    monkeypatch.setenv("WAHOO_CLIENT_ID", "wahoo-id")
    monkeypatch.delenv("WAHOO_CLIENT_SECRET", raising=False)


@pytest.fixture
def signed_in(client, outbox):
    signup_and_verify(client, outbox)
    return client


def _strava_tokens(access="s-access", refresh="s-refresh", expires_in=6 * 3600, athlete=True):
    body = {"access_token": access, "refresh_token": refresh, "expires_at": int(time.time()) + expires_in}
    if athlete:
        body["athlete"] = {"id": 4242, "firstname": "Ada", "lastname": "Rider"}
    return body


def _wahoo_tokens(access="w-access", refresh="w-refresh", expires_in=2 * 3600):
    return {"access_token": access, "refresh_token": refresh, "expires_in": expires_in, "scope": wahoo.WAHOO_SCOPES}


def _connect_strava(client):
    responses.post(STRAVA_TOKEN_URL, json=_strava_tokens())
    response = client.post("/api/strava/connect", data={"code": "the-code", "scope": strava.STRAVA_SCOPES})
    assert response.status_code == 200, response.text
    return response.json()


def _connect_wahoo(client):
    responses.post(WAHOO_TOKEN_URL, json=_wahoo_tokens())
    responses.get(f"{wahoo.WAHOO_API_BASE}/v1/user", json={"first": "Ada", "last": "Rider"})
    response = client.post(
        "/api/wahoo/connect", data={"code": "the-code", "code_verifier": VERIFIER, "redirect_uri": WAHOO_REDIRECT}
    )
    assert response.status_code == 200, response.text
    return response.json()


def _stored_tokens(database_url, provider):
    with psycopg.connect(database_url) as conn:
        row = conn.execute(
            "SELECT access_token_enc, refresh_token_enc FROM connections WHERE provider = %s", (provider,)
        ).fetchone()
    return row


# --- connecting -------------------------------------------------------------


def test_connecting_needs_a_verified_account(client, outbox):
    assert client.post("/api/strava/connect", data={"code": "x"}).status_code == 401
    client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": ACCOUNT_PASSWORD})
    client.post("/api/auth/login", data={"email": "rider@example.com", "password": ACCOUNT_PASSWORD})
    response = client.get(
        "/api/strava/authorize-url", params={"redirect_uri": "http://testserver/strava-callback.html", "state": "s"}
    )
    assert response.status_code == 403


@responses.activate
def test_connect_strava_stores_encrypted_tokens(signed_in, account_db):
    body = _connect_strava(signed_in)
    assert body["provider"] == "strava"
    assert body["label"] == "Ada Rider"
    assert "access_token" not in body and "refresh_token" not in body

    access_enc, refresh_enc = _stored_tokens(account_db, "strava")
    assert b"s-access" not in bytes(access_enc)
    assert token_crypto.decrypt(access_enc) == "s-access"
    assert token_crypto.decrypt(refresh_enc) == "s-refresh"

    listed = signed_in.get("/api/connections").json()
    assert [c["provider"] for c in listed] == ["strava"]


@responses.activate
def test_connect_wahoo_sends_the_pkce_verifier(signed_in):
    body = _connect_wahoo(signed_in)
    assert body == {**body, "provider": "wahoo", "label": "Ada Rider", "scope": wahoo.WAHOO_SCOPES}
    sent = parse_qs(responses.calls[0].request.body)
    assert sent["code_verifier"] == [VERIFIER]
    assert sent["client_id"] == ["wahoo-id"]
    assert sent["redirect_uri"] == [WAHOO_REDIRECT]


def test_wahoo_authorize_url(signed_in):
    response = signed_in.get(
        "/api/wahoo/authorize-url",
        params={"redirect_uri": WAHOO_REDIRECT, "state": "abc", "code_challenge": "c" * 43},
    )
    assert response.status_code == 200
    query = parse_qs(urlparse(response.json()["url"]).query)
    assert query["client_id"] == ["wahoo-id"]
    assert query["code_challenge"] == ["c" * 43]
    assert query["code_challenge_method"] == ["S256"]
    assert query["state"] == ["abc"]


@pytest.mark.parametrize("provider,path", [("strava", "/elsewhere.html"), ("wahoo", "/strava-callback.html")])
def test_authorize_url_only_for_our_callback(signed_in, provider, path):
    params = {"redirect_uri": f"http://testserver{path}", "state": "s"}
    if provider == "wahoo":
        params["code_challenge"] = "c" * 43
    assert signed_in.get(f"/api/{provider}/authorize-url", params=params).status_code == 400


def test_connecting_without_an_encryption_key_is_refused_up_front(signed_in, monkeypatch):
    monkeypatch.delenv(token_crypto.TOKEN_ENCRYPTION_KEY_ENV)
    response = signed_in.get(
        "/api/strava/authorize-url", params={"redirect_uri": "http://testserver/strava-callback.html", "state": "s"}
    )
    assert response.status_code == 503


def test_wahoo_not_configured(signed_in, monkeypatch):
    monkeypatch.delenv("WAHOO_CLIENT_ID")
    response = signed_in.get(
        "/api/wahoo/authorize-url",
        params={"redirect_uri": WAHOO_REDIRECT, "state": "s", "code_challenge": "c" * 43},
    )
    assert response.status_code == 503


@responses.activate
def test_refused_code_is_a_401(signed_in):
    responses.post(STRAVA_TOKEN_URL, status=400, json={"message": "Bad Request"})
    assert signed_in.post("/api/strava/connect", data={"code": "used"}).status_code == 401


# --- using a stored connection ----------------------------------------------


@responses.activate
def test_strava_routes_use_the_stored_token_and_athlete(signed_in):
    _connect_strava(signed_in)
    responses.get(f"{strava.STRAVA_API_BASE}/athletes/4242/routes", json=[])
    assert signed_in.get("/api/strava/routes").status_code == 200
    request = responses.calls[-1].request
    assert request.headers["Authorization"] == "Bearer s-access"


def test_using_an_app_that_isnt_connected(signed_in):
    response = signed_in.get("/api/strava/routes")
    assert response.status_code == 401
    assert response.json()["detail"] == "Connect Strava first."
    assert signed_in.get("/api/wahoo/routes").status_code == 401


@responses.activate
def test_expiring_token_is_refreshed_and_stored(signed_in, account_db):
    _connect_wahoo(signed_in)
    with psycopg.connect(account_db, autocommit=True) as conn:
        conn.execute("UPDATE connections SET expires_at = now() + interval '1 minute'")
    responses.post(WAHOO_TOKEN_URL, json=_wahoo_tokens(access="w-access-2", refresh="w-refresh-2"))
    responses.get(f"{wahoo.WAHOO_API_BASE}/v1/routes", json=[])

    assert signed_in.get("/api/wahoo/routes").status_code == 200
    assert responses.calls[-1].request.headers["Authorization"] == "Bearer w-access-2"
    access_enc, refresh_enc = _stored_tokens(account_db, "wahoo")
    assert token_crypto.decrypt(refresh_enc) == "w-refresh-2"

    # Fresh again, so the next call doesn't refresh.
    calls = len(responses.calls)
    signed_in.get("/api/wahoo/routes")
    assert [c.request.url for c in responses.calls[calls:]] == [f"{wahoo.WAHOO_API_BASE}/v1/routes"]


@responses.activate
def test_refused_refresh_drops_the_connection(signed_in, account_db):
    _connect_strava(signed_in)
    with psycopg.connect(account_db, autocommit=True) as conn:
        conn.execute("UPDATE connections SET expires_at = now() - interval '1 minute'")
    responses.post(STRAVA_TOKEN_URL, status=400, json={"message": "Bad Request"})

    response = signed_in.get("/api/strava/routes")
    assert response.status_code == 401
    assert "connect Strava again" in response.json()["detail"]
    assert signed_in.get("/api/connections").json() == []


@responses.activate
def test_push_route_to_wahoo(signed_in, sample_route_bytes):
    _connect_wahoo(signed_in)
    responses.post(f"{wahoo.WAHOO_API_BASE}/v1/routes", json={"id": 1})
    response = signed_in.post(
        "/api/wahoo/routes",
        files={"gpx_file": ("route.gpx", sample_route_bytes, "application/gpx+xml")},
        data={"selected_candidates": "[]", "route_name": "Saturday"},
    )
    assert response.status_code == 204, response.text
    sent = parse_qs(responses.calls[-1].request.body)
    assert sent["route[name]"] == ["Saturday"]
    assert sent["route[file]"][0].startswith("data:application/vnd.fit;base64,")
    assert responses.calls[-1].request.headers["Authorization"] == "Bearer w-access"


@responses.activate
def test_rename_wahoo_route_resends_its_required_fields(signed_in):
    _connect_wahoo(signed_in)
    route = {"id": 7, "name": "Old", "distance": 1000, "ascent": 50, "start_lat": 45.1, "start_lng": 7.2,
             "created_at": "2026-01-01", "file": {"url": "https://cdn.wahooligan.com/r.fit"}}
    responses.get(f"{wahoo.WAHOO_API_BASE}/v1/routes/7", json=route)
    responses.put(f"{wahoo.WAHOO_API_BASE}/v1/routes/7", json=route)
    assert signed_in.post("/api/wahoo/routes/7/rename", data={"name": "New"}).status_code == 204
    sent = parse_qs(responses.calls[-1].request.body)
    assert sent["route[name]"] == ["New"]
    assert sent["route[start_lat]"] == ["45.1"]
    assert sent["route[distance]"] == ["1000.0"]


# --- disconnecting and importing --------------------------------------------


@responses.activate
def test_disconnect_revokes_then_forgets(signed_in):
    _connect_wahoo(signed_in)
    responses.delete(f"{wahoo.WAHOO_API_BASE}/v1/permissions", json={})
    assert signed_in.post("/api/connections/wahoo/disconnect").status_code == 204
    assert responses.calls[-1].request.method == "DELETE"
    assert signed_in.get("/api/connections").json() == []


@responses.activate
def test_disconnect_forgets_even_if_revoke_fails(signed_in):
    _connect_strava(signed_in)
    responses.post(f"{strava.STRAVA_OAUTH_BASE}/deauthorize", status=500)
    assert signed_in.post("/api/connections/strava/disconnect").status_code == 204
    assert signed_in.get("/api/connections").json() == []


@responses.activate
def test_import_browser_held_strava_connection(signed_in, account_db):
    responses.post(STRAVA_TOKEN_URL, json=_strava_tokens(access="fresh", refresh="fresh-r", athlete=False))
    responses.get(f"{strava.STRAVA_API_BASE}/athlete", json={"id": 99, "firstname": "Ada", "lastname": "Rider"})
    response = signed_in.post(
        "/api/connections/import",
        data={"provider": "strava", "refresh_token": "old-r", "scope": strava.STRAVA_SCOPES},
    )
    assert response.status_code == 200, response.text
    assert response.json()["label"] == "Ada Rider"
    # Whose athlete it is comes from Strava, never from the browser.
    responses.get(f"{strava.STRAVA_API_BASE}/athletes/99/routes", json=[])
    assert signed_in.get("/api/strava/routes").status_code == 200
    access_enc, _ = _stored_tokens(account_db, "strava")
    assert token_crypto.decrypt(access_enc) == "fresh"


@responses.activate
def test_import_expired_connection(signed_in):
    responses.post(WAHOO_TOKEN_URL, status=401, json={"error": "invalid_grant"})
    response = signed_in.post("/api/connections/import", data={"provider": "wahoo", "refresh_token": "dead"})
    assert response.status_code == 400
    assert "connect Wahoo again" in response.json()["detail"]


def test_import_unknown_provider(signed_in):
    assert signed_in.post("/api/connections/import", data={"provider": "garmin", "refresh_token": "x"}).status_code == 422


@responses.activate
def test_deleting_the_account_revokes_connections(signed_in, account_db):
    _connect_strava(signed_in)
    responses.post(f"{strava.STRAVA_OAUTH_BASE}/deauthorize", json={})
    assert signed_in.post("/api/account/delete", data={"password": ACCOUNT_PASSWORD}).status_code == 204
    assert any(c.request.url.endswith("/deauthorize") for c in responses.calls)
    with psycopg.connect(account_db) as conn:
        assert conn.execute("SELECT count(*) FROM connections").fetchone()[0] == 0


# --- settings and export ----------------------------------------------------


def test_profile_settings_round_trip(signed_in):
    assert signed_in.get("/api/account/settings").json() == {"avg_speed_kmh": {}}
    body = {"avg_speed_kmh": {"road_cycling": 24.5, "hiking": 4.2}}
    assert signed_in.put("/api/account/settings", json=body).json() == body
    assert signed_in.get("/api/account/settings").json() == body


@pytest.mark.parametrize("bad", [{"road_cycling": 0}, {"road_cycling": 500}, {"Not A Key": 10}])
def test_profile_settings_validated(signed_in, bad):
    assert signed_in.put("/api/account/settings", json={"avg_speed_kmh": bad}).status_code == 422


def test_settings_need_a_session(client):
    assert client.get("/api/account/settings").status_code == 401


@responses.activate
def test_export_lists_connections_without_tokens(signed_in):
    _connect_strava(signed_in)
    signed_in.put("/api/account/settings", json={"avg_speed_kmh": {"hiking": 4.0}})
    data = signed_in.get("/api/account/export").json()
    assert data["connections"][0]["provider"] == "strava"
    assert data["settings"] == {"avg_speed_kmh": {"hiking": 4.0}}
    text = signed_in.get("/api/account/export").text
    assert "s-access" not in text and "s-refresh" not in text
