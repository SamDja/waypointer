"""Fitness-app connections (Strava, Wahoo) stored with the visitor's account.

Connecting an app needs a verified account; the tokens are encrypted at rest
(token_crypto.py), refreshed here on the server and never sent to the
browser, which only ever learns whether an app is connected and under what
name. So a connection made on one device works on every device the visitor
signs in on, and nothing about it sits in browser storage.

`access_token()` is the one way a token is used: it locks the connection's
row (SELECT ... FOR UPDATE) for the duration of a refresh, so two requests
needing a refresh at once don't both spend the same refresh token - for
Wahoo, which revokes the previous pair as soon as a refreshed one is used,
that race would strand whichever request lost it. If the app refuses the
refresh, the connection is dropped: only connecting again can fix it.

Connections held in a browser from before accounts existed come in through
`/api/connections/import`, which refreshes them once to prove they're live
(and to learn whose they are) before storing them.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import urlparse

import psycopg
from fastapi import APIRouter, Depends, Form, HTTPException, Query, Response, status

from waypointer import strava, token_crypto, wahoo
from waypointer.rate_limit import strava_rate_limit, wahoo_rate_limit
from waypointer.schemas import AuthorizeUrl, ConnectionResponse
from waypointer.sessions import User, connection, require_same_origin, require_user, require_verified_user

Provider = Literal["strava", "wahoo"]
PROVIDER_NAMES: dict[str, str] = {"strava": "Strava", "wahoo": "Wahoo"}
# Refresh this long before Wahoo/Strava's own expiry, so a token isn't
# handed out moments before it stops working mid-request.
REFRESH_BUFFER = timedelta(minutes=5)
# The only redirects an authorize URL is built for: each app's own popup
# callback page in frontend/public. Wahoo additionally requires an exact
# match with a URI registered in its developer dashboard.
CALLBACK_PATHS: dict[str, str] = {"strava": "/strava-callback.html", "wahoo": "/wahoo-callback.html"}
# How long to tell the browser to back off when an app throttles us.
UPSTREAM_RETRY_AFTER_S = 30

logger = logging.getLogger(__name__)
router = APIRouter()


class NotConnectedError(Exception):
    def __init__(self, provider: str):
        super().__init__(provider)
        self.provider = provider


@dataclass(frozen=True)
class Tokens:
    access_token: str
    refresh_token: str
    # Epoch seconds.
    expires_at: int
    scope: str | None


@dataclass(frozen=True)
class StoredConnection:
    provider: str
    external_id: str | None
    label: str | None
    scope: str | None
    created_at: datetime


# --- errors ----------------------------------------------------------------


def provider_http_error(exc: Exception) -> HTTPException:
    """A Strava/Wahoo failure (or a missing connection) as the response the
    frontend expects: 401 means connect again, 429 means back off, 503 means
    this server isn't set up for it, anything else is a 502."""
    if isinstance(exc, NotConnectedError):
        return HTTPException(status.HTTP_401_UNAUTHORIZED, f"Connect {PROVIDER_NAMES[exc.provider]} first.")
    if isinstance(exc, token_crypto.TokenCryptoError):
        logger.error("Connection tokens unavailable: %s", exc)
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Connecting apps isn't set up on this server.")
    name = "Strava" if isinstance(exc, strava.StravaError) else "Wahoo"
    if isinstance(exc, (strava.StravaNotConfiguredError, wahoo.WahooNotConfiguredError)):
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"{name} isn't set up on this server.")
    if isinstance(exc, (strava.StravaUnauthorizedError, wahoo.WahooUnauthorizedError)):
        return HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            f"{name} didn't accept your connection any more - please connect {name} again.",
        )
    if isinstance(exc, (strava.StravaRateLimitedError, wahoo.WahooRateLimitedError)):
        return HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"{name} is busy - please wait a moment and try again.",
            headers={"Retry-After": str(UPSTREAM_RETRY_AFTER_S)},
        )
    return HTTPException(status.HTTP_502_BAD_GATEWAY, f"{name} request failed: {exc}")


def _unauthorized(exc: Exception) -> bool:
    return isinstance(exc, (strava.StravaUnauthorizedError, wahoo.WahooUnauthorizedError))


# --- storage ---------------------------------------------------------------


def _refresh(provider: str, refresh_token: str, previous_scope: str | None) -> Tokens:
    if provider == "strava":
        t = strava.refresh_tokens(refresh_token)
        # Strava's refresh doesn't restate the scope; it can't have changed.
        return Tokens(t.access_token, t.refresh_token, t.expires_at, previous_scope)
    t = wahoo.refresh_tokens(refresh_token)
    return Tokens(t.access_token, t.refresh_token, t.expires_at, t.scope or previous_scope)


