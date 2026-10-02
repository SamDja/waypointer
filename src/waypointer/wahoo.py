"""Wahoo Cloud API client: the OAuth exchange and refresh, plus the route
calls the app makes (list, push, rename, delete) and the profile name.

Server-side since accounts arrived: the tokens are stored, encrypted, with
the visitor's account (connections.py), so they reach any device the
visitor signs in on, and refreshing happens in one place. That matters more
for Wahoo than for most: Wahoo revokes the previous token pair once a
refreshed token is used and caps unrevoked tokens per app and user, so two
browser tabs refreshing at once could each strand the other's tokens -
connections.py serialises refreshes with a row lock instead.

Still Wahoo's PKCE public-client flow: the browser makes the code verifier
and keeps it until the popup returns, then sends it with the code for this
module to exchange. WAHOO_CLIENT_ID is runtime env (formerly the
VITE_WAHOO_CLIENT_ID build arg); WAHOO_CLIENT_SECRET is optional and only
sent if set, for an app registered as a confidential client.
"""

import base64
import os
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import requests

from waypointer.routing import USER_AGENT

WAHOO_API_BASE = "https://api.wahooligan.com"
# Space-delimited per OAuth2. routes_read lists routes to import or manage,
# routes_write pushes, renames and deletes them, user_read gives the name.
WAHOO_SCOPES = "user_read routes_read routes_write"
TIMEOUT_S = 20
# Wahoo's workout_type_family_id taxonomy: 0 = biking. Only the cycling
# activity offers a push (see MapStyleConfig.wahooSync in the frontend).
WORKOUT_TYPE_FAMILY_ID_BIKING = 0


class WahooError(RuntimeError):
    """Wahoo failed or returned something unusable."""


class WahooNotConfiguredError(WahooError):
    """WAHOO_CLIENT_ID isn't set on this server."""


class WahooUnauthorizedError(WahooError):
    """Wahoo refused the token or code - only connecting again fixes it."""


class WahooRateLimitedError(WahooError):
    """Wahoo is throttling this app."""


@dataclass(frozen=True)
class WahooTokens:
    access_token: str
    refresh_token: str
    # Epoch seconds.
    expires_at: int
    scope: str | None


@dataclass(frozen=True)
class WahooRoute:
    id: int
    name: str
    distance_m: float
    ascent_m: float
    created_at: str
    file_url: str
    start_lat: float
    start_lng: float


@dataclass(frozen=True)
class WahooRouteUpload:
    fit_bytes: bytes
    filename: str
    name: str
    distance_m: float
    ascent_m: float
    start_lat: float
    start_lng: float


def client_id() -> str:
    value = os.environ.get("WAHOO_CLIENT_ID", "").strip()
    if not value:
        raise WahooNotConfiguredError("Wahoo isn't configured on this server.")
    return value


def is_configured() -> bool:
    return bool(os.environ.get("WAHOO_CLIENT_ID", "").strip())


def _check(response: requests.Response, what: str) -> None:
    if response.status_code == 429:
        raise WahooRateLimitedError(f"Wahoo rate limit reached ({what}).")
    if response.status_code == 401:
        raise WahooUnauthorizedError(f"Wahoo refused the token ({what}).")
    if not 200 <= response.status_code < 300:
        raise WahooError(f"Wahoo returned status {response.status_code} for {what}: {response.text[:200]}")


def _send(
    method: str, path: str, what: str, access_token: str, session: requests.Session | None = None, **kwargs
) -> requests.Response:
    http = session or requests
    headers = {"User-Agent": USER_AGENT, "Authorization": f"Bearer {access_token}"}
    try:
        response = http.request(method, f"{WAHOO_API_BASE}{path}", headers=headers, timeout=TIMEOUT_S, **kwargs)
    except requests.RequestException as exc:
        raise WahooError(f"Couldn't reach Wahoo ({what}): {exc}") from exc
    _check(response, what)
    return response


