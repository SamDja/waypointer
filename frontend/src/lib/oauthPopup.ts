// The "connect a fitness app" popup, shared by every app: opens a popup
// window (so the main window's in-progress upload/selection state, held in
// App.tsx's useState, survives the OAuth round trip - a full-page redirect
// would wipe it), waits for the app's callback page (public/*-callback.html)
// to postMessage the result back, checks its state, then hands the code to
// the app's own exchange.

export interface OAuthCallback {
  code: string
  // The scopes the visitor actually granted, when the app reports them on
  // the redirect (Strava does; Wahoo reports them on the token instead).
  scope: string | null
}

export interface OAuthPopupOptions<T> {
  // "Wahoo", "Strava" - for the visitor-facing messages.
  appName: string
  // The `type` its callback page posts, e.g. "wahoo-oauth".
  messageType: string
  buildUrl: (state: string) => Promise<string>
  exchange: (callback: OAuthCallback) => Promise<T>
}

export function runOAuthPopup<T>({ appName, messageType, buildUrl, exchange }: OAuthPopupOptions<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    // Open the popup synchronously (before any await) so browsers still
    // attribute it to this click's user-activation and don't block it.
    const popup = window.open("about:blank", messageType, "width=500,height=700")
    if (!popup) {
      reject(new Error(`Popup blocked - allow popups for this site to connect ${appName}.`))
      return
    }

    // Ties the callback to this attempt, so a stale or forged one is refused.
    const state = crypto.randomUUID()
    let settled = false
    // Set as soon as a valid oauth message arrives, before the async token
    // exchange below - the callback page calls window.close() right after
    // postMessage, which can win the race against the exchange finishing
    // and would otherwise make pollClosed reject with a false "closed
    // before completing" error even though the exchange goes on to succeed.
    let receivedCallback = false

    function cleanup() {
      window.removeEventListener("message", onMessage)
      window.clearInterval(pollClosed)
    }

    function settleReject(error: Error) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    async function onMessage(event: MessageEvent) {
      if (settled || event.origin !== window.location.origin) return
      const data = event.data as
        | { type?: string; code?: string | null; state?: string | null; error?: string | null; scope?: string | null }
        | null
      if (!data || data.type !== messageType) return
      receivedCallback = true

      if (data.state !== state) {
        // A stale or foreign callback - not something the visitor can act
        // on beyond trying again.
        settleReject(new Error(`Couldn't connect to ${appName} - please try again.`))
        return
      }
      if (data.error || !data.code) {
        settleReject(
          new Error(
            // OAuth's access_denied is the visitor declining on the app's page.
            data.error === "access_denied"
              ? `${appName} connection cancelled - Sulla Via wasn't given access.`
              : `${appName} didn't authorize the connection - please try again.`,
          ),
        )
        return
      }

      try {
        const result = await exchange({ code: data.code, scope: data.scope ?? null })
        settled = true
        cleanup()
        resolve(result)
      } catch (err) {
        settleReject(err instanceof Error ? err : new Error(`Couldn't finish connecting ${appName}.`))
      }
    }

    const pollClosed = window.setInterval(() => {
      if (popup.closed && !receivedCallback) {
        settleReject(new Error(`${appName} connection window was closed before completing.`))
      }
    }, 500)

    window.addEventListener("message", onMessage)

    buildUrl(state)
      .then((url) => {
        if (!settled) popup.location.href = url
      })
      .catch((err) => {
        popup.close()
        settleReject(err instanceof Error ? err : new Error(`Failed to start the ${appName} connection.`))
      })
  })
}
