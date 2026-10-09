-- Least-privilege login role for the running application (web and worker).
-- Until this change both services connected as `postgres`, the superuser that
-- owns every object (docs/security/security-review-2026-10-09.md). That role
-- stays for migrations (scripts/railway-apply-sql.mjs), `railway ssh`
-- maintenance and evidence queries only.
--
-- truenote_app owns nothing and can run no DDL: it cannot create schemas,
-- tables or temporary tables, and it has no TRUNCATE. It gets row access to
-- the application tables, read-only access to security_events (writes go
-- through append_security_event, a SECURITY DEFINER function owned by the
-- migration role), and row access to the pg-boss tables. Referential actions
-- (ON DELETE CASCADE / SET NULL) run as the table owner and need no grant.
--
-- No password here. scripts/railway-set-app-db-password.mjs sets one as a
-- SCRAM verifier and stores the plaintext only in the pgvector service
-- variable TRUENOTE_APP_DB_PASSWORD, which web and worker reference in
-- DATABASE_URL (.claude/reference/deployment.md, "Database roles").
--
-- Future tables and sequences created by the migration role in public and
-- pgboss get the same row grants by default. A migration that adds a table the
-- application must not write revokes those grants in the same file.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'truenote_app') THEN
    CREATE ROLE truenote_app LOGIN;
  END IF;
END
$$;

-- Web and worker each hold up to 10 pool and 10 pg-boss connections, doubled
-- during a deploy overlap; 90 leaves room for the migration role on the
-- server's 100 connections.
ALTER ROLE truenote_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 90;

-- Database: connect only. PUBLIC loses the default TEMPORARY privilege; the
-- application creates no temporary tables (scripts/src/seed-showcase.ts does,
-- but runs as the migration role over `railway ssh`).
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO truenote_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO truenote_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  app_settings,
  chat_sessions,
  chunks,
  content_sources,
  document_versions,
  documents,
  error_log,
  eval_questions,
  eval_runs,
  kb_categories,
  kb_category_documents,
  kb_category_user_prefs,
  kb_document_tags,
  kb_document_views,
  kb_highlights,
  kb_source_featured,
  kb_source_user_state,
  kb_tags,
  kb_team_shortcuts,
  kb_user_color_labels,
  password_reset_tokens,
  programs,
  query_log,
  security_rate_limits,
  sessions,
  team_members,
  users
TO truenote_app;

-- Hash-chained audit log: read for the admin Security page, write only
-- through the function.
GRANT SELECT ON security_events TO truenote_app;
REVOKE EXECUTE ON FUNCTION append_security_event(
  text, text, uuid, text, text, uuid, text, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_security_event(
  text, text, uuid, text, text, uuid, text, text, text, text, jsonb
) TO truenote_app;

-- No application access: the migration ledger, the control metadata and the
-- SIEM outbox (reached only through its SECURITY DEFINER functions once
-- docs/security/p1-siem-delivery-outbox.sql is applied).
REVOKE ALL ON schema_migrations, security_control_metadata, siem_delivery_outbox
  FROM truenote_app;

-- pg-boss 10 (artifacts/api-server/src/lib/jobs/boss.ts). Its schema, tables
-- and queue partitions already exist, so start() only reads pgboss.version and
-- createQueue() on an existing queue is an INSERT ... ON CONFLICT DO NOTHING.
-- Installing or upgrading pg-boss, or adding a queue, creates tables and runs
-- as the migration role.
GRANT USAGE ON SCHEMA pgboss TO truenote_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO truenote_app;
GRANT EXECUTE ON FUNCTION pgboss.create_queue(text, json) TO truenote_app;
REVOKE EXECUTE ON FUNCTION pgboss.delete_queue(text) FROM PUBLIC;

-- Objects the migration role (the role running this file) creates later.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO truenote_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO truenote_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO truenote_app;