def authorize_url(redirect_uri: str, state: str, code_challenge: str) -> str:
    params = {
        "client_id": client_id(),
        "redirect_uri": redirect_uri,
        "scope": WAHOO_SCOPES,
        "response_type": "code",
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    return f"{WAHOO_API_BASE}/oauth/authorize?{urlencode(params)}"


def _token_request(params: dict[str, str], session: requests.Session | None) -> WahooTokens:
    payload = {"client_id": client_id(), **params}
    secret = os.environ.get("WAHOO_CLIENT_SECRET", "").strip()
    if secret:
        payload["client_secret"] = secret
    http = session or requests
    try:
        response = http.post(
            f"{WAHOO_API_BASE}/oauth/token", data=payload, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT_S
        )
    except requests.RequestException as exc:
        raise WahooError(f"Couldn't reach Wahoo (token): {exc}") from exc
    # A bad code/verifier or a revoked refresh token is a 400 or 401.
    if response.status_code in (400, 401):
        raise WahooUnauthorizedError(f"Wahoo refused the authorization: {response.text[:200]}")
    _check(response, "token")
    try:
        data = response.json()
        return WahooTokens(
            access_token=str(data["access_token"]),
            refresh_token=str(data["refresh_token"]),
            expires_at=int(time.time()) + int(data["expires_in"]),
            scope=data.get("scope"),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise WahooError(f"Wahoo returned malformed tokens: {exc}") from exc


def exchange_code(
    code: str, code_verifier: str, redirect_uri: str, session: requests.Session | None = None
) -> WahooTokens:
    return _token_request(
        {
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
        session,
    )


def refresh_tokens(refresh_token: str, session: requests.Session | None = None) -> WahooTokens:
    return _token_request({"refresh_token": refresh_token, "grant_type": "refresh_token"}, session)


def revoke(access_token: str, session: requests.Session | None = None) -> None:
    """Revokes this app's access. Wahoo caps unrevoked tokens per app and
    user, so a disconnect must really revoke, not only forget the token."""
    _send("DELETE", "/v1/permissions", "revoke", access_token, session)


def user_label(access_token: str, session: requests.Session | None = None) -> str | None:
    """The account's display name ("First Last"), or None if Wahoo won't say."""
    try:
        data = _send("GET", "/v1/user", "user", access_token, session).json()
    except (WahooError, ValueError):
        return None
    label = " ".join(p for p in (data.get("first"), data.get("last")) if p).strip()
    return label or None


def _route(raw: dict) -> WahooRoute:
    return WahooRoute(
        id=int(raw["id"]),
        name=str(raw.get("name") or ""),
        distance_m=float(raw.get("distance") or 0),
        ascent_m=float(raw.get("ascent") or 0),
        created_at=str(raw.get("created_at") or ""),
        file_url=str((raw.get("file") or {}).get("url") or ""),
        start_lat=float(raw.get("start_lat") or 0),
        start_lng=float(raw.get("start_lng") or 0),
    )


def list_routes(access_token: str, session: requests.Session | None = None) -> list[WahooRoute]:
    try:
        data = _send("GET", "/v1/routes", "routes", access_token, session).json()
        return [_route(raw) for raw in data]
    except (KeyError, TypeError, ValueError) as exc:
        raise WahooError(f"Wahoo returned malformed routes: {exc}") from exc


def get_route(access_token: str, route_id: int, session: requests.Session | None = None) -> WahooRoute:
    try:
        return _route(_send("GET", f"/v1/routes/{route_id}", "route", access_token, session).json())
    except (KeyError, TypeError, ValueError) as exc:
        raise WahooError(f"Wahoo returned a malformed route: {exc}") from exc


def push_route(
    access_token: str, upload: WahooRouteUpload, external_id: str, updated_at: str,
    session: requests.Session | None = None,
) -> None:
    """Creates a new Wahoo route from a FIT course."""
    fields = {
        # A data URI, not bare base64: without the prefix Wahoo creates the
        # route record but can't parse the file, so it never loads.
        "route[file]": "data:application/vnd.fit;base64," + base64.b64encode(upload.fit_bytes).decode("ascii"),
        "route[filename]": upload.filename,
        # Each push creates a new route rather than updating an earlier one.
        "route[external_id]": external_id,
        "route[provider_updated_at]": updated_at,
        "route[name]": upload.name,
        "route[workout_type_family_id]": str(WORKOUT_TYPE_FAMILY_ID_BIKING),
        "route[start_lat]": str(upload.start_lat),
        "route[start_lng]": str(upload.start_lng),
        "route[distance]": str(upload.distance_m),
        "route[ascent]": str(upload.ascent_m),
    }
    _send("POST", "/v1/routes", "push route", access_token, session, data=fields)


def rename_route(
    access_token: str, route_id: int, name: str, updated_at: str, session: requests.Session | None = None
) -> None:
    """Wahoo's PUT requires the route's position, distance and ascent on every
    update, so a rename re-sends the route's current values for those."""
    route = get_route(access_token, route_id, session)
    fields = {
        "route[name]": name,
        "route[provider_updated_at]": updated_at,
        "route[start_lat]": str(route.start_lat),
        "route[start_lng]": str(route.start_lng),
        "route[distance]": str(route.distance_m),
        "route[ascent]": str(route.ascent_m),
    }
    _send("PUT", f"/v1/routes/{route_id}", "rename route", access_token, session, data=fields)


def delete_route(access_token: str, route_id: int, session: requests.Session | None = None) -> None:
    _send("DELETE", f"/v1/routes/{route_id}", "delete route", access_token, session)
