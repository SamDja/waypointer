"""Account endpoints against a real, throwaway Postgres (testcontainers).

Skipped cleanly without Docker, like test_poi_db.py. Outgoing email is
captured into a list instead of sent.
"""

import re
from datetime import timedelta

import psycopg
import pytest
import responses
from fastapi import Depends
from fastapi.testclient import TestClient

from account_helpers import link_token as _link_token, signup_and_verify as _signup_and_verify
from waypointer import db, sessions, turnstile
from waypointer.main import app

ORIGIN = "http://testserver"
PASSWORD = "correct horse battery"


@pytest.fixture(autouse=True)
def _configure(account_db):
    yield


def test_me_anonymous(client):
    body = client.get("/api/auth/me").json()
    assert body == {"enabled": True, "account": None, "captcha_required": False}


def test_me_without_database(client, monkeypatch):
    monkeypatch.delenv(db.DATABASE_URL_ENV)
    assert client.get("/api/auth/me").json()["enabled"] is False
    response = client.post("/api/auth/login", data={"email": "a@b.co", "password": PASSWORD})
    assert response.status_code == 503


def test_signup_verify_login_logout(client, outbox):
    response = client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "Rider@Example.com", "password": PASSWORD})
    assert response.status_code == 202
    # Sign-up alone doesn't sign in - the verification link does.
    assert client.get("/api/auth/me").json()["account"] is None
    assert outbox[-1]["to"] == "Rider@Example.com"

    account = client.post("/api/auth/verify", data={"token": _link_token(outbox[-1], "verify")}).json()
    assert account["email"] == "Rider@Example.com"
    assert account["email_verified"] is True
    assert client.get("/api/auth/me").json()["account"]["id"] == account["id"]

    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/auth/me").json()["account"] is None

    # Email is case-insensitive.
    response = client.post("/api/auth/login", data={"email": "rider@example.COM", "password": PASSWORD})
    assert response.status_code == 200
    assert client.get("/api/auth/me").json()["account"]["id"] == account["id"]


def test_logout_invalidates_the_session_server_side(client, outbox):
    _signup_and_verify(client, outbox)
    stolen = client.cookies.get(sessions.SESSION_COOKIE)
    client.post("/api/auth/logout")
    client.cookies.set(sessions.SESSION_COOKIE, stolen)
    assert client.get("/api/auth/me").json()["account"] is None


def test_verify_link_is_single_use(client, outbox):
    client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": PASSWORD})
    token = _link_token(outbox[-1], "verify")
    assert client.post("/api/auth/verify", data={"token": token}).status_code == 200
    assert client.post("/api/auth/verify", data={"token": token}).status_code == 400


def test_duplicate_signup_looks_the_same(client, outbox):
    first = client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": PASSWORD})
    second = client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": "another long one"})
    assert first.status_code == second.status_code == 202
    assert first.json() == second.json()
    # The owner is told by email instead.
    assert "already" in outbox[-1]["body"]
    assert "?verify=" not in outbox[-1]["body"]


def test_unverified_account_can_log_in(client, outbox):
    client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": PASSWORD})
    response = client.post("/api/auth/login", data={"email": "rider@example.com", "password": PASSWORD})
    assert response.status_code == 200
    assert response.json()["email_verified"] is False
    assert client.post("/api/auth/resend-verification").status_code == 202
    assert "?verify=" in outbox[-1]["body"]


def test_login_errors_are_generic(client, outbox):
    _signup_and_verify(client, outbox)
    client.post("/api/auth/logout")
    wrong_password = client.post("/api/auth/login", data={"email": "rider@example.com", "password": "nope nope nope"})
    unknown_email = client.post("/api/auth/login", data={"email": "nobody@example.com", "password": PASSWORD})
    assert wrong_password.status_code == unknown_email.status_code == 401
    assert wrong_password.json() == unknown_email.json()


@pytest.mark.parametrize("password", ["short", "x" * 257])
def test_signup_refuses_bad_passwords(client, outbox, password):
    response = client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": password})
    assert response.status_code == 400
    assert outbox == []


def test_signup_refuses_bad_email(client, outbox):
    response = client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "not-an-email", "password": PASSWORD})
    assert response.status_code == 400


