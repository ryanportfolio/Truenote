-- Second factor for local password login (artifacts/api-server/src/lib/auth/mfa.ts,
-- artifacts/api-server/src/routes/mfa.ts). With LOCAL_LOGIN_MODE=break_glass
-- only the emergency super_user signs in with a password, and that account
-- must hold a passkey. Any local-login user with a passkey completes a
-- WebAuthn assertion or a single-use recovery code before a session is issued.
--
-- user_passkeys: one row per registered WebAuthn credential. credential_id is
-- the base64url credential ID; public_key is the COSE public key; sign_count
-- is the authenticator's signature counter from the last assertion.
--
-- user_recovery_codes: SHA-256 hex of each recovery code (the plaintext is
-- shown once and never stored). used_at marks a spent code. Generating a new
-- set deletes the old rows.
--
-- mfa_challenges: pending WebAuthn challenges. A `login` row is created after
-- the password verifies and is found by the SHA-256 hash of a random token in
-- an httpOnly cookie; a `register` row belongs to a signed-in super_user
-- adding a passkey. Each row expires after 5 minutes and is consumed on
-- success.
--
-- Not bound in lib/db/src/schema.ts; the api-server queries these tables with
-- raw SQL. Deleting a user removes its rows.

CREATE TABLE IF NOT EXISTS user_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL,
  public_key bytea NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0,
  transports text[],
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT user_passkeys_credential_id_key UNIQUE (credential_id),
  CONSTRAINT user_passkeys_sign_count_check CHECK (sign_count >= 0)
);

CREATE INDEX IF NOT EXISTS user_passkeys_user_id_idx ON user_passkeys (user_id);

CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  CONSTRAINT user_recovery_codes_code_hash_key UNIQUE (code_hash)
);

CREATE INDEX IF NOT EXISTS user_recovery_codes_user_id_idx ON user_recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  challenge text NOT NULL,
  token_hash text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mfa_challenges_purpose_check CHECK (purpose IN ('login', 'register')),
  CONSTRAINT mfa_challenges_token_hash_key UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS mfa_challenges_user_id_idx ON mfa_challenges (user_id);
CREATE INDEX IF NOT EXISTS mfa_challenges_expires_at_idx ON mfa_challenges (expires_at);

-- The default privileges from 0007_app_runtime_role.sql already cover tables
-- the migration role creates; the explicit grant also covers a database where
-- this file runs as another role. Skipped where the role does not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'truenote_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON user_passkeys, user_recovery_codes, mfa_challenges
      TO truenote_app;
  END IF;
END
$$;
