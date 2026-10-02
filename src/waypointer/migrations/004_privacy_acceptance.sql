-- When the visitor accepted the privacy notice at sign-up, and which version
-- of it (auth.PRIVACY_VERSION). Null for accounts made before it was asked.
ALTER TABLE users ADD COLUMN privacy_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN privacy_version text;
