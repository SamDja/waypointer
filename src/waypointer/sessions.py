"""Login sessions: an opaque random token in an HttpOnly cookie, looked up
in the `sessions` table, plus the FastAPI dependencies that resolve it to a
user.

Server-side sessions rather than signed tokens (JWTs) so that logging out,
resetting a password or deleting an account takes effect at once - a row
is deleted and the cookie is worthless. Only the token's SHA-256 is stored.

The cookie is SameSite=Lax and every state-changing account endpoint also
checks the request's Origin (`require_same_origin`), which together cover
CSRF without a token of our own. `Secure` comes from COOKIE_SECURE (on
unless set to "0") rather than from the request's scheme, because behind the
Cloudflare tunnel this server only ever sees plain HTTP.
"""

import hashlib
import os
import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlparse

import psycopg
from fastapi import Depends, HTTPException, Request, Response, status

from waypointer import db

SESSION_COOKIE = "sv_session"
SESSION_TTL = timedelta(days=30)
# A session's expiry slides forward on use, but writing on every request
# would be a write per API call - once an hour is plenty.
TOUCH_INTERVAL = timedelta(hours=1)


@dataclass(frozen=True)
class User:
    id: str
    email: str
    email_verified: bool
    features: tuple[str, ...]
    created_at: datetime
    # What to call them; None for an account made before names were asked.
    name: str | None = None


USER_COLUMNS = "u.id::text, u.email::text, u.email_verified_at IS NOT NULL, u.features, u.created_at, u.name"
# Where a query's own extra columns start, after USER_COLUMNS - index past
# this rather than by number, so adding a user column can't shift them.
USER_COLUMN_COUNT = 6


def user_from_row(row) -> User:
    return User(
        id=row[0], email=row[1], email_verified=row[2], features=tuple(row[3]), created_at=row[4], name=row[5]
    )


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


@contextmanager
def connection() -> Iterator[psycopg.Connection]:
    """A pooled connection to the account database, with an unavailable
    database turned into the 503 every account endpoint answers with."""
    if not db.is_ready():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Accounts aren't available right now.")
    try:
        with db.get_pool().connection() as conn:
            yield conn
    except db.DbError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Accounts aren't available right now.") from exc
    except psycopg.OperationalError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Accounts aren't available right now.") from exc


def cookie_secure() -> bool:
    return os.environ.get("COOKIE_SECURE", "1") != "0"


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(SESSION_TTL.total_seconds()),
        httponly=True,
        secure=cookie_secure(),
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, secure=cookie_secure(), samesite="lax")


def create_session(conn: psycopg.Connection, user_id: str, user_agent: str | None) -> str:
    token = new_token()
    # Every expiry is computed by the database's clock, never this
    # process's, so a skew between the two can't shorten or stretch one.
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (%s, %s, now() + %s, %s)",
        (hash_token(token), user_id, SESSION_TTL, (user_agent or "")[:300]),
    )
    return token


def start_session(conn: psycopg.Connection, user_id: str, request: Request, response: Response) -> None:
    """Logs `user_id` in on this browser."""
    token = create_session(conn, user_id, request.headers.get("user-agent"))
    conn.execute("UPDATE users SET last_login_at = now() WHERE id = %s", (user_id,))
    set_session_cookie(response, token)


def session_token(request: Request) -> str | None:
    return request.cookies.get(SESSION_COOKIE) or None


def current_user_optional(request: Request, response: Response) -> User | None:
    token = session_token(request)
    if token is None:
        return None
    with connection() as conn:
        row = conn.execute(
            f"SELECT {USER_COLUMNS}, now() - s.last_seen_at > %s FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.token_hash = %s AND s.expires_at > now()",
            (TOUCH_INTERVAL, hash_token(token)),
        ).fetchone()
        if row is None:
            clear_session_cookie(response)
            return None
        if row[USER_COLUMN_COUNT]:
            conn.execute(
                "UPDATE sessions SET last_seen_at = now(), expires_at = now() + %s WHERE token_hash = %s",
                (SESSION_TTL, hash_token(token)),
            )
            set_session_cookie(response, token)
    return user_from_row(row)


def require_user(user: User | None = Depends(current_user_optional)) -> User:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Please sign in first.")
    return user


def require_verified_user(user: User = Depends(require_user)) -> User:
    if not user.email_verified:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Please verify your email address first.")
    return user


def require_feature(name: str):
    """A dependency admitting only verified users with `name` in their
    `features` - how a test-phase feature is limited to accounts switched on
    by hand (UPDATE users SET features = array_append(features, 'llm') ...)."""

    def dependency(user: User = Depends(require_verified_user)) -> User:
        if name not in user.features:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This feature isn't available on your account yet.")
        return user

    return dependency


def expected_origin_host(request: Request) -> str:
    base = os.environ.get("PUBLIC_BASE_URL", "").strip()
    if base:
        return urlparse(base).netloc
    return request.headers.get("host", "")


def require_same_origin(request: Request) -> None:
    """CSRF guard for state-changing account endpoints: the request must come
    from a page on this site. Browsers send Origin on every POST; Referer is
    the fallback for the few that strip it."""
    source = request.headers.get("origin") or request.headers.get("referer")
    if not source or urlparse(source).netloc != expected_origin_host(request):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This request didn't come from Sulla Via.")
