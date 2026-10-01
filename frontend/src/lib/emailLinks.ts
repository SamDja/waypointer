// The links in account emails (backend auth.py) land on the app's own page
// with a query parameter, since the SPA has no router: /?verify=…,
// /?reset=…, /?confirm-email=… and /?signin=forgot. App reads one on load,
// then removes it from the address bar so a reload or a shared URL doesn't
// replay it.

export type EmailLink =
  | { kind: "verify"; token: string }
  | { kind: "reset"; token: string }
  | { kind: "confirm-email"; token: string }
  | { kind: "forgot" }

const TOKEN_PARAMS = ["verify", "reset", "confirm-email"] as const
const ALL_PARAMS = [...TOKEN_PARAMS, "signin"]
// What a link token can look like (Python's secrets.token_urlsafe).
const TOKEN_PATTERN = /^[\w-]{20,100}$/

export function parseEmailLink(search: string): EmailLink | null {
  const params = new URLSearchParams(search)
  for (const kind of TOKEN_PARAMS) {
    const token = params.get(kind)
    if (token !== null && TOKEN_PATTERN.test(token)) return { kind, token }
  }
  if (params.get("signin") === "forgot") return { kind: "forgot" }
  return null
}

/** `href` without any email-link parameter, the rest of it untouched. */
export function withoutEmailLinkParams(href: string): string {
  const url = new URL(href)
  for (const param of ALL_PARAMS) url.searchParams.delete(param)
  return url.toString()
}
