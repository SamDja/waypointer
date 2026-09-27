// Strava token persistence, sibling to wahooSettings.ts. The tokens live
// only in the browser - the backend relays them to Strava per request
// (strava.py) but never keeps them.
import { refreshStravaTokens } from "@/lib/stravaAuth"

const STRAVA_KEY = "waypointer.strava"
const REFRESH_BUFFER_MS = 5 * 60 * 1000

export interface StravaTokens {
  accessToken: string
  refreshToken: string
  // Epoch milliseconds.
  expiresAt: number
  // Needed to list the athlete's routes; only a code exchange returns it,
  // so a refresh carries the stored one forward.
  athleteId: number
  athleteLabel?: string
  // What the visitor granted on Strava's consent page (comma-separated).
  scope?: string
}

export function loadStravaTokens(): StravaTokens | null {
  try {
    const raw = localStorage.getItem(STRAVA_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.athleteId !== "number"
    ) {
      return null
    }
    return parsed as StravaTokens
  } catch {
    return null
  }
}

export function saveStravaTokens(tokens: StravaTokens): void {
  localStorage.setItem(STRAVA_KEY, JSON.stringify(tokens))
}

export function clearStravaTokens(): void {
  localStorage.removeItem(STRAVA_KEY)
}

// Strava hands out a new refresh token on each refresh, so concurrent
// callers in one tab share a single in-flight refresh rather than racing
// with the same (soon superseded) one - the same rule as Wahoo's.
let refreshInFlight: Promise<StravaTokens> | null = null

export async function getValidStravaTokens(): Promise<StravaTokens> {
  const tokens = loadStravaTokens()
  if (!tokens) {
    throw new Error("Strava account is not connected.")
  }
  if (tokens.expiresAt - REFRESH_BUFFER_MS > Date.now()) {
    return tokens
  }

  if (!refreshInFlight) {
    refreshInFlight = refreshStravaTokens(tokens.refreshToken)
      .then((result) => {
        const next: StravaTokens = {
          ...tokens,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
        }
        saveStravaTokens(next)
        return next
      })
      .finally(() => {
        refreshInFlight = null
      })
  }
  return refreshInFlight
}
