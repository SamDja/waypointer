// Strava's OAuth, via our own backend: Strava's token exchange needs the
// app's client secret and Strava has no PKCE, so unlike Wahoo (wahooAuth.ts)
// the browser can't do it itself - see strava.py.
import { ApiError, request } from "@/lib/api"
import type { StravaTokenResponse } from "@/types/candidate"

export function stravaRedirectUri(): string {
  return `${window.location.origin}/strava-callback.html`
}

// Strava's scopes are comma-separated. read_all is what lets the import
// dialog see private routes (most planned routes are); activity:read_all
// is what lets it list activities at all.
const PRIVATE_ROUTES_SCOPE = "read_all"
const ACTIVITIES_SCOPE = "activity:read_all"

export interface StravaTokenResult {
  accessToken: string
  refreshToken: string
  // Epoch milliseconds, like WahooTokens.expiresAt.
  expiresAt: number
  athleteId: number | null
  athleteLabel: string | null
}

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

async function requestTokens(field: "code" | "refresh_token", value: string): Promise<StravaTokenResult> {
  const formData = new FormData()
  formData.append(field, value)
  const response = await request(
    "/api/strava/token",
    { method: "POST", body: formData },
    {
      failed: "Couldn't connect to Strava - please try again in a moment.",
      // A refused code or refresh token: only connecting again fixes it.
      unauthorized: "Couldn't connect to Strava - please connect Strava again.",
    },
  )
  const data = (await response.json()) as StravaTokenResponse
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at * 1000,
    athleteId: data.athlete_id,
    athleteLabel: data.athlete_label,
  }
}

export function exchangeStravaCode(code: string): Promise<StravaTokenResult> {
  return requestTokens("code", code)
}

export function refreshStravaTokens(refreshToken: string): Promise<StravaTokenResult> {
  return requestTokens("refresh_token", refreshToken)
}

// Whether this connection may list activities. Connections made before
// activity import only granted routes; unknown (nothing recorded) is
// treated as yes, and Strava's own 401 then asks for a reconnect.
export function hasStravaActivityScope(scope: string | undefined): boolean {
  return scope === undefined || scope.split(",").includes(ACTIVITIES_SCOPE)
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