def save_connection(
    conn: psycopg.Connection,
    user_id: str,
    provider: str,
    tokens: Tokens,
    external_id: str | None,
    label: str | None,
) -> None:
    expires = datetime.fromtimestamp(tokens.expires_at, timezone.utc)
    conn.execute(
        "INSERT INTO connections"
        " (user_id, provider, access_token_enc, refresh_token_enc, expires_at, external_id, label, scope)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
        " ON CONFLICT (user_id, provider) DO UPDATE SET"
        " access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,"
        " expires_at = excluded.expires_at, external_id = excluded.external_id, label = excluded.label,"
        " scope = excluded.scope, updated_at = now()",
        (
            user_id,
            provider,
            token_crypto.encrypt(tokens.access_token),
            token_crypto.encrypt(tokens.refresh_token),
            expires,
            external_id,
            label,
            tokens.scope,
        ),
    )


def list_connections(conn: psycopg.Connection, user_id: str) -> list[StoredConnection]:
    rows = conn.execute(
        "SELECT provider, external_id, label, scope, created_at FROM connections"
        " WHERE user_id = %s ORDER BY provider",
        (user_id,),
    ).fetchall()
    return [StoredConnection(*row) for row in rows]


def access_token(user_id: str, provider: str) -> tuple[str, str | None]:
    """A usable access token for this user's connection, and its
    external_id (Strava's athlete id). Refreshes it first if it's about to
    expire. Raises NotConnectedError, a provider error, or TokenCryptoError."""
    dropped: Exception | None = None
    with connection() as conn:
        with conn.transaction():
            row = conn.execute(
                "SELECT access_token_enc, refresh_token_enc, expires_at - now() > %s, external_id, label, scope"
                " FROM connections WHERE user_id = %s AND provider = %s FOR UPDATE",
                (REFRESH_BUFFER, user_id, provider),
            ).fetchone()
            if row is None:
                raise NotConnectedError(provider)
            # expires_at is the app's own expiry (epoch seconds from its token
            # response), compared here by the database's clock.
            access_enc, refresh_enc, still_fresh, external_id, label, scope = row
            if still_fresh:
                return token_crypto.decrypt(access_enc), external_id
            try:
                tokens = _refresh(provider, token_crypto.decrypt(refresh_enc), scope)
            except Exception as exc:
                if not _unauthorized(exc):
                    raise
                # The app no longer accepts this connection - forget it, so
                # the visitor is shown as disconnected and can connect again.
                conn.execute("DELETE FROM connections WHERE user_id = %s AND provider = %s", (user_id, provider))
                dropped = exc
            else:
                save_connection(conn, user_id, provider, tokens, external_id, label)
                return tokens.access_token, external_id
    raise dropped


def _revoke(provider: str, token: str) -> None:
    if provider == "strava":
        strava.deauthorize(token)
    else:
        wahoo.revoke(token)


def revoke_all(user_id: str) -> None:
    """Best-effort revoke of every connection at the app's end - used before
    an account is deleted, so no live grant is left behind on Strava/Wahoo."""
    with connection() as conn:
        providers = [c.provider for c in list_connections(conn, user_id)]
    for provider in providers:
        try:
            token, _ = access_token(user_id, provider)
            _revoke(provider, token)
        except Exception as exc:  # noqa: BLE001 - best-effort, the row goes regardless
            logger.warning("Couldn't revoke %s for a deleted account: %s", provider, exc)


def _response(stored: StoredConnection) -> ConnectionResponse:
    return ConnectionResponse(
        provider=stored.provider,
        label=stored.label,
        scope=stored.scope,
        connected_at=stored.created_at.isoformat(),
    )


def _stored(user_id: str, provider: str) -> ConnectionResponse:
    with connection() as conn:
        found = [c for c in list_connections(conn, user_id) if c.provider == provider]
    return _response(found[0])


def _check_callback(provider: str, redirect_uri: str) -> None:
    parsed = urlparse(redirect_uri)
    path = CALLBACK_PATHS[provider]
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.path != path:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"redirect_uri must point at {path}.")


def _store(user: User, provider: str, tokens: Tokens, external_id: str | None, label: str | None) -> None:
    try:
        with connection() as conn:
            save_connection(conn, user.id, provider, tokens, external_id, label)
    except token_crypto.TokenCryptoError as exc:
        raise provider_http_error(exc) from exc


def _require_crypto() -> None:
    # Checked before an OAuth round trip starts, rather than discovered at
    # the end of one with nowhere to keep the tokens.
    if not token_crypto.is_configured():
        raise provider_http_error(token_crypto.TokenCryptoError("no key"))


# --- endpoints: listing ----------------------------------------------------


@router.get("/api/connections", response_model=list[ConnectionResponse])
def get_connections(user: User = Depends(require_user)) -> list[ConnectionResponse]:
    with connection() as conn:
        return [_response(c) for c in list_connections(conn, user.id)]


@router.post(
    "/api/connections/{provider}/disconnect",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_same_origin), Depends(strava_rate_limit)],
)
def disconnect(provider: Provider, user: User = Depends(require_user)) -> Response:
    """Revokes access at the app's end, then forgets the connection - which
    happens whether or not the revoke worked (an expired grant has nothing
    left to revoke), so the visitor is never stuck "connected"."""
    try:
        token, _ = access_token(user.id, provider)
        _revoke(provider, token)
    except NotConnectedError:
        pass
    except Exception as exc:  # noqa: BLE001 - best-effort
        logger.warning("Revoking %s failed: %s", provider, exc)
    with connection() as conn:
        conn.execute("DELETE FROM connections WHERE user_id = %s AND provider = %s", (user.id, provider))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- endpoints: Strava -----------------------------------------------------


