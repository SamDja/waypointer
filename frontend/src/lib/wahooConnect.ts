// Orchestrates the "Connect Wahoo" popup: opens a popup window (so the
// main window's in-progress upload/selection state, held in App.tsx's
// useState, survives the OAuth round trip - a full-page redirect would
// wipe it), waits for wahoo-callback.html's postMessage, then exchanges
// the code for tokens and persists them.
import { buildAuthorizeUrl, exchangeCodeForTokens, generateCodeVerifier, generateState } from "@/lib/wahooAuth"
import { getWahooUser } from "@/lib/wahooApi"
import { saveWahooTokens, type WahooTokens } from "@/lib/wahooSettings"

const PENDING_KEY = "waypointer.wahoo.pending"

interface PendingAuth {
  codeVerifier: string
  state: string
}

export function connectWahoo(): Promise<WahooTokens> {
  return new Promise((resolve, reject) => {
    // Open the popup synchronously (before any await) so browsers still
    // attribute it to this click's user-activation and don't block it.
    const popup = window.open("about:blank", "wahoo-oauth", "width=500,height=700")
    if (!popup) {
      reject(new Error("Popup blocked - allow popups for this site to connect Wahoo."))
      return
    }

    const codeVerifier = generateCodeVerifier()
    const state = generateState()
    localStorage.setItem(PENDING_KEY, JSON.stringify({ codeVerifier, state } satisfies PendingAuth))

    let settled = false
    // Set as soon as a valid oauth message arrives, before the async token
    // exchange below - wahoo-callback.html calls window.close() right after
    // postMessage, which can win the race against the exchange finishing
    // and would otherwise make pollClosed reject with a false "closed
    // before completing" error even though the exchange goes on to succeed.
    let receivedCallback = false

    function cleanup() {
      window.removeEventListener("message", onMessage)
      window.clearInterval(pollClosed)
      localStorage.removeItem(PENDING_KEY)
    }

    function settleReject(error: Error) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    async function onMessage(event: MessageEvent) {
      if (settled || event.origin !== window.location.origin) return
      const data = event.data as { type?: string; code?: string; state?: string; error?: string } | null
      if (!data || data.type !== "wahoo-oauth") return
      receivedCallback = true

      const storedRaw = localStorage.getItem(PENDING_KEY)
      const stored = storedRaw ? (JSON.parse(storedRaw) as PendingAuth) : null
      if (!stored || data.state !== stored.state) {
        settleReject(new Error("Wahoo connection failed (state mismatch)."))
        return
      }
      if (data.error || !data.code) {
        settleReject(
          new Error(data.error ? `Wahoo authorization was denied: ${data.error}` : "Wahoo authorization failed."),
        )
        return
      }

      try {
        const result = await exchangeCodeForTokens(data.code, stored.codeVerifier)
        const tokens: WahooTokens = { ...result }
        // Best-effort - if user_read wasn't granted or the call fails for
        // any reason, still complete the connection without a display name
        // rather than failing the whole flow over a nice-to-have.
        try {
          const user = await getWahooUser(tokens.accessToken)
          tokens.athleteLabel = `${user.firstName} ${user.lastName}`.trim()
        } catch {
          // best-effort
        }
        saveWahooTokens(tokens)
        settled = true
        cleanup()
        resolve(tokens)
      } catch (err) {
        settleReject(err instanceof Error ? err : new Error("Failed to exchange Wahoo authorization code."))
      }
    }

    const pollClosed = window.setInterval(() => {
      if (popup.closed && !receivedCallback) {
        settleReject(new Error("Wahoo connection window was closed before completing."))
      }
    }, 500)

    window.addEventListener("message", onMessage)

    buildAuthorizeUrl(codeVerifier, state)
      .then((url) => {
        if (!settled) popup.location.href = url
      })
      .catch((err) => {
        popup.close()
        settleReject(err instanceof Error ? err : new Error("Failed to start Wahoo connection."))
      })
  })
}
