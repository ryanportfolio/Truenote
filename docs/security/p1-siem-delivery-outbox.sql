-- Truenote durable SIEM delivery outbox
-- Apply only after docs/security/p0-p1-security-controls.sql is verified.
-- This migration is forward-only. It intentionally queues existing security
-- events so the configured SIEM can receive a complete historical catch-up.

BEGIN;

CREATE TABLE IF NOT EXISTS siem_delivery_outbox (
  security_event_id uuid PRIMARY KEY
    REFERENCES security_events(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT siem_delivery_outbox_lease_check CHECK (
    (
      status = 'delivering'
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR (
      status <> 'delivering'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT siem_delivery_outbox_terminal_check CHECK (
    (
      status = 'delivered'
      AND delivered_at IS NOT NULL
      AND dead_lettered_at IS NULL
      AND next_attempt_at IS NULL
    )
    OR (
      status = 'dead_letter'
      AND delivered_at IS NULL
      AND dead_lettered_at IS NOT NULL
      AND next_attempt_at IS NULL
    )
    OR (
      status IN ('pending', 'delivering')
      AND delivered_at IS NULL
      AND dead_lettered_at IS NULL
      AND next_attempt_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS siem_delivery_outbox_due_idx
  ON siem_delivery_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'delivering');

CREATE INDEX IF NOT EXISTS siem_delivery_outbox_dead_letter_idx
  ON siem_delivery_outbox (dead_lettered_at DESC)
  WHERE status = 'dead_letter';

CREATE OR REPLACE FUNCTION enqueue_security_event_for_siem()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO siem_delivery_outbox (
    security_event_id,
    status,
    next_attempt_at
  ) VALUES (
    NEW.id,
    'pending',
    clock_timestamp()
  )
  ON CONFLICT (security_event_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS security_events_siem_enqueue ON security_events;
CREATE TRIGGER security_events_siem_enqueue
AFTER INSERT ON security_events
FOR EACH ROW EXECUTE FUNCTION enqueue_security_event_for_siem();

-- Catch up events written before this outbox existed. Delivery remains
-- bounded by the worker batch size and retry policy.
INSERT INTO siem_delivery_outbox (
  security_event_id,
  status,
  next_attempt_at
)
SELECT id, 'pending', clock_timestamp()
FROM security_events
ON CONFLICT (security_event_id) DO NOTHING;

CREATE OR REPLACE FUNCTION claim_siem_deliveries(
  p_limit integer,
  p_lease_seconds integer
)
RETURNS TABLE (
  security_event_id uuid,
  lease_token uuid,
  attempts integer,
  id uuid,
  occurred_at timestamptz,
  event_hash text,
  action text,
  outcome text,
  actor_user_id uuid,
  actor_email text,
  actor_role text,
  program_id uuid,
  resource_type text,
  resource_id text,
  request_id text,
  source_ip text,
  details jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH candidates AS (
    SELECT outbox.security_event_id
    FROM siem_delivery_outbox AS outbox
    WHERE (
      outbox.status = 'pending'
      AND outbox.next_attempt_at <= clock_timestamp()
    ) OR (
      outbox.status = 'delivering'
      AND outbox.lease_expires_at <= clock_timestamp()
    )
    ORDER BY outbox.next_attempt_at, outbox.created_at
    FOR UPDATE OF outbox SKIP LOCKED
    LIMIT greatest(1, least(p_limit, 100))
  ),
  claimed AS (
    UPDATE siem_delivery_outbox AS outbox
    SET status = 'delivering',
        attempts = outbox.attempts + 1,
        last_attempt_at = clock_timestamp(),
        lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp()
          + make_interval(secs => greatest(5, least(p_lease_seconds, 300))),
        updated_at = clock_timestamp()
    FROM candidates
    WHERE outbox.security_event_id = candidates.security_event_id
    RETURNING
      outbox.security_event_id,
      outbox.lease_token,
      outbox.attempts
  )
  SELECT
    claimed.security_event_id,
    claimed.lease_token,
    claimed.attempts,
    event.id,
    event.occurred_at,
    event.event_hash,
    event.action,
    event.outcome,
    event.actor_user_id,
    event.actor_email,
    event.actor_role,
    event.program_id,
    event.resource_type,
    event.resource_id,
    event.request_id,
    event.source_ip,
    event.details
  FROM claimed
  JOIN security_events AS event ON event.id = claimed.security_event_id
  ORDER BY event.sequence;
$$;

CREATE OR REPLACE FUNCTION complete_siem_delivery(
  p_security_event_id uuid,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH completed AS (
    UPDATE siem_delivery_outbox
    SET status = 'delivered',
        next_attempt_at = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        delivered_at = clock_timestamp(),
        dead_lettered_at = NULL,
        last_error = NULL,
        updated_at = clock_timestamp()
    WHERE security_event_id = p_security_event_id
      AND status = 'delivering'
      AND lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM completed);
$$;

CREATE OR REPLACE FUNCTION fail_siem_delivery(
  p_security_event_id uuid,
  p_lease_token uuid,
  p_error text,
  p_dead_letter boolean,
  p_next_attempt_at timestamptz
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH failed AS (
    UPDATE siem_delivery_outbox
    SET status = CASE WHEN p_dead_letter THEN 'dead_letter' ELSE 'pending' END,
        next_attempt_at = CASE
          WHEN p_dead_letter THEN NULL
          ELSE greatest(clock_timestamp(), p_next_attempt_at)
        END,
        lease_token = NULL,
        lease_expires_at = NULL,
        delivered_at = NULL,
        dead_lettered_at = CASE
          WHEN p_dead_letter THEN clock_timestamp()
          ELSE NULL
        END,
        last_error = left(COALESCE(p_error, 'unknown delivery failure'), 2000),
        updated_at = clock_timestamp()
    WHERE security_event_id = p_security_event_id
      AND status = 'delivering'
      AND lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM failed);
$$;

CREATE OR REPLACE FUNCTION get_siem_delivery_health()
RETURNS TABLE (
  pending_count bigint,
  delivering_count bigint,
  delivered_count bigint,
  dead_letter_count bigint,
  oldest_pending_at timestamptz,
  last_delivered_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    count(*) FILTER (WHERE status = 'pending') AS pending_count,
    count(*) FILTER (WHERE status = 'delivering') AS delivering_count,
    count(*) FILTER (WHERE status = 'delivered') AS delivered_count,
    count(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_count,
    min(created_at) FILTER (
      WHERE status IN ('pending', 'delivering')
    ) AS oldest_pending_at,
    max(delivered_at) AS last_delivered_at
  FROM siem_delivery_outbox;
$$;

-- State changes are available only through lease-fenced functions. The role
-- applying this DDL must be the same role used by the app. If deployment later
-- separates migration and runtime roles, grant these functions only to the
-- named runtime role instead.
REVOKE ALL ON siem_delivery_outbox FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_security_event_for_siem() FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_siem_deliveries(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_siem_delivery(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_siem_delivery(uuid, uuid, text, boolean, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_siem_delivery_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_siem_deliveries(integer, integer) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION complete_siem_delivery(uuid, uuid) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION fail_siem_delivery(uuid, uuid, text, boolean, timestamptz) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION get_siem_delivery_health() TO CURRENT_USER;

COMMIT;

-- Verification. Run after COMMIT and retain raw results.
SELECT to_regclass('siem_delivery_outbox') AS siem_delivery_outbox;
SELECT to_regprocedure('claim_siem_deliveries(integer,integer)') AS claim_function;
SELECT to_regprocedure('complete_siem_delivery(uuid,uuid)') AS complete_function;
SELECT to_regprocedure(
  'fail_siem_delivery(uuid,uuid,text,boolean,timestamp with time zone)'
) AS fail_function;
SELECT to_regprocedure('get_siem_delivery_health()') AS health_function;

SELECT tgname, tgrelid::regclass AS table_name
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgname = 'security_events_siem_enqueue';

SELECT
  (SELECT count(*) FROM security_events) AS security_event_count,
  (SELECT count(*) FROM siem_delivery_outbox) AS outbox_count,
  (
    SELECT count(*)
    FROM security_events AS event
    LEFT JOIN siem_delivery_outbox AS outbox
      ON outbox.security_event_id = event.id
    WHERE outbox.security_event_id IS NULL
  ) AS events_missing_outbox;

SELECT * FROM get_siem_delivery_health();

SELECT count(*) AS invalid_delivery_rows
FROM siem_delivery_outbox
WHERE (status = 'delivering' AND (lease_token IS NULL OR lease_expires_at IS NULL))
   OR (status <> 'delivering' AND (lease_token IS NOT NULL OR lease_expires_at IS NOT NULL))
   OR (status = 'delivered' AND delivered_at IS NULL)
   OR (status = 'dead_letter' AND dead_lettered_at IS NULL);
