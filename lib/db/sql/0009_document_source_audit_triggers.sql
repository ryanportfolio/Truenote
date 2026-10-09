-- Transactional audit events for document-version lifecycle changes and
-- content-source changes, from docs/security/p0-p1-security-controls.sql.
-- Absent on Railway, like the append-only guard (0008), because the
-- 2026-10-07 copy of the Replit database did not include them
-- (docs/security/evidence/railway-audit-catalog-2026-10-09.json).
--
-- Each trigger appends a security_events row in the same transaction as the
-- change, through append_security_event: one `document.lifecycle.<state>`
-- event per version insert and per lifecycle_state change, and one
-- `content_source.created` / `content_source.changed` event per source insert
-- or update. The application writes no such events itself, so nothing is
-- recorded twice. Both functions are SECURITY DEFINER and owned by the
-- migration role, so the application role needs no further grant. The
-- function bodies match the source file, which the PCI catalog verifier
-- (docs/compliance/pci/production-control-verification.sql) compares against.

CREATE OR REPLACE FUNCTION audit_document_version_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_program_id uuid;
  v_actor_id uuid;
  v_actor_email text;
  v_actor_role text;
  v_actor_text text;
  v_old_state text;
BEGIN
  SELECT d.program_id INTO v_program_id
  FROM documents d
  WHERE d.id = NEW.document_id;

  v_old_state := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.lifecycle_state END;
  v_actor_text := CASE NEW.lifecycle_state
    WHEN 'active' THEN NEW.approved_by::text
    WHEN 'rejected' THEN NEW.rejected_by::text
    WHEN 'revoked' THEN NEW.revoked_by::text
    ELSE NEW.uploaded_by
  END;
  IF v_actor_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_actor_id := v_actor_text::uuid;
    SELECT u.email, u.role::text INTO v_actor_email, v_actor_role
    FROM users u WHERE u.id = v_actor_id;
  END IF;

  PERFORM append_security_event(
    'document.lifecycle.' || NEW.lifecycle_state,
    'success',
    v_actor_id,
    v_actor_email,
    v_actor_role,
    v_program_id,
    'document_version',
    NEW.id::text,
    NULL,
    NULL,
    jsonb_build_object(
      'documentId', NEW.document_id,
      'versionNumber', NEW.version_number,
      'previousState', v_old_state,
      'newState', NEW.lifecycle_state,
      'classification', NEW.classification,
      'scanStatus', NEW.scan_status,
      'isActive', NEW.is_active
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS document_versions_audit_insert ON document_versions;
CREATE TRIGGER document_versions_audit_insert
AFTER INSERT ON document_versions
FOR EACH ROW EXECUTE FUNCTION audit_document_version_lifecycle();

DROP TRIGGER IF EXISTS document_versions_audit_lifecycle ON document_versions;
CREATE TRIGGER document_versions_audit_lifecycle
AFTER UPDATE OF lifecycle_state ON document_versions
FOR EACH ROW
WHEN (OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state)
EXECUTE FUNCTION audit_document_version_lifecycle();

-- Transactional audit for source-registry creation/retirement.
CREATE OR REPLACE FUNCTION audit_content_source_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_actor_id uuid;
  v_actor_email text;
  v_actor_role text;
BEGIN
  v_actor_id := COALESCE(NEW.approved_by, NEW.created_by);
  SELECT u.email, u.role::text INTO v_actor_email, v_actor_role
  FROM users u WHERE u.id = v_actor_id;
  PERFORM append_security_event(
    CASE WHEN TG_OP = 'INSERT' THEN 'content_source.created' ELSE 'content_source.changed' END,
    'success',
    v_actor_id,
    v_actor_email,
    v_actor_role,
    NEW.program_id,
    'content_source',
    NEW.id::text,
    NULL,
    NULL,
    jsonb_build_object(
      'name', NEW.name,
      'originType', NEW.origin_type,
      'ownerName', NEW.owner_name,
      'isActive', NEW.is_active,
      'approvedAt', NEW.approved_at
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS content_sources_audit_insert ON content_sources;
CREATE TRIGGER content_sources_audit_insert
AFTER INSERT ON content_sources
FOR EACH ROW EXECUTE FUNCTION audit_content_source_change();

DROP TRIGGER IF EXISTS content_sources_audit_update ON content_sources;
CREATE TRIGGER content_sources_audit_update
AFTER UPDATE ON content_sources
FOR EACH ROW EXECUTE FUNCTION audit_content_source_change();
