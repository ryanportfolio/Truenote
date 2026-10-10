-- Evidence harness store (docs/security/evidence-harness.md).
--
-- evidence_receipts holds one row per check run: which check, which NIST SP
-- 800-53 Rev. 5 controls and SP 800-53A objectives it covers, what it observed
-- and whether it passed. Rows are hash-chained like security_events: each
-- receipt_hash covers the previous receipt_hash, so an edited, removed or
-- reordered receipt breaks every later hash.
--
-- The application writes only through append_evidence_receipt, a SECURITY
-- DEFINER function owned by the migration role. It stores the canonical JSON
-- payload the caller built byte for byte, derives the query columns from it,
-- and computes the hashes, so a verifier outside the database can recompute
-- the chain from (previous_hash, id, recorded_at_text, payload) alone:
--
--   payload_sha256 = sha256(payload)
--   receipt_hash   = sha256(previous_hash || '|' || id || '|' ||
--                           recorded_at_text || '|' || payload_sha256)
--
-- with previous_hash '' for the first receipt. Triggers refuse UPDATE, DELETE
-- and TRUNCATE for every role, the owner included, as 0008 does for
-- security_events.
--
-- evidence_known_gaps links a failing check to an accepted POA&M item so the
-- harness can tell a known, tracked failure from a new one. It is annotation,
-- not evidence: a super_user adds and retires links through the admin API
-- (each change is a security event); rows are never deleted.
--
-- 0007's default privileges give truenote_app SELECT, INSERT, UPDATE and
-- DELETE on new tables; this file narrows both tables below.

CREATE TABLE IF NOT EXISTS evidence_receipts (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  recorded_at timestamptz NOT NULL,
  recorded_at_text text NOT NULL,
  check_id text NOT NULL,
  check_kind text NOT NULL,
  result text NOT NULL,
  run_id uuid,
  controls text[] NOT NULL,
  objectives text[] NOT NULL,
  payload text NOT NULL,
  payload_sha256 text NOT NULL,
  previous_hash text,
  receipt_hash text NOT NULL UNIQUE,
  CONSTRAINT evidence_receipts_result_check
    CHECK (result IN ('pass', 'fail', 'error')),
  CONSTRAINT evidence_receipts_kind_check
    CHECK (check_kind IN (
      'github', 'external', 'database', 'synthetic', 'attestation',
      'operator', 'integrity', 'summary'
    ))
);

CREATE INDEX IF NOT EXISTS evidence_receipts_check_idx
  ON evidence_receipts (check_id, sequence DESC);
CREATE INDEX IF NOT EXISTS evidence_receipts_controls_idx
  ON evidence_receipts USING gin (controls);
CREATE INDEX IF NOT EXISTS evidence_receipts_recorded_idx
  ON evidence_receipts (recorded_at DESC);

CREATE OR REPLACE FUNCTION append_evidence_receipt(p_payload text)
RETURNS TABLE(id uuid, sequence bigint, recorded_at text, receipt_hash text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_doc jsonb;
  v_id uuid := gen_random_uuid();
  v_recorded_at timestamptz := clock_timestamp();
  v_recorded_text text;
  v_previous_hash text;
  v_payload_hash text;
  v_receipt_hash text;
  v_sequence bigint;
  v_run_id uuid;
BEGIN
  IF p_payload IS NULL OR length(p_payload) > 1048576 THEN
    RAISE EXCEPTION 'evidence payload is missing or larger than 1 MiB';
  END IF;
  v_doc := p_payload::jsonb;

  IF jsonb_typeof(v_doc) <> 'object'
     OR jsonb_typeof(v_doc->'checkId') <> 'string'
     OR jsonb_typeof(v_doc->'kind') <> 'string'
     OR jsonb_typeof(v_doc->'result') <> 'string'
     OR jsonb_typeof(v_doc->'controls') <> 'array'
     OR jsonb_typeof(v_doc->'objectives') <> 'array' THEN
    RAISE EXCEPTION 'evidence payload is missing checkId, kind, result, controls or objectives';
  END IF;

  IF v_doc ? 'runId' AND jsonb_typeof(v_doc->'runId') = 'string' THEN
    v_run_id := (v_doc->>'runId')::uuid;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('truenote.evidence_receipts.hash_chain'));

  SELECT er.receipt_hash
  INTO v_previous_hash
  FROM evidence_receipts er
  ORDER BY er.sequence DESC
  LIMIT 1;

  v_recorded_text := to_char(
    v_recorded_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  v_payload_hash := encode(digest(p_payload, 'sha256'), 'hex');
  v_receipt_hash := encode(
    digest(
      concat_ws(
        '|',
        COALESCE(v_previous_hash, ''),
        v_id::text,
        v_recorded_text,
        v_payload_hash
      ),
      'sha256'
    ),
    'hex'
  );

  INSERT INTO evidence_receipts (
    id, recorded_at, recorded_at_text, check_id, check_kind, result, run_id,
    controls, objectives, payload, payload_sha256, previous_hash, receipt_hash
  )
  VALUES (
    v_id,
    v_recorded_at,
    v_recorded_text,
    v_doc->>'checkId',
    v_doc->>'kind',
    v_doc->>'result',
    v_run_id,
    ARRAY(SELECT jsonb_array_elements_text(v_doc->'controls')),
    ARRAY(SELECT jsonb_array_elements_text(v_doc->'objectives')),
    p_payload,
    v_payload_hash,
    v_previous_hash,
    v_receipt_hash
  )
  RETURNING evidence_receipts.sequence INTO v_sequence;

  RETURN QUERY SELECT v_id, v_sequence, v_recorded_text, v_receipt_hash;
END;
$$;

CREATE OR REPLACE FUNCTION block_evidence_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'evidence_receipts is append-only';
END;
$$;

DROP TRIGGER IF EXISTS evidence_receipts_append_only ON evidence_receipts;
CREATE TRIGGER evidence_receipts_append_only
BEFORE UPDATE OR DELETE ON evidence_receipts
FOR EACH ROW EXECUTE FUNCTION block_evidence_receipt_mutation();

DROP TRIGGER IF EXISTS evidence_receipts_no_truncate ON evidence_receipts;
CREATE TRIGGER evidence_receipts_no_truncate
BEFORE TRUNCATE ON evidence_receipts
FOR EACH STATEMENT EXECUTE FUNCTION block_evidence_receipt_mutation();

CREATE TABLE IF NOT EXISTS evidence_known_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id text NOT NULL,
  poam_id text NOT NULL,
  note text NOT NULL DEFAULT '',
  expires_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  retired_at timestamptz,
  retired_by uuid,
  CONSTRAINT evidence_known_gaps_poam_check CHECK (length(poam_id) BETWEEN 1 AND 64),
  CONSTRAINT evidence_known_gaps_note_check CHECK (length(note) <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS evidence_known_gaps_active_idx
  ON evidence_known_gaps (check_id, poam_id)
  WHERE retired_at IS NULL;

-- Receipts: read, and append only through the function.
REVOKE ALL ON evidence_receipts FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON evidence_receipts FROM truenote_app;
GRANT SELECT ON evidence_receipts TO truenote_app;
REVOKE EXECUTE ON FUNCTION append_evidence_receipt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_evidence_receipt(text) TO truenote_app;

-- Known gaps: add and retire, never delete.
REVOKE ALL ON evidence_known_gaps FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON evidence_known_gaps FROM truenote_app;
GRANT SELECT, INSERT, UPDATE ON evidence_known_gaps TO truenote_app;
