-- Append-only guard for the hash-chained security_events table, from
-- docs/security/p0-p1-security-controls.sql (section 5). The 2026-10-07 copy
-- of the Replit database brought the table and append_security_event but not
-- this function or trigger (docs/security/evidence/railway-audit-catalog-2026-10-09.json).
--
-- The application role (0007_app_runtime_role.sql) already has no UPDATE,
-- DELETE or TRUNCATE on the table. These triggers also stop the owner: an
-- UPDATE or DELETE as `postgres` fails, and so does TRUNCATE, which row
-- triggers do not cover. Removing events now takes an explicit
-- `ALTER TABLE security_events DISABLE TRIGGER ...` by the owner.
--
-- The function body matches the source file, which the PCI catalog verifier
-- (docs/compliance/pci/production-control-verification.sql) compares against.

CREATE OR REPLACE FUNCTION block_security_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'security_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS security_events_append_only ON security_events;
CREATE TRIGGER security_events_append_only
BEFORE UPDATE OR DELETE ON security_events
FOR EACH ROW EXECUTE FUNCTION block_security_event_mutation();

DROP TRIGGER IF EXISTS security_events_no_truncate ON security_events;
CREATE TRIGGER security_events_no_truncate
BEFORE TRUNCATE ON security_events
FOR EACH STATEMENT EXECUTE FUNCTION block_security_event_mutation();
