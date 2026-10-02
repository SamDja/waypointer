// "Connect Strava": the shared OAuth popup (oauthPopup.ts), with the code
// handed to our backend, which exchanges it and keeps the connection.
import type { Connection } from "@/lib/connections"
import { runOAuthPopup } from "@/lib/oauthPopup"
import { buildStravaAuthorizeUrl, completeStravaConnection } from "@/lib/stravaAuth"

export function connectStrava(): Promise<Connection> {
  return runOAuthPopup({
    appName: "Strava",
    messageType: "strava-oauth",
    buildUrl: buildStravaAuthorizeUrl,
    exchange: ({ code, scope }) => completeStravaConnection(code, scope),
  })
}
