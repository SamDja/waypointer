-- Fitness-app connections and profile settings, linked to an account (see
-- connections.py). Tokens are encrypted by the app (token_crypto.py) before
-- they get here; the database only ever holds ciphertext.

CREATE TABLE connections (
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('strava', 'wahoo')),
    access_token_enc bytea NOT NULL,
    refresh_token_enc bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    -- The account on the other side: Strava's athlete id (its route list
    -- needs it), and a display name for either.
    external_id text,
    label text,
    scope text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, provider)
);

CREATE TABLE user_settings (
    user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    settings jsonb NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
);
