"""The cleanup job (cleanup.py) against the throwaway account database:
it removes exactly what the privacy notice says goes, and nothing still in
use."""

from datetime import datetime, timedelta

import psycopg
import pytest

from account_helpers import ACCOUNT_PASSWORD, link_token, signup_and_verify
from waypointer import cleanup, db, rate_limit


@pytest.fixture(autouse=True)
def _db(account_db):
    yield


def _count(url, sql):
    with psycopg.connect(url) as conn:
        return conn.execute(sql).fetchone()[0]


def _purge(url):
    with psycopg.connect(url) as conn:
        return cleanup.purge_expired(conn)


def test_removes_expired_sessions_only(client, outbox, account_db):
    signup_and_verify(client, outbox)
    client.post("/api/auth/login", data={"email": "rider@example.com", "password": ACCOUNT_PASSWORD})
    assert _count(account_db, "SELECT count(*) FROM sessions") == 2
    with psycopg.connect(account_db, autocommit=True) as conn:
        conn.execute(
            "UPDATE sessions SET expires_at = now() - interval '1 minute'"
            " WHERE created_at = (SELECT min(created_at) FROM sessions)"
        )
    assert _purge(account_db)["sessions"] == 1
    # The live one still works.
    assert client.get("/api/auth/me").json()["account"] is not None


def test_removes_spent_and_expired_links(client, outbox, account_db):
    signup_and_verify(client, outbox)  # spends the verification link
    client.post("/api/auth/forgot-password", data={"email": "rider@example.com"})
    live = link_token(outbox[-1], "reset")
    client.post("/api/auth/forgot-password", data={"email": "rider@example.com"})  # supersedes `live`
    current = link_token(outbox[-1], "reset")
    assert _purge(account_db)["email_tokens"] == 2  # the verify link and the superseded reset link
    assert _count(account_db, "SELECT count(*) FROM email_tokens") == 1
    assert client.post("/api/auth/reset-password", data={"token": live, "password": "a brand new password"}).status_code == 400
    assert client.post("/api/auth/reset-password", data={"token": current, "password": "a brand new password"}).status_code == 200


def test_deletes_accounts_left_unverified(client, outbox, account_db):
    client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Old", "email": "old@example.com", "password": ACCOUNT_PASSWORD})
    client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "New", "email": "new@example.com", "password": ACCOUNT_PASSWORD})
    signup_and_verify(client, outbox, email="kept@example.com")
    with psycopg.connect(account_db, autocommit=True) as conn:
        # Past the deadline: an unverified one, and a verified one just as old.
        conn.execute(
            "UPDATE users SET created_at = now() - %s - interval '1 minute' WHERE email IN ('old@example.com', 'kept@example.com')",
            (cleanup.UNVERIFIED_ACCOUNT_TTL,),
        )
    assert _purge(account_db)["unverified_accounts"] == 1
    with psycopg.connect(account_db) as conn:
        emails = {row[0] for row in conn.execute("SELECT email::text FROM users")}
    assert emails == {"new@example.com", "kept@example.com"}


def test_unverified_account_is_told_its_deadline(client, outbox):
    client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": "rider@example.com", "password": ACCOUNT_PASSWORD})
    assert f"within {cleanup.UNVERIFIED_ACCOUNT_TTL.days} days" in outbox[-1]["body"]
    client.post("/api/auth/login", data={"email": "rider@example.com", "password": ACCOUNT_PASSWORD})
    account = client.get("/api/auth/me").json()["account"]
    deadline = datetime.fromisoformat(account["delete_unverified_at"])
    created = datetime.fromisoformat(account["created_at"])
    assert deadline - created == cleanup.UNVERIFIED_ACCOUNT_TTL
    # Once verified, there's no deadline.
    client.post("/api/auth/verify", data={"token": link_token(outbox[-1], "verify")})
    assert client.get("/api/auth/me").json()["account"]["delete_unverified_at"] is None


def test_run_once_without_a_database(monkeypatch):
    monkeypatch.delenv(db.DATABASE_URL_ENV)
    cleanup.run_once()  # must not raise


def test_rate_limiter_forgets_idle_addresses():
    rate_limit.check_rate("find_pois", "203.0.113.1", 10, rate_limit.WINDOW_S)
    rate_limit.check_rate("find_pois", "203.0.113.2", 10, rate_limit.WINDOW_S)
    stamp = rate_limit._requests_by_ip[("find_pois", "203.0.113.1")][-1]
    # Nothing has aged out of the longest window yet.
    assert rate_limit.prune(now=stamp + rate_limit.LONGEST_WINDOW_S - 1) == 0
    assert rate_limit.prune(now=stamp + rate_limit.LONGEST_WINDOW_S + 1) == 2
    assert not rate_limit._requests_by_ip