def test_state_changing_requests_need_our_origin(client, outbox):
    for headers in ({"Origin": "https://evil.example"}, {"Origin": ""}):
        response = client.post(
            "/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": PASSWORD}, headers=headers
        )
        assert response.status_code == 403
    assert outbox == []


def test_origin_checked_against_public_base_url(client, outbox, monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://sullavia.example")
    response = client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": PASSWORD})
    assert response.status_code == 403
    response = client.post(
        "/api/auth/signup",
        data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": PASSWORD},
        headers={"Origin": "https://sullavia.example"},
    )
    assert response.status_code == 202
    # Links point at the configured site, never at the request's Host.
    assert "https://sullavia.example/?verify=" in outbox[-1]["body"]


def test_forgot_and_reset_password(client, outbox):
    _signup_and_verify(client, outbox)
    other_browser = client.cookies.get(sessions.SESSION_COOKIE)
    client.cookies.clear()

    assert client.post("/api/auth/forgot-password", data={"email": "rider@example.com"}).status_code == 202
    token = _link_token(outbox[-1], "reset")

    # Too short: refused without spending the link.
    response = client.post("/api/auth/reset-password", data={"token": token, "password": "short"})
    assert response.status_code == 400
    response = client.post("/api/auth/reset-password", data={"token": token, "password": "a brand new password"})
    assert response.status_code == 200
    assert client.get("/api/auth/me").json()["account"]["email"] == "rider@example.com"

    # Single use.
    response = client.post("/api/auth/reset-password", data={"token": token, "password": "yet another password"})
    assert response.status_code == 400
    # Every other session was signed out.
    client.cookies.set(sessions.SESSION_COOKIE, other_browser)
    assert client.get("/api/auth/me").json()["account"] is None
    # Old password gone, new one works.
    client.cookies.clear()
    assert client.post("/api/auth/login", data={"email": "rider@example.com", "password": PASSWORD}).status_code == 401
    response = client.post("/api/auth/login", data={"email": "rider@example.com", "password": "a brand new password"})
    assert response.status_code == 200


def test_forgot_password_for_unknown_email_looks_the_same(client, outbox):
    response = client.post("/api/auth/forgot-password", data={"email": "nobody@example.com"})
    assert response.status_code == 202
    assert response.json() == {"status": "check_email"}
    assert outbox == []


def test_only_the_latest_reset_link_works(client, outbox):
    _signup_and_verify(client, outbox)
    client.post("/api/auth/forgot-password", data={"email": "rider@example.com"})
    first = _link_token(outbox[-1], "reset")
    client.post("/api/auth/forgot-password", data={"email": "rider@example.com"})
    second = _link_token(outbox[-1], "reset")
    assert client.post("/api/auth/reset-password", data={"token": first, "password": "a brand new password"}).status_code == 400
    assert client.post("/api/auth/reset-password", data={"token": second, "password": "a brand new password"}).status_code == 200


def test_expired_reset_link(client, outbox, account_db):
    _signup_and_verify(client, outbox)
    client.post("/api/auth/forgot-password", data={"email": "rider@example.com"})
    token = _link_token(outbox[-1], "reset")
    with psycopg.connect(account_db, autocommit=True) as conn:
        conn.execute("UPDATE email_tokens SET expires_at = now() - interval '1 second'")
    response = client.post("/api/auth/reset-password", data={"token": token, "password": "a brand new password"})
    assert response.status_code == 400


def test_change_password_keeps_this_session_only(client, outbox):
    _signup_and_verify(client, outbox)
    first_browser = client.cookies.get(sessions.SESSION_COOKIE)
    client.cookies.clear()
    client.post("/api/auth/login", data={"email": "rider@example.com", "password": PASSWORD})

    response = client.post(
        "/api/account/password", data={"current_password": "wrong password!", "new_password": "a brand new password"}
    )
    assert response.status_code == 400
    response = client.post(
        "/api/account/password", data={"current_password": PASSWORD, "new_password": "a brand new password"}
    )
    assert response.status_code == 204
    assert client.get("/api/auth/me").json()["account"] is not None
    client.cookies.set(sessions.SESSION_COOKIE, first_browser)
    assert client.get("/api/auth/me").json()["account"] is None


def test_change_email(client, outbox):
    _signup_and_verify(client, outbox)
    response = client.post("/api/account/email", data={"password": PASSWORD, "new_email": "new@example.com"})
    assert response.status_code == 202
    assert outbox[-1]["to"] == "new@example.com"
    # Unchanged until confirmed.
    assert client.get("/api/auth/me").json()["account"]["email"] == "rider@example.com"

    response = client.post("/api/auth/confirm-email", data={"token": _link_token(outbox[-1], "confirm-email")})
    assert response.status_code == 200
    assert response.json()["email"] == "new@example.com"
    assert outbox[-1]["to"] == "rider@example.com"  # heads-up to the old address
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", data={"email": "new@example.com", "password": PASSWORD}).status_code == 200


def test_change_email_to_a_taken_address_looks_the_same(client, outbox):
    _signup_and_verify(client, outbox, email="other@example.com")
    client.post("/api/auth/logout")
    _signup_and_verify(client, outbox)
    response = client.post("/api/account/email", data={"password": PASSWORD, "new_email": "other@example.com"})
    assert response.status_code == 202
    assert "?confirm-email=" not in outbox[-1]["body"]


def test_account_endpoints_need_a_session(client):
    assert client.get("/api/account/export").status_code == 401
    assert client.post("/api/account/delete", data={"password": PASSWORD}).status_code == 401


def test_export(client, outbox):
    account = _signup_and_verify(client, outbox)
    response = client.get("/api/account/export")
    assert response.status_code == 200
    assert "attachment" in response.headers["content-disposition"]
    data = response.json()
    assert data["account"]["id"] == account["id"]
    assert data["account"]["email"] == "rider@example.com"
    assert len(data["sessions"]) == 1
    assert "password" not in response.text


def test_delete_account(client, outbox, account_db):
    _signup_and_verify(client, outbox)
    assert client.post("/api/account/delete", data={"password": "wrong password!"}).status_code == 400
    assert client.post("/api/account/delete", data={"password": PASSWORD}).status_code == 204
    assert client.get("/api/auth/me").json()["account"] is None
    with psycopg.connect(account_db) as conn:
        for table in ("users", "sessions", "email_tokens"):
            assert conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
    assert client.post("/api/auth/login", data={"email": "rider@example.com", "password": PASSWORD}).status_code == 401


def test_login_is_rate_limited_per_email(client, outbox):
    _signup_and_verify(client, outbox)
    client.post("/api/auth/logout")
    statuses = [
        client.post("/api/auth/login", data={"email": "rider@example.com", "password": "wrong password!"}).status_code
        for _ in range(6)
    ]
    assert statuses[:5] == [401] * 5
    assert statuses[5] == 429


def test_emails_to_one_address_are_rate_limited(client, outbox):
    statuses = [
        client.post("/api/auth/forgot-password", data={"email": "nobody@example.com"}).status_code for _ in range(4)
    ]
    assert statuses == [202, 202, 202, 429]


@responses.activate
def test_captcha_required_when_configured(client, outbox, monkeypatch):
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", "secret")
    responses.post(turnstile.SITEVERIFY_URL, json={"success": False})
    response = client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": PASSWORD})
    assert response.status_code == 400
    responses.replace(responses.POST, turnstile.SITEVERIFY_URL, json={"success": True})
    response = client.post(
        "/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": PASSWORD, "turnstile_token": "tok"}
    )
    assert response.status_code == 202
    assert client.get("/api/auth/me").json()["captcha_required"] is True


