// Connecting Strava, through our own backend: Strava's token exchange needs
// the app's client secret and Strava has no PKCE, so the browser can't do
// it, and the tokens are kept with the account anyway (connections.py).
import { ApiError, request } from "@/lib/api"
import { fromConnectionResponse, type Connection } from "@/lib/connections"
import type { ConnectionResponse } from "@/types/candidate"

export function stravaRedirectUri(): string {
  return `${window.location.origin}/strava-callback.html`
}

// Strava's scopes are comma-separated. read_all is what lets the import
// dialog see private routes (most planned routes are); activity:read_all
// is what lets it list activities at all.
const PRIVATE_ROUTES_SCOPE = "read_all"
const ACTIVITIES_SCOPE = "activity:read_all"

export async function buildStravaAuthorizeUrl(state: string): Promise<string> {
  const params = new URLSearchParams({ redirect_uri: stravaRedirectUri(), state })
  try {
    const response = await request(
      `/api/strava/authorize-url?${params.toString()}`,
      { method: "GET" },
      { failed: "Couldn't start connecting Strava - please try again in a moment." },
    )
    return ((await response.json()) as { url: string }).url
  } catch (err) {
    // 503 is the server saying it has no Strava credentials configured.
    if (err instanceof ApiError && err.status === 503) {
      throw new ApiError("Strava isn't set up on this server yet.", 503)
    }
    throw err
  }
}

// Exchanges the popup's code and stores the connection with the account.
// Strava reports the granted scope on the redirect, not with the tokens,
// so it's passed along.
export async function completeStravaConnection(code: string, scope: string | null): Promise<Connection> {
  const form = new FormData()
  form.append("code", code)
  if (scope) form.append("scope", scope)
  const response = await request(
    "/api/strava/connect",
    { method: "POST", body: form },
    {
      failed: "Couldn't connect to Strava - please try again in a moment.",
      // A refused code: only connecting again fixes it.
      unauthorized: "Couldn't connect to Strava - please connect Strava again.",
    },
  )
  return fromConnectionResponse((await response.json()) as ConnectionResponse)
}

// Whether this connection may list activities. Connections made before
// activity import only granted routes; unknown (nothing recorded) is
// treated as yes, and Strava's own 401 then asks for a reconnect.
export function hasStravaActivityScope(scope: string | null | undefined): boolean {
  return !scope || scope.split(",").includes(ACTIVITIES_SCOPE)
}

// Strava lets the visitor untick scopes on its consent page, and reports
// what was actually granted on the redirect. A missing one would look like
// routes or activities going missing, so say so at connect time. Null if
// nothing's missing or Strava didn't report a scope at all.
export function missingStravaScopeWarning(scope: string | null): string | null {
  if (!scope) return null
  const granted = scope.split(",")
  const missing: string[] = []
  if (!granted.includes(PRIVATE_ROUTES_SCOPE)) missing.push("your private routes")
  if (!granted.includes(ACTIVITIES_SCOPE)) missing.push("your activities")
  if (missing.length === 0) return null
  return `Connected to Strava, but without access to ${missing.join(" or ")} - reconnect and allow them to import those too.`
}
