-- Recommended shortcuts: each supervisor keeps an ordered list of sources they
-- recommend to their own team. CSRs see their supervisor's list next to the
-- manager's program-wide pins (kb_source_featured).
-- Read and written through raw SQL in routes/kb.ts and routes/kb-library.ts;
-- the table is not bound in Drizzle. Needs 0003_source_library.sql (for
-- kb_document_program_row_guard) and 0004/0005 applied first.
--
-- Program scoping is a security boundary. The document guard refuses a row
-- whose document sits in another program, the supervisor guard refuses a row
-- unless its user is a supervisor in the row's program, and the users trigger
-- deletes a user's rows once they stop being a supervisor in that program.

CREATE TABLE IF NOT EXISTS kb_team_shortcuts (
  supervisor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supervisor_user_id, document_id)
);

CREATE INDEX IF NOT EXISTS kb_team_shortcuts_supervisor_idx
  ON kb_team_shortcuts (supervisor_user_id, position);

-- Document and supervisor guards.

DROP TRIGGER IF EXISTS kb_team_shortcuts_document_guard_trg ON kb_team_shortcuts;
CREATE TRIGGER kb_team_shortcuts_document_guard_trg
  BEFORE INSERT OR UPDATE OF program_id, document_id ON kb_team_shortcuts
  FOR EACH ROW EXECUTE FUNCTION kb_document_program_row_guard();

-- FOR SHARE holds the users row until commit, so a concurrent role or
-- program change waits for this insert and its cleanup trigger then sees it.
CREATE OR REPLACE FUNCTION kb_team_shortcuts_supervisor_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role user_role;
  v_program uuid;
BEGIN
  SELECT role, program_id INTO v_role, v_program
    FROM users WHERE id = NEW.supervisor_user_id FOR SHARE;
  IF v_role IS DISTINCT FROM 'supervisor' THEN
    RAISE EXCEPTION 'kb_team_shortcuts: supervisor_user_id is not a supervisor'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_program IS DISTINCT FROM NEW.program_id THEN
    RAISE EXCEPTION 'kb_team_shortcuts: supervisor is not in the row''s program'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS kb_team_shortcuts_supervisor_guard_trg ON kb_team_shortcuts;
CREATE TRIGGER kb_team_shortcuts_supervisor_guard_trg
  BEFORE INSERT OR UPDATE OF supervisor_user_id, program_id ON kb_team_shortcuts
  FOR EACH ROW EXECUTE FUNCTION kb_team_shortcuts_supervisor_guard();

-- A supervisor who changes role or program loses their recommendations.
CREATE OR REPLACE FUNCTION kb_team_shortcuts_user_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM kb_team_shortcuts
  WHERE supervisor_user_id = NEW.id
    AND (NEW.role <> 'supervisor' OR program_id IS DISTINCT FROM NEW.program_id);
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS kb_team_shortcuts_user_cleanup_trg ON users;
CREATE TRIGGER kb_team_shortcuts_user_cleanup_trg
  AFTER UPDATE OF role, program_id ON users
  FOR EACH ROW
  WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.program_id IS DISTINCT FROM NEW.program_id)
  EXECUTE FUNCTION kb_team_shortcuts_user_cleanup();
