// Wahoo token persistence, sibling to settings.ts's localStorage-JSON
// pattern. Tokens live only in the browser - the backend never sees or
// stores them (see CLAUDE.md's "no server-side session" architecture).
import { refreshTokens as refreshWahooTokens } from "@/lib/wahooAuth"

const WAHOO_KEY = "waypointer.wahoo"
const REFRESH_BUFFER_MS = 5 * 60 * 1000

export interface WahooTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  athleteLabel?: string
  scope?: string
}

export function loadWahooTokens(): WahooTokens | null {
  try {
    const raw = localStorage.getItem(WAHOO_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") {
      return null
    }
    return parsed as WahooTokens
  } catch {
    return null
  }
}

export function saveWahooTokens(tokens: WahooTokens): void {
  localStorage.setItem(WAHOO_KEY, JSON.stringify(tokens))
}

export function clearWahooTokens(): void {
  localStorage.removeItem(WAHOO_KEY)
}

// Wahoo revokes the previous access+refresh token once a refreshed token is
// used, and caps unrevoked tokens per user - so concurrent callers in one
// tab must share a single in-flight refresh rather than firing duplicates.
// Cross-tab races are a known, accepted v1 limitation.
let refreshInFlight: Promise<WahooTokens> | null = null

export async function getValidWahooAccessToken(): Promise<string> {
  const tokens = loadWahooTokens()
  if (!tokens) {
    throw new Error("Wahoo account is not connected.")
  }
  if (tokens.expiresAt - REFRESH_BUFFER_MS > Date.now()) {
    return tokens.accessToken
  }

  if (!refreshInFlight) {
    refreshInFlight = refreshWahooTokens(tokens.refreshToken)
      .then((result) => {
        const next: WahooTokens = { ...result, athleteLabel: tokens.athleteLabel }
        saveWahooTokens(next)
        return next
      })
      .finally(() => {
        refreshInFlight = null
      })
  }
  const refreshed = await refreshInFlight
  return refreshed.accessToken
}
