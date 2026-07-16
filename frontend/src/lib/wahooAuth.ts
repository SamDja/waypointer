// PKCE OAuth 2.0 helpers for Wahoo's Cloud API (public-client flow, no
// client_secret - see wahooConfig.ts). Plain fetch calls, matching api.ts's
// style; no HTTP-client dependency added for this.
import { ApiError } from "@/lib/api"
import { WAHOO_CLIENT_ID, WAHOO_OAUTH_BASE, WAHOO_SCOPES } from "@/lib/wahooConfig"

export function wahooRedirectUri(): string {
  return `${window.location.origin}/wahoo-callback.html`
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

export function generateCodeVerifier(): string {
  // RFC 7636 recommends 43-128 chars; base64url of 64 random bytes lands
  // comfortably in that range.
  return randomString(64)
}

export function generateState(): string {
  return randomString(16)
}

export async function deriveCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))
  return base64UrlEncode(new Uint8Array(digest))
}

export async function buildAuthorizeUrl(codeVerifier: string, state: string): Promise<string> {
  if (!WAHOO_CLIENT_ID) {
    throw new ApiError("Wahoo integration is not configured (missing client id).")
  }
  const codeChallenge = await deriveCodeChallenge(codeVerifier)
  const params = new URLSearchParams({
    client_id: WAHOO_CLIENT_ID,
    redirect_uri: wahooRedirectUri(),
    scope: WAHOO_SCOPES,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  })
  return `${WAHOO_OAUTH_BASE}/oauth/authorize?${params.toString()}`
}

export interface WahooTokenResult {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope?: string
}

interface RawWahooTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
}

async function requestTokens(params: URLSearchParams): Promise<WahooTokenResult> {
  const response = await fetch(`${WAHOO_OAUTH_BASE}/oauth/token?${params.toString()}`, {
    method: "POST",
  })
  if (!response.ok) {
    throw new ApiError(`Wahoo token request failed (${response.status}).`)
  }
  const data = (await response.json()) as RawWahooTokenResponse
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  }
}

// Wahoo can grant fewer scopes than requested (e.g. if the app's dashboard
// registration doesn't have a scope enabled, even though it's listed in the
// /oauth/authorize request - see WAHOO_SCOPES in wahooConfig.ts). Without
// this check, a missing scope fails silently at connect time and only
// surfaces later as a confusing 403 on first actual use (e.g. listing
// routes). Returns a user-facing warning, or null if nothing's missing or
// Wahoo didn't report a scope at all (nothing to check against).
export function missingWahooScopeWarning(tokens: { scope?: string }): string | null {
  if (!tokens.scope) return null
  const granted = tokens.scope.split(/\s+/)
  const missing = WAHOO_SCOPES.split(/\s+/).filter((s) => !granted.includes(s))
  if (missing.length === 0) return null
  return `Connected to Wahoo, but it didn't grant: ${missing.join(", ")}. Check the scopes enabled for this app in Wahoo's developer dashboard.`
}

export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<WahooTokenResult> {
  if (!WAHOO_CLIENT_ID) {
    throw new ApiError("Wahoo integration is not configured (missing client id).")
  }
  return requestTokens(
    new URLSearchParams({
      client_id: WAHOO_CLIENT_ID,
      code,
      redirect_uri: wahooRedirectUri(),
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  )
}

export async function refreshTokens(refreshToken: string): Promise<WahooTokenResult> {
  if (!WAHOO_CLIENT_ID) {
    throw new ApiError("Wahoo integration is not configured (missing client id).")
  }
  return requestTokens(
    new URLSearchParams({
      client_id: WAHOO_CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  )
}
