-- Operator receipts come from the owner only (docs/security/evidence-harness.md,
-- phase 3).
--
-- The monthly operator check runs as the migration role and appends receipts
-- of kind 'operator'; the kind claims that the owner ran the check. Under 0012
-- the application role truenote_app could append a receipt of that kind as
-- well, so the claim proved nothing. This file replaces
-- append_evidence_receipt(text) with the same function plus one rule:
--
-- * A payload whose kind is 'operator' (compared case-insensitively) is
--   refused unless session_user, the role that logged in, is a member of the
--   function's owner, the migration role. Inside a SECURITY DEFINER function
--   current_user is always the owner, so the rule checks session_user and
--   looks the owner up in pg_proc. truenote_app (0007_app_runtime_role.sql)
--   is not a member of the owner, so it gets an exception.
-- * Every other kind is stored exactly as before. The hash rule, the stored
--   columns, SECURITY DEFINER and the pinned search_path do not change.
--
-- CREATE OR REPLACE keeps the owner and the grants; they are stated again at
-- the end so the file alone shows them. The file runs again without changes.

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
  v_owner oid;
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

  IF lower(v_doc->>'kind') = 'operator' THEN
    SELECT p.proowner
    INTO v_owner
    FROM pg_proc p
    WHERE p.oid = 'public.append_evidence_receipt(text)'::regprocedure;
    IF v_owner IS NULL OR NOT pg_has_role(session_user, v_owner, 'MEMBER') THEN
      RAISE EXCEPTION 'only the migration role can append an evidence receipt of kind operator';
    END IF;
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

REVOKE EXECUTE ON FUNCTION append_evidence_receipt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_evidence_receipt(text) TO truenote_app;
