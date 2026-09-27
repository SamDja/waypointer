// Strava's OAuth, via our own backend: Strava's token exchange needs the
// app's client secret and Strava has no PKCE, so unlike Wahoo (wahooAuth.ts)
// the browser can't do it itself - see strava.py.
import { ApiError, request } from "@/lib/api"
import type { StravaTokenResponse } from "@/types/candidate"

export function stravaRedirectUri(): string {
  return `${window.location.origin}/strava-callback.html`
}

// What Strava must grant for the import dialog to see private routes, which
// most planned routes are. Strava's scopes are comma-separated.
const REQUIRED_SCOPES = ["read_all"]

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

// Strava lets the visitor untick scopes on its consent page, and reports
// what was actually granted on the redirect. Without read_all the import
// dialog only sees public routes, which would look like routes going
// missing - so say so at connect time. Null if nothing's missing or Strava
// didn't report a scope at all.
export function missingStravaScopeWarning(scope: string | null): string | null {
  if (!scope) return null
  const granted = scope.split(",")
  const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s))
  if (missing.length === 0) return null
  return "Connected to Strava, but without access to private routes - only your public routes can be imported."
}
