// What only the person running this deployment can say. Fill these in
// before Sulla Via is open to the public - the page shows them as written,
// so a placeholder left here is visible to every reader.

// Who runs Sulla Via - the GDPR "controller".
export const CONTROLLER_NAME = "Samuel Giacomelli"
// Where privacy requests and questions go.
export const CONTACT_EMAIL = "samuelgiacomelli@gmail.com"
// Where the server (and so the account database) physically is.
export const HOSTING_COUNTRY = "Italy"
// The SMTP relay that delivers account emails (Brevo, Mailgun, Amazon SES...).
export const EMAIL_PROVIDER = "Brevo"
// How long the server's technical logs are kept. Enforced on the Pi by
// journald (docker-compose.yml sends the app's logs there): with one
// journal file per day, MaxRetentionSec=13day keeps nothing older than 14
// days. Change both together - see CLAUDE.md's "Log retention".
export const LOG_RETENTION = "14 days"
// Shown at the top; change it whenever the content changes - and bump the
// backend's auth.PRIVACY_VERSION with it, so each new account records which
// version it accepted.
export const LAST_UPDATED = "2 October 2026"

// Mirrors of backend values - keep in step.
// sessions.SESSION_TTL
export const SESSION_DAYS = 30
// db cleanup's UNVERIFIED_ACCOUNT_TTL
export const UNVERIFIED_ACCOUNT_DAYS = 7
