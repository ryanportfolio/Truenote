-- Synthetic fence for the evidence harness (docs/security/evidence-harness.md,
-- phase 2). Synthetic programs and users are test accounts that log in to
-- production every day to prove the access controls. The database keeps them
-- apart from customer data, so no application bug can mix the two:
--
-- * programs.is_synthetic and users.is_synthetic, false for every existing row.
-- * A user's is_synthetic must equal its program's: the composite foreign key
--   users_program_synthetic_fkey (program_id, is_synthetic) references the
--   unique pair programs (id, is_synthetic), checked on INSERT and on UPDATE of
--   either column. A synthetic user can only move to another synthetic program.
-- * A super_user (program_id NULL, which the foreign key skips) is never
--   synthetic: users_synthetic_not_super_user_check.
-- * Synthetic emails end in .invalid (RFC 2606, never deliverable); real
--   emails must not: users_synthetic_email_check.
-- * is_synthetic never changes after insert, for any role
--   (block_synthetic_flag_change, BEFORE UPDATE on both tables).
-- * Only the tables' owner, the migration role, can insert a synthetic row.
--   The trigger checks current_user, the role running the statement, which
--   the application cannot change: truenote_app (0007_app_runtime_role.sql)
--   is NOINHERIT and not a member of the owner. The application still creates
--   real programs and users and updates synthetic users' login fields
--   (last_login_at, password_hash, must_reset_password).
--
-- Every existing row is real with an ordinary email, so the constraints
-- validate on the first run. The file runs again without changes.

ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.programs'::regclass
      AND conname = 'programs_id_synthetic_key'
  ) THEN
    ALTER TABLE programs
      ADD CONSTRAINT programs_id_synthetic_key UNIQUE (id, is_synthetic);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_program_synthetic_fkey'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_program_synthetic_fkey
      FOREIGN KEY (program_id, is_synthetic)
      REFERENCES programs (id, is_synthetic);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_synthetic_not_super_user_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_synthetic_not_super_user_check
      CHECK (NOT is_synthetic OR (role <> 'super_user' AND program_id IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_synthetic_email_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_synthetic_email_check
      CHECK (is_synthetic = (lower(email) LIKE '%.invalid'));
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION block_synthetic_flag_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_owner oid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.is_synthetic IS DISTINCT FROM OLD.is_synthetic THEN
      RAISE EXCEPTION '%.is_synthetic cannot change after insert', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_synthetic THEN
    SELECT c.relowner INTO v_owner FROM pg_class c WHERE c.oid = TG_RELID;
    IF NOT pg_has_role(current_user, v_owner, 'MEMBER') THEN
      RAISE EXCEPTION 'only the migration role can insert a synthetic row into %',
        TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS programs_synthetic_fence ON programs;
CREATE TRIGGER programs_synthetic_fence
BEFORE INSERT OR UPDATE ON programs
FOR EACH ROW EXECUTE FUNCTION block_synthetic_flag_change();

DROP TRIGGER IF EXISTS users_synthetic_fence ON users;
CREATE TRIGGER users_synthetic_fence
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION block_synthetic_flag_change();
