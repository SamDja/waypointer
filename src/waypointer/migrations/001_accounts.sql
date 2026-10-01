-- Accounts, sessions and single-use email tokens (see auth.py / sessions.py).
-- Applied once by db.apply_migrations; never edit a migration that has
-- shipped - add a new numbered file instead.

-- Case-insensitive email, so Foo@x.com and foo@x.com are one account.
-- citext is a trusted extension (Postgres 13+): the database owner may
-- create it without being a superuser.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email citext NOT NULL UNIQUE,
    password_hash text NOT NULL,
    email_verified_at timestamptz,
    -- Opt-in features set by hand for a test phase, e.g. '{llm}' - see
    -- sessions.require_feature.
    features text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
);

-- Only a hash of each session token is stored, so a leaked database (or
-- backup) doesn't hand out live sessions.
CREATE TABLE sessions (
    token_hash bytea PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    user_agent text
);
CREATE INDEX sessions_user_id ON sessions (user_id);

CREATE TABLE email_tokens (
    token_hash bytea PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose text NOT NULL CHECK (purpose IN ('verify', 'reset', 'change_email')),
    -- The address being confirmed, for purpose = 'change_email' only.
    new_email citext,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);
CREATE INDEX email_tokens_user_id ON email_tokens (user_id);
