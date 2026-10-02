// "Connect Wahoo": the shared OAuth popup (oauthPopup.ts) with Wahoo's PKCE
// flow. The verifier never leaves this closure until the server needs it.
import type { Connection } from "@/lib/connections"
import { runOAuthPopup } from "@/lib/oauthPopup"
import { buildAuthorizeUrl, completeWahooConnection, generateCodeVerifier } from "@/lib/wahooAuth"

export function connectWahoo(): Promise<Connection> {
  const codeVerifier = generateCodeVerifier()
  return runOAuthPopup({
    appName: "Wahoo",
    messageType: "wahoo-oauth",
    buildUrl: (state) => buildAuthorizeUrl(codeVerifier, state),
    exchange: ({ code }) => completeWahooConnection(code, codeVerifier),
  })
}
