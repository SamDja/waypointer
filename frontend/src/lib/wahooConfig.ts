// Space-delimited per OAuth2 convention - mirrors wahoo.py's WAHOO_SCOPES,
// which is what the server actually asks for. Kept here only to tell the
// visitor when Wahoo granted less (wahooAuth.ts's missingWahooScopeWarning).
// The client id is the server's runtime WAHOO_CLIENT_ID now, not a build arg.
export const WAHOO_SCOPES = "user_read routes_read routes_write"
