"""Strava account connection and route import (/api/strava/*).

Unlike Wahoo (a PKCE public client, called straight from the browser - see
frontend/src/lib/wahooAuth.ts), Strava's token exchange needs the app's
client_secret and Strava supports no PKCE, so the exchange has to happen
here. Every other Strava call is proxied here too, so the browser only ever
talks to this app: one place for the per-app rate limit, the error mapping
and the credentials, and no dependence on Strava's CORS headers.

Still stateless: the visitor's tokens live in their browser (localStorage)
and are handed to each request that needs them, never stored or logged
here. Strava's API has no route write endpoints at all (no create, rename
or delete - /uploads takes activities only), so this module only reads.

Structured like routing.py/geocode.py - an external HTTP dependency with the
shared User-Agent and a small set of errors main.py maps to status codes.
"""

import os
from dataclasses import dataclass
from urllib.parse import urlencode

import requests

from waypointer.routing import USER_AGENT

STRAVA_OAUTH_BASE = "https://www.strava.com/oauth"
STRAVA_API_BASE = "https://www.strava.com/api/v3"

# `read` covers public routes, `read_all` private ones - most people's
# planned routes are private. Strava's scopes are comma-separated.
STRAVA_SCOPES = "read,read_all"

# Strava pages route lists; stop after this many so a runaway account can't
# turn one dialog opening into dozens of calls against the per-app quota.
ROUTES_PER_PAGE = 100
MAX_ROUTE_PAGES = 5

TIMEOUT_S = 20


class StravaError(RuntimeError):
    """Strava failed or answered something unusable."""


class StravaNotConfiguredError(StravaError):
    """STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET aren't set on this server."""


class StravaUnauthorizedError(StravaError):
    """Strava refused the token or authorization code - the visitor has to
    connect again."""


class StravaRateLimitedError(StravaError):
    """Strava answered 429 - see routing.RoutingRateLimitedError."""


@dataclass(frozen=True)
class StravaTokens:
    access_token: str
    refresh_token: str
    # Epoch seconds, as Strava sends it.
    expires_at: int
    # Only a code exchange carries the athlete; a refresh doesn't.
    athlete_id: int | None
    athlete_label: str | None


@dataclass(frozen=True)
class StravaRoute:
    # id_str, not id: Strava's route ids overflow a JS number's safe range.
    id: str
    name: str
    distance_m: float
    ascent_m: float
    created_at: str


def _credentials() -> tuple[str, str]:
    # Read per call rather than at import, so a missing value is a clear
    # per-request error rather than a startup failure for every visitor
    # who never touches Strava.
    client_id = os.environ.get("STRAVA_CLIENT_ID", "").strip()
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise StravaNotConfiguredError("Strava isn't configured on this server.")
    return client_id, client_secret


def _check(response: requests.Response, what: str) -> None:
    if response.status_code == 429:
        raise StravaRateLimitedError(f"Strava rate limit reached ({what}).")
    if response.status_code == 401:
        raise StravaUnauthorizedError(f"Strava refused the token ({what}).")
    if response.status_code != 200:
        raise StravaError(f"Strava returned status {response.status_code} for {what}: {response.text[:200]}")


def _send(method: str, url: str, what: str, session: requests.Session | None = None, **kwargs) -> requests.Response:
    http = session or requests
    headers = {"User-Agent": USER_AGENT, **kwargs.pop("headers", {})}
    try:
        response = http.request(method, url, headers=headers, timeout=TIMEOUT_S, **kwargs)
    except requests.RequestException as exc:
        raise StravaError(f"Couldn't reach Strava ({what}): {exc}") from exc
    _check(response, what)
    return response


def _bearer(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


def authorize_url(redirect_uri: str, state: str) -> str:
    """Where the connect popup sends the visitor to approve access."""
    client_id, _ = _credentials()
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "approval_prompt": "auto",
        "scope": STRAVA_SCOPES,
        "state": state,
    }
    return f"{STRAVA_OAUTH_BASE}/authorize?{urlencode(params)}"


