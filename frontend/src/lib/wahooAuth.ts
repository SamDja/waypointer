// Connecting Wahoo. Still Wahoo's PKCE public-client flow, but finished by
// our backend, which keeps the tokens with the account (connections.py):
// the browser makes the code verifier and keeps it in memory for the length
// of the popup, sends only its challenge to get the authorize URL, then
// hands the verifier over with the code for the server to exchange.
import { ApiError, request } from "@/lib/api"
import { fromConnectionResponse, type Connection } from "@/lib/connections"
import { WAHOO_SCOPES } from "@/lib/wahooConfig"
import type { ConnectionResponse } from "@/types/candidate"

// Must match a redirect URI registered in Wahoo's developer dashboard
// exactly - see CLAUDE.md's note on the misleading error otherwise.
export function wahooRedirectUri(): string {
  return `${window.location.origin}/wahoo-callback.html`
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function generateCodeVerifier(): string {
  // RFC 7636 asks for 43-128 characters; base64url of 64 random bytes is 86.
  const bytes = new Uint8Array(64)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

export async function deriveCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))
  return base64UrlEncode(new Uint8Array(digest))
}

export async function buildAuthorizeUrl(codeVerifier: string, state: string): Promise<string> {
  const params = new URLSearchParams({
    redirect_uri: wahooRedirectUri(),
    state,
    code_challenge: await deriveCodeChallenge(codeVerifier),
  })
  try {
    const response = await request(
      `/api/wahoo/authorize-url?${params.toString()}`,
      {},
      { failed: "Couldn't start connecting Wahoo - please try again in a moment." },
    )
    return ((await response.json()) as { url: string }).url
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) {
      throw new ApiError("Wahoo isn't set up on this server yet.", 503)
    }
    throw err
  }
}

export async function completeWahooConnection(code: string, codeVerifier: string): Promise<Connection> {
  const form = new FormData()
  form.append("code", code)
  form.append("code_verifier", codeVerifier)
  form.append("redirect_uri", wahooRedirectUri())
  const response = await request(
    "/api/wahoo/connect",
    { method: "POST", body: form },
    {
      failed: "Couldn't connect to Wahoo - please try again in a moment.",
      unauthorized: "Couldn't connect to Wahoo - please connect Wahoo again.",
    },
  )
  return fromConnectionResponse((await response.json()) as ConnectionResponse)
}

// Wahoo can grant fewer scopes than requested (e.g. if the app's dashboard
// registration doesn't have a scope enabled, even though it's in the
// authorize request). Without this check, a missing scope fails silently at
// connect time and only surfaces later as a confusing 403 on first use.
// Returns a visitor-facing warning, or null if nothing's missing or Wahoo
// didn't report a scope at all (nothing to check against).
export function missingWahooScopeWarning(scope: string | null): string | null {
  if (!scope) return null
  const granted = scope.split(/\s+/)
  const missing = WAHOO_SCOPES.split(/\s+/).filter((s) => !granted.includes(s))
  if (missing.length === 0) return null
  return `Connected to Wahoo, but it didn't grant: ${missing.join(", ")}. Check the scopes enabled for this app in Wahoo's developer dashboard.`
}