def test_session_expiry(client, outbox, account_db):
    _signup_and_verify(client, outbox)
    with psycopg.connect(account_db, autocommit=True) as conn:
        conn.execute("UPDATE sessions SET expires_at = now() - interval '1 second'")
    assert client.get("/api/auth/me").json()["account"] is None


def test_session_slides_forward_when_used(client, outbox, account_db):
    _signup_and_verify(client, outbox)
    stale = sessions.TOUCH_INTERVAL + timedelta(minutes=5)
    with psycopg.connect(account_db, autocommit=True) as conn:
        conn.execute(
            "UPDATE sessions SET last_seen_at = now() - %s, expires_at = now() + interval '1 day'", (stale,)
        )
    client.get("/api/auth/me")
    with psycopg.connect(account_db) as conn:
        remaining = conn.execute("SELECT expires_at - now() FROM sessions").fetchone()[0]
    assert remaining > sessions.SESSION_TTL - timedelta(minutes=1)


def test_require_feature(outbox, account_db):
    from fastapi import FastAPI

    probe = FastAPI()

    @probe.get("/probe")
    def _probe(user: sessions.User = Depends(sessions.require_feature("llm"))):
        return {"ok": True}

    with TestClient(app, headers={"Origin": ORIGIN}) as main_client:
        _signup_and_verify(main_client, outbox)
        cookie = main_client.cookies.get(sessions.SESSION_COOKIE)
    # The probe app has no lifespan of its own; main's shutdown closed the pool.
    assert db.init_database()
    probe_client = TestClient(probe)
    assert probe_client.get("/probe").status_code == 401
    probe_client.cookies.set(sessions.SESSION_COOKIE, cookie)
    assert probe_client.get("/probe").status_code == 403
    with psycopg.connect(account_db, autocommit=True) as conn:
        conn.execute("UPDATE users SET features = array_append(features, 'llm')")
    assert probe_client.get("/probe").status_code == 200


