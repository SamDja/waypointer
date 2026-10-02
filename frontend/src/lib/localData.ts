// What a browser may still hold from before accounts existed, and the one
// time it's used: offering to move it into the account on sign-in
// (ImportLocalDataDialog). Connections used to be kept in localStorage under
// these keys; nothing writes them any more, and they're removed once moved.
import { storedAvgSpeeds } from "@/lib/settings"
import type { Provider } from "@/lib/connections"

const LEGACY_KEYS: Record<Provider, string> = { strava: "waypointer.strava", wahoo: "waypointer.wahoo" }

export interface LegacyConnection {
  provider: Provider
  refreshToken: string
  scope?: string
  label?: string
}

export function loadLegacyConnections(): LegacyConnection[] {
  const found: LegacyConnection[] = []
  for (const provider of Object.keys(LEGACY_KEYS) as Provider[]) {
    try {
      const raw = localStorage.getItem(LEGACY_KEYS[provider])
      if (!raw) continue
      const parsed = JSON.parse(raw)
      if (typeof parsed?.refreshToken !== "string" || !parsed.refreshToken) continue
      found.push({
        provider,
        refreshToken: parsed.refreshToken,
        scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
        label: typeof parsed.athleteLabel === "string" ? parsed.athleteLabel : undefined,
      })
    } catch {
      // Unreadable: nothing to offer.
    }
  }
  return found
}

export function clearLegacyConnection(provider: Provider): void {
  try {
    localStorage.removeItem(LEGACY_KEYS[provider])
  } catch {
    // Storage unavailable - nothing to clear.
  }
}

// The speeds this browser was given for each activity, if any.
export const localAvgSpeeds = storedAvgSpeeds
