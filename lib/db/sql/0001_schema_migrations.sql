-- Records which lib/db/sql files have been applied to production.
-- Baseline: the schema restored from the Replit production database on
-- 2026-10-07 (no file). Every later change is a numbered file in this folder,
-- applied as described in .claude/reference/deployment.md.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
