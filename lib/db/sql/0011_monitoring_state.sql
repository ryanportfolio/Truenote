-- State for the readiness check and the security monitor
-- (artifacts/api-server/src/lib/monitoring/).
--
-- service_heartbeats: the worker writes one row every 30 seconds. GET
-- /health/ready on web reads it to tell whether the worker is running.
--
-- security_monitor_state: one row holding the last security_events.sequence
-- the worker has printed to its log and checked against the alert rules.
-- append_security_event takes a transaction-scoped advisory lock before it
-- inserts, so events commit in sequence order and reading "sequence greater
-- than the cursor" never skips a row that commits later.
--
-- Neither table is bound in lib/db/src/schema.ts; the code uses raw SQL.
-- truenote_app receives SELECT, INSERT, UPDATE and DELETE on both through the
-- default privileges set by 0007_app_runtime_role.sql.

CREATE TABLE IF NOT EXISTS service_heartbeats (
  service text PRIMARY KEY CHECK (service IN ('worker')),
  instance_id text NOT NULL,
  started_at timestamptz NOT NULL,
  beat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS security_monitor_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
