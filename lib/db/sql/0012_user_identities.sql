-- Company SSO (OIDC) account bindings. Each row ties one Truenote user to the
-- stable identifier an identity provider issues for that person: the token's
-- `iss` plus `sub`. Email claims (`email`, `preferred_username`, `upn`) can be
-- changed by the customer's directory admins, so after the first link
-- artifacts/api-server/src/routes/oidc.ts finds the user by (issuer, subject)
-- and ignores the email in the token.
--
-- The first SSO login of an existing active user creates the row, matched by
-- email. UNIQUE (issuer, subject) keeps one IdP account from reaching two
-- Truenote users; UNIQUE (user_id, issuer) refuses a second IdP account for
-- a user who is already bound at that issuer. tenant_id and object_id keep
-- Entra's `tid` and `oid` claims for investigation; nothing authorizes on them.
--
-- Not bound in lib/db/src/schema.ts; artifacts/api-server/src/lib/auth/identities.ts
-- queries it with raw SQL. Deleting a user removes its bindings.

CREATE TABLE IF NOT EXISTS user_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  tenant_id text,
  object_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  CONSTRAINT user_identities_issuer_subject_key UNIQUE (issuer, subject),
  CONSTRAINT user_identities_user_issuer_key UNIQUE (user_id, issuer)
);

-- The default privileges from 0007_app_runtime_role.sql already cover a table
-- the migration role creates; the explicit grant also covers a database
-- where this file runs as another role. Skipped where the role does not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'truenote_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON user_identities TO truenote_app;
  END IF;
END
$$;
