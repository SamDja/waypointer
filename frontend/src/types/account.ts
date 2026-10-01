// Hand mirror of schemas.py's AccountResponse / AccountStatus - keep in sync.

export interface Account {
  id: string
  email: string
  email_verified: boolean
  // Opt-in features switched on by hand for a test phase (e.g. "llm").
  features: string[]
  created_at: string
}

export interface AccountStatus {
  // false when this server has no account database - sign-in is hidden.
  enabled: boolean
  account: Account | null
  captcha_required: boolean
}
