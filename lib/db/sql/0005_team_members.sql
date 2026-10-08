-- Teams: each CSR reports to at most one supervisor in the same program.
-- Read and written through raw SQL in routes/admin/teams.ts (and read by the
-- team filters in routes/admin/users.ts and routes/admin/insights.ts); the
-- table is not bound in Drizzle. Needs 0004_supervisor_role.sql applied first.
--
-- Program scoping is a security boundary: a supervisor's team decides whose
-- questions and accounts they can see. The guard trigger refuses any row whose
-- CSR or supervisor has the wrong role or sits in another program, and the
-- users trigger deletes rows that a later role or program change made invalid,
-- so an API bug cannot put a Program B CSR on a Program A supervisor's team.

-- The primary key keeps a CSR on one team at a time.
CREATE TABLE IF NOT EXISTS team_members (
  csr_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  supervisor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES programs(id),
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_members_supervisor_idx
  ON team_members (supervisor_user_id);

CREATE INDEX IF NOT EXISTS team_members_program_idx
  ON team_members (program_id);

-- Role and program guards.

-- FOR SHARE holds both users rows until commit, so a concurrent role or
-- program change waits for this insert and its cleanup trigger then sees it.
CREATE OR REPLACE FUNCTION team_members_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_csr_role user_role;
  v_csr_program uuid;
  v_supervisor_role user_role;
  v_supervisor_program uuid;
BEGIN
  SELECT role, program_id INTO v_csr_role, v_csr_program
    FROM users WHERE id = NEW.csr_user_id FOR SHARE;
  SELECT role, program_id INTO v_supervisor_role, v_supervisor_program
    FROM users WHERE id = NEW.supervisor_user_id FOR SHARE;
  IF v_csr_role IS DISTINCT FROM 'csr' THEN
    RAISE EXCEPTION 'team_members: csr_user_id is not a csr'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_supervisor_role IS DISTINCT FROM 'supervisor' THEN
    RAISE EXCEPTION 'team_members: supervisor_user_id is not a supervisor'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_csr_program IS DISTINCT FROM NEW.program_id
     OR v_supervisor_program IS DISTINCT FROM NEW.program_id THEN
    RAISE EXCEPTION 'team_members: csr and supervisor must both be in the row''s program'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS team_members_guard_trg ON team_members;
CREATE TRIGGER team_members_guard_trg
  BEFORE INSERT OR UPDATE ON team_members
  FOR EACH ROW EXECUTE FUNCTION team_members_guard();

-- A CSR who changes role or program leaves their team; a supervisor who does
-- loses every CSR assigned to them.
CREATE OR REPLACE FUNCTION team_members_user_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM team_members
  WHERE (csr_user_id = NEW.id
         AND (NEW.role <> 'csr' OR program_id IS DISTINCT FROM NEW.program_id))
     OR (supervisor_user_id = NEW.id
         AND (NEW.role <> 'supervisor' OR program_id IS DISTINCT FROM NEW.program_id));
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS team_members_user_cleanup_trg ON users;
CREATE TRIGGER team_members_user_cleanup_trg
  AFTER UPDATE OF role, program_id ON users
  FOR EACH ROW
  WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.program_id IS DISTINCT FROM NEW.program_id)
  EXECUTE FUNCTION team_members_user_cleanup();