def _tokens(data: dict) -> StravaTokens:
    try:
        athlete = data.get("athlete") or {}
        label = " ".join(p for p in (athlete.get("firstname"), athlete.get("lastname")) if p).strip()
        return StravaTokens(
            access_token=str(data["access_token"]),
            refresh_token=str(data["refresh_token"]),
            expires_at=int(data["expires_at"]),
            athlete_id=int(athlete["id"]) if "id" in athlete else None,
            athlete_label=label or None,
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise StravaError(f"Strava returned malformed tokens: {exc}") from exc


def _token_request(params: dict[str, str], session: requests.Session | None) -> StravaTokens:
    client_id, client_secret = _credentials()
    payload = {"client_id": client_id, "client_secret": client_secret, **params}
    http = session or requests
    try:
        response = http.post(
            f"{STRAVA_OAUTH_BASE}/token", data=payload, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT_S
        )
    except requests.RequestException as exc:
        raise StravaError(f"Couldn't reach Strava (token): {exc}") from exc
    # A bad or already-used code, or a revoked refresh token, comes back as
    # a 400 (not a 401) - either way only connecting again fixes it.
    if response.status_code in (400, 401):
        raise StravaUnauthorizedError("Strava refused the authorization.")
    _check(response, "token")
    try:
        return _tokens(response.json())
    except ValueError as exc:
        raise StravaError(f"Strava returned malformed tokens: {exc}") from exc


def exchange_code(code: str, session: requests.Session | None = None) -> StravaTokens:
    return _token_request({"code": code, "grant_type": "authorization_code"}, session)


def refresh_tokens(refresh_token: str, session: requests.Session | None = None) -> StravaTokens:
    return _token_request({"refresh_token": refresh_token, "grant_type": "refresh_token"}, session)


def deauthorize(access_token: str, session: requests.Session | None = None) -> None:
    """Revokes this app's access to the visitor's account, so disconnecting
    doesn't leave a live grant behind on Strava's side."""
    _send(
        "POST", f"{STRAVA_OAUTH_BASE}/deauthorize", "deauthorize", session, data={"access_token": access_token}
    )


def _route(raw: dict) -> StravaRoute | None:
    try:
        route_id = str(raw.get("id_str") or raw["id"])
        return StravaRoute(
            id=route_id,
            name=str(raw.get("name") or ""),
            distance_m=float(raw.get("distance") or 0.0),
            ascent_m=float(raw.get("elevation_gain") or 0.0),
            created_at=str(raw.get("created_at") or ""),
        )
    except (KeyError, TypeError, ValueError):
        return None


def list_routes(access_token: str, athlete_id: int, session: requests.Session | None = None) -> list[StravaRoute]:
    """The visitor's own routes, in Strava's order (the frontend sorts)."""
    routes: list[StravaRoute] = []
    for page in range(1, MAX_ROUTE_PAGES + 1):
        response = _send(
            "GET",
            f"{STRAVA_API_BASE}/athletes/{athlete_id}/routes",
            "routes",
            session,
            params={"page": page, "per_page": ROUTES_PER_PAGE},
            headers=_bearer(access_token),
        )
        try:
            batch = response.json()
        except ValueError as exc:
            raise StravaError(f"Strava returned malformed routes: {exc}") from exc
        if not isinstance(batch, list):
            raise StravaError("Strava returned malformed routes.")
        routes.extend(route for route in (_route(r) for r in batch if isinstance(r, dict)) if route)
        if len(batch) < ROUTES_PER_PAGE:
            break
    return routes


def export_route_gpx(access_token: str, route_id: str, session: requests.Session | None = None) -> bytes:
    """The route's GPX as Strava exports it. `route_id` must be all digits,
    so nothing the caller sends can shape the URL beyond one route id.

    Raises ValueError for a malformed id."""
    if not route_id.isascii() or not route_id.isdigit():
        raise ValueError("route_id must be a Strava route id.")
    response = _send(
        "GET",
        f"{STRAVA_API_BASE}/routes/{route_id}/export_gpx",
        "route export",
        session,
        headers=_bearer(access_token),
    )
    return response.content
