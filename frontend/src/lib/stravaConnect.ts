// "Connect Strava": the shared OAuth popup (oauthPopup.ts) with Strava's
// exchange - done by our backend, which holds the client secret.
import { runOAuthPopup } from "@/lib/oauthPopup"
import { buildStravaAuthorizeUrl, exchangeStravaCode } from "@/lib/stravaAuth"
import { saveStravaTokens, type StravaTokens } from "@/lib/stravaSettings"

export function connectStrava(): Promise<StravaTokens> {
  return runOAuthPopup({
    appName: "Strava",
    messageType: "strava-oauth",
    buildUrl: buildStravaAuthorizeUrl,
    exchange: async ({ code, scope }) => {
      const result = await exchangeStravaCode(code)
      if (result.athleteId === null) {
        // A code exchange always names the athlete; without it the routes
        // can't be listed, so don't pretend the connection worked.
        throw new Error("Strava didn't say whose account this is - please try connecting again.")
      }
      const tokens: StravaTokens = {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        athleteId: result.athleteId,
        athleteLabel: result.athleteLabel ?? undefined,
        scope: scope ?? undefined,
      }
      saveStravaTokens(tokens)
      return tokens
    },
  })
}