def test_signup_asks_for_a_name(client, outbox):
    response = client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "  ", "email": "rider@example.com", "password": PASSWORD})
    assert response.status_code == 400
    response = client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "x" * 61, "email": "rider@example.com", "password": PASSWORD})
    assert response.status_code == 400
    assert outbox == []


def test_name_is_tidied_and_greets_by_name(client, outbox):
    response = client.post(
        "/api/auth/signup", data={"accept_privacy": "true", "name": " Ada \n  Lovelace\t", "email": "rider@example.com", "password": PASSWORD}
    )
    assert response.status_code == 202
    assert outbox[-1]["body"].startswith("Hi Ada Lovelace,\n\n")
    account = client.post("/api/auth/verify", data={"token": _link_token(outbox[-1], "verify")}).json()
    assert account["name"] == "Ada Lovelace"
    assert client.get("/api/auth/me").json()["account"]["name"] == "Ada Lovelace"


def test_duplicate_signup_greets_the_existing_owner(client, outbox):
    client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": PASSWORD})
    client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Mallory", "email": "rider@example.com", "password": PASSWORD})
    # The name typed the second time may not be the owner's - it's not used.
    assert outbox[-1]["body"].startswith("Hi Ada,")
    assert "Mallory" not in outbox[-1]["body"]


def test_change_name(client, outbox):
    _signup_and_verify(client, outbox)
    response = client.post("/api/account/name", data={"name": "Countess Ada"})
    assert response.status_code == 200
    assert response.json()["name"] == "Countess Ada"
    assert client.get("/api/account/export").json()["account"]["name"] == "Countess Ada"
    assert client.post("/api/account/name", data={"name": ""}).status_code in (400, 422)


def test_account_without_a_name(client, outbox, account_db):
    """Accounts made before names were asked have none - nothing breaks."""
    _signup_and_verify(client, outbox)
    with psycopg.connect(account_db, autocommit=True) as conn:
        conn.execute("UPDATE users SET name = NULL")
    assert client.get("/api/auth/me").json()["account"]["name"] is None
    client.post("/api/auth/resend-verification")
    client.post("/api/auth/logout")
    client.post("/api/auth/forgot-password", data={"email": "rider@example.com"})
    assert outbox[-1]["body"].startswith("Hi,\n\n")


def test_signup_needs_the_privacy_notice_accepted(client, outbox):
    for accept in (None, "false"):
        data = {"name": "Ada", "email": "rider@example.com", "password": PASSWORD}
        if accept is not None:
            data["accept_privacy"] = accept
        response = client.post("/api/auth/signup", data=data)
        assert response.status_code == 400
        assert "privacy notice" in response.json()["detail"]
    assert outbox == []


def test_acceptance_is_recorded_with_its_version(client, outbox):
    from waypointer import auth

    _signup_and_verify(client, outbox)
    account = client.get("/api/account/export").json()["account"]
    assert account["privacy_notice_version"] == auth.PRIVACY_VERSION
    assert account["privacy_notice_accepted_at"] is not None
