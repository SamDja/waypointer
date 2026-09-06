// Umami website id, not a secret - it's a public identifier for which
// Umami dashboard events land in (Umami's own docs treat it as safe to
// ship inside a distributed client), same reasoning as WAHOO_CLIENT_ID.
// Unset means analytics is off entirely - see lib/analytics.ts.
export const UMAMI_WEBSITE_ID = import.meta.env.VITE_UMAMI_WEBSITE_ID as string | undefined

export const UMAMI_SCRIPT_URL = "https://cloud.umami.is/script.js"
