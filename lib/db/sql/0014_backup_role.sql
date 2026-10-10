-- Read-only login role for the scheduled off-site backup job (the `backup`
-- service, scripts/backup/run-backup.sh). Without it the job would need the
-- `postgres` superuser password.
--
-- truenote_backup reads every table, view and sequence through the
-- predefined role pg_read_all_data, so pg_dump can export the whole database,
-- including security_events, schema_migrations and the pgboss schema. It
-- writes nothing: pg_read_all_data grants no INSERT, UPDATE, DELETE or
-- TRUNCATE, the role owns nothing and can run no DDL, and its sessions start
-- read-only. It can read password hashes, sessions and reset tokens; the
-- backup excludes the rows of sessions and password_reset_tokens, and every
-- copy is encrypted before it leaves the job (docs/security/backup-restore-runbook.md).
--
-- No password here. `node scripts/railway-set-app-db-password.mjs --role backup --apply`
-- sets one as a SCRAM verifier and stores the plaintext only in the pgvector
-- service variable TRUENOTE_BACKUP_DB_PASSWORD, which the backup service
-- references in BACKUP_DATABASE_URL (.claude/reference/deployment.md, "Backups").

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'truenote_backup') THEN
    CREATE ROLE truenote_backup LOGIN;
  END IF;
END
$$;

-- One backup run holds one connection; 3 leaves room for a manual run.
ALTER ROLE truenote_backup WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;

ALTER ROLE truenote_backup SET default_transaction_read_only = on;

-- NOINHERIT is the role default; this one membership is inherited explicitly,
-- and SET FALSE keeps the role from switching to pg_read_all_data.
GRANT pg_read_all_data TO truenote_backup WITH INHERIT TRUE, SET FALSE;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO truenote_backup', current_database());
END
$$;
