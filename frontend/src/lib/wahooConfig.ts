// client_id is not secret in the PKCE public-client flow this app uses
// (see wahooAuth.ts) - Wahoo's own docs treat it as safe to ship inside a
// distributed client, so it's fine to bake into the built JS bundle via a
// build-time Vite env var rather than fetched from the backend.
export const WAHOO_CLIENT_ID = import.meta.env.VITE_WAHOO_CLIENT_ID as string | undefined

export const WAHOO_OAUTH_BASE = "https://api.wahooligan.com"
// Space-delimited per OAuth2 convention (passed straight into
// URLSearchParams in wahooAuth.ts's buildAuthorizeUrl). routes_read isn't
// consumed by any feature yet - requested now so a future "pick an existing
// Wahoo route to enhance" feature won't need a second re-auth.
export const WAHOO_SCOPES = "user_read routes_read routes_write"
