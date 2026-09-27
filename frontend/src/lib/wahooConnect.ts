// "Connect Wahoo": the shared OAuth popup (oauthPopup.ts) with Wahoo's PKCE
// exchange, then the tokens are persisted.
import { runOAuthPopup } from "@/lib/oauthPopup"
import { buildAuthorizeUrl, exchangeCodeForTokens, generateCodeVerifier } from "@/lib/wahooAuth"
import { getWahooUser } from "@/lib/wahooApi"
import { saveWahooTokens, type WahooTokens } from "@/lib/wahooSettings"

export function connectWahoo(): Promise<WahooTokens> {
  const codeVerifier = generateCodeVerifier()
  return runOAuthPopup({
    appName: "Wahoo",
    messageType: "wahoo-oauth",
    buildUrl: (state) => buildAuthorizeUrl(codeVerifier, state),
    exchange: async ({ code }) => {
      const result = await exchangeCodeForTokens(code, codeVerifier)
      const tokens: WahooTokens = { ...result }
      // Best-effort - if user_read wasn't granted or the call fails for any
      // reason, still complete the connection without a display name rather
      // than failing the whole flow over a nice-to-have.
      try {
        const user = await getWahooUser(tokens.accessToken)
        tokens.athleteLabel = `${user.firstName} ${user.lastName}`.trim()
      } catch {
        // best-effort
      }
      saveWahooTokens(tokens)
      return tokens
    },
  })
}
