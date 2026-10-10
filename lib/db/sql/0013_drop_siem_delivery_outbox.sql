-- Retire the SIEM delivery outbox (owner decision, 2026-10-10).
--
-- docs/security/p1-siem-delivery-outbox.sql was never fully applied: the
-- 2026-10-07 copy of the Replit database brought the siem_delivery_outbox
-- table but none of its functions or its enqueue trigger, and the table held
-- 0 rows when checked on 2026-10-10. Security events now leave the database
-- through the worker's security monitor (lib/db/sql/0011_monitoring_state.sql,
-- docs/security/monitoring.md). The table's ON DELETE RESTRICT foreign key to
-- security_events is the only foreign key on that table, and nothing reads it.
--
-- The function and trigger drops cover databases where the source file was
-- applied in full (a restore from the old Replit development database).

DO $$
BEGIN
  -- Nested: PL/pgSQL plans a whole IF condition at once, so a combined
  -- condition would fail on a missing table before the existence test ran.
  IF to_regclass('public.siem_delivery_outbox') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM siem_delivery_outbox) THEN
      RAISE EXCEPTION 'siem_delivery_outbox has rows; inspect them before dropping the table';
    END IF;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS security_events_siem_enqueue ON security_events;
DROP FUNCTION IF EXISTS enqueue_security_event_for_siem();
DROP FUNCTION IF EXISTS claim_siem_deliveries(integer, integer);
DROP FUNCTION IF EXISTS complete_siem_delivery(uuid, uuid);
DROP FUNCTION IF EXISTS fail_siem_delivery(uuid, uuid, text, boolean, timestamptz);
DROP FUNCTION IF EXISTS get_siem_delivery_health();
DROP TABLE IF EXISTS siem_delivery_outbox;