@router.get(
    "/api/strava/authorize-url",
    response_model=AuthorizeUrl,
    dependencies=[Depends(strava_rate_limit)],
)
def strava_authorize_url(
    redirect_uri: str, state: str, _user: User = Depends(require_verified_user)
) -> AuthorizeUrl:
    """Where the Strava connect popup should go. Built here because the
    client id is configured alongside the secret, in the server's env."""
    _check_callback("strava", redirect_uri)
    _require_crypto()
    try:
        return AuthorizeUrl(url=strava.authorize_url(redirect_uri, state))
    except strava.StravaError as exc:
        raise provider_http_error(exc) from exc


@router.post(
    "/api/strava/connect",
    response_model=ConnectionResponse,
    dependencies=[Depends(require_same_origin), Depends(strava_rate_limit)],
)
def strava_connect(
    code: str = Form(...), scope: str | None = Form(None), user: User = Depends(require_verified_user)
) -> ConnectionResponse:
    """Exchanges the popup's code (the step that needs the client secret)
    and stores the tokens with the account. Strava reports the granted
    scope on the redirect, not in the token response, so the popup passes
    it along."""
    try:
        t = strava.exchange_code(code)
    except strava.StravaError as exc:
        raise provider_http_error(exc) from exc
    if t.athlete_id is None:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Strava didn't say which athlete connected.")
    _store(user, "strava", Tokens(t.access_token, t.refresh_token, t.expires_at, scope), str(t.athlete_id), t.athlete_label)
    return _stored(user.id, "strava")


# --- endpoints: Wahoo ------------------------------------------------------


@router.get(
    "/api/wahoo/authorize-url",
    response_model=AuthorizeUrl,
    dependencies=[Depends(wahoo_rate_limit)],
)
def wahoo_authorize_url(
    redirect_uri: str,
    state: str,
    code_challenge: str = Query(..., min_length=43, max_length=128),
    _user: User = Depends(require_verified_user),
) -> AuthorizeUrl:
    """Where the Wahoo connect popup should go. The browser made the PKCE
    verifier and sends only its challenge; it hands the verifier to
    /api/wahoo/connect with the code."""
    _check_callback("wahoo", redirect_uri)
    _require_crypto()
    try:
        return AuthorizeUrl(url=wahoo.authorize_url(redirect_uri, state, code_challenge))
    except wahoo.WahooError as exc:
        raise provider_http_error(exc) from exc


@router.post(
    "/api/wahoo/connect",
    response_model=ConnectionResponse,
    dependencies=[Depends(require_same_origin), Depends(wahoo_rate_limit)],
)
def wahoo_connect(
    code: str = Form(...),
    code_verifier: str = Form(..., min_length=43, max_length=128),
    redirect_uri: str = Form(...),
    user: User = Depends(require_verified_user),
) -> ConnectionResponse:
    _check_callback("wahoo", redirect_uri)
    try:
        t = wahoo.exchange_code(code, code_verifier, redirect_uri)
    except wahoo.WahooError as exc:
        raise provider_http_error(exc) from exc
    # Best-effort: a connection without a display name still works.
    label = wahoo.user_label(t.access_token)
    _store(user, "wahoo", Tokens(t.access_token, t.refresh_token, t.expires_at, t.scope), None, label)
    return _stored(user.id, "wahoo")


# --- endpoint: importing a browser-held connection -------------------------


@router.post(
    "/api/connections/import",
    response_model=ConnectionResponse,
    dependencies=[Depends(require_same_origin), Depends(strava_rate_limit)],
)
def import_connection(
    provider: Provider = Form(...),
    refresh_token: str = Form(..., min_length=1, max_length=2000),
    scope: str | None = Form(None),
    user: User = Depends(require_verified_user),
) -> ConnectionResponse:
    """Moves a connection the browser held before accounts existed into the
    account. Only the refresh token is taken from the browser: it's spent
    straight away, which both proves the connection is still live and
    replaces it with a fresh pair only the server knows (for Wahoo, that
    also revokes the browser's copy). Whose account it is comes from the
    app itself, never from the browser."""
    name = PROVIDER_NAMES[provider]
    try:
        tokens = _refresh(provider, refresh_token, scope)
        if provider == "strava":
            athlete_id, label = strava.get_athlete(tokens.access_token)
            external_id: str | None = str(athlete_id)
        else:
            external_id, label = None, wahoo.user_label(tokens.access_token)
    except Exception as exc:
        if _unauthorized(exc):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Your {name} connection has expired - please connect {name} again."
            ) from exc
        if isinstance(exc, (strava.StravaError, wahoo.WahooError)):
            raise provider_http_error(exc) from exc
        raise
    _store(user, provider, tokens, external_id, label)
    return _stored(user.id, provider)
