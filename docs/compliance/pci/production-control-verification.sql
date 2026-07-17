-- Truenote production security-control catalog verification.
-- Read-only: returns catalog state and source-equivalent object definitions.
-- It does not select application rows, prompts, document content, PAN, or PII.
-- Execute with the approved read-only evidence role after deployment.

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

WITH
runtime_context(runtime_role) AS (
  SELECT to_regrole(NULLIF(current_setting('truenote.evidence_runtime_role', true), ''))
),
expected_tables(table_name) AS (
  VALUES
    ('content_sources'),
    ('security_control_metadata'),
    ('security_rate_limits'),
    ('security_events'),
    ('siem_delivery_outbox')
),
expected_columns(table_name, column_name, expected_type, require_not_null) AS (
  VALUES
    ('documents', 'lifecycle_state', 'text', true),
    ('documents', 'retired_at', 'timestamp with time zone', false),
    ('documents', 'retired_by', 'uuid', false),
    ('documents', 'retirement_reason', 'text', false),
    ('document_versions', 'lifecycle_state', 'text', true),
    ('document_versions', 'classification', 'text', true),
    ('document_versions', 'source_id', 'uuid', true),
    ('document_versions', 'source_origin_uri', 'text', false),
    ('document_versions', 'source_owner', 'text', true),
    ('document_versions', 'original_file_name', 'text', true),
    ('document_versions', 'scan_status', 'text', true),
    ('document_versions', 'scan_engine', 'text', false),
    ('document_versions', 'scan_id', 'text', false),
    ('document_versions', 'scan_findings', 'jsonb', true),
    ('document_versions', 'scan_completed_at', 'timestamp with time zone', false),
    ('document_versions', 'approved_by', 'uuid', false),
    ('document_versions', 'approved_at', 'timestamp with time zone', false),
    ('document_versions', 'approval_notes', 'text', false),
    ('document_versions', 'activated_at', 'timestamp with time zone', false),
    ('document_versions', 'retired_at', 'timestamp with time zone', false),
    ('document_versions', 'rejected_by', 'uuid', false),
    ('document_versions', 'rejected_at', 'timestamp with time zone', false),
    ('document_versions', 'rejection_reason', 'text', false),
    ('document_versions', 'revoked_by', 'uuid', false),
    ('document_versions', 'revoked_at', 'timestamp with time zone', false),
    ('document_versions', 'revocation_reason', 'text', false),
    ('document_versions', 'retention_until', 'timestamp with time zone', true),
    ('users', 'max_classification', 'text', true),
    ('sessions', 'auth_method', 'text', true),
    ('sessions', 'auth_time', 'timestamp with time zone', true),
    ('content_sources', 'id', 'uuid', true),
    ('content_sources', 'program_id', 'uuid', true),
    ('content_sources', 'name', 'text', true),
    ('content_sources', 'origin_type', 'text', true),
    ('content_sources', 'base_uri', 'text', false),
    ('content_sources', 'owner_name', 'text', true),
    ('content_sources', 'is_active', 'boolean', true),
    ('content_sources', 'created_by', 'uuid', false),
    ('content_sources', 'created_at', 'timestamp with time zone', true),
    ('content_sources', 'approved_by', 'uuid', false),
    ('content_sources', 'approved_at', 'timestamp with time zone', false),
    ('content_sources', 'approval_basis', 'text', false),
    ('content_sources', 'retired_at', 'timestamp with time zone', false),
    ('security_control_metadata', 'key', 'text', true),
    ('security_control_metadata', 'applied_at', 'timestamp with time zone', true),
    ('security_control_metadata', 'details', 'jsonb', true),
    ('security_rate_limits', 'scope', 'text', true),
    ('security_rate_limits', 'subject', 'text', true),
    ('security_rate_limits', 'window_start', 'timestamp with time zone', true),
    ('security_rate_limits', 'request_count', 'integer', true),
    ('security_rate_limits', 'expires_at', 'timestamp with time zone', true),
    ('security_events', 'sequence', 'bigint', true),
    ('security_events', 'id', 'uuid', true),
    ('security_events', 'occurred_at', 'timestamp with time zone', true),
    ('security_events', 'action', 'text', true),
    ('security_events', 'outcome', 'text', true),
    ('security_events', 'actor_user_id', 'uuid', false),
    ('security_events', 'actor_email', 'text', false),
    ('security_events', 'actor_role', 'text', false),
    ('security_events', 'program_id', 'uuid', false),
    ('security_events', 'resource_type', 'text', false),
    ('security_events', 'resource_id', 'text', false),
    ('security_events', 'request_id', 'text', false),
    ('security_events', 'source_ip', 'text', false),
    ('security_events', 'details', 'jsonb', true),
    ('security_events', 'previous_hash', 'text', false),
    ('security_events', 'event_hash', 'text', true),
    ('siem_delivery_outbox', 'security_event_id', 'uuid', true),
    ('siem_delivery_outbox', 'status', 'text', true),
    ('siem_delivery_outbox', 'attempts', 'integer', true),
    ('siem_delivery_outbox', 'next_attempt_at', 'timestamp with time zone', false),
    ('siem_delivery_outbox', 'lease_token', 'uuid', false),
    ('siem_delivery_outbox', 'lease_expires_at', 'timestamp with time zone', false),
    ('siem_delivery_outbox', 'last_attempt_at', 'timestamp with time zone', false),
    ('siem_delivery_outbox', 'delivered_at', 'timestamp with time zone', false),
    ('siem_delivery_outbox', 'dead_lettered_at', 'timestamp with time zone', false),
    ('siem_delivery_outbox', 'last_error', 'text', false),
    ('siem_delivery_outbox', 'created_at', 'timestamp with time zone', true),
    ('siem_delivery_outbox', 'updated_at', 'timestamp with time zone', true)
),
expected_constraints(table_name, constraint_name) AS (
  VALUES
    ('content_sources', 'content_sources_approval_check'),
    ('document_versions', 'document_versions_lifecycle_check'),
    ('document_versions', 'document_versions_classification_check'),
    ('document_versions', 'document_versions_scan_status_check'),
    ('document_versions', 'document_versions_active_control_check'),
    ('documents', 'documents_lifecycle_check'),
    ('users', 'users_max_classification_check'),
    ('sessions', 'sessions_auth_method_check'),
    ('security_rate_limits', 'security_rate_limits_pkey'),
    ('security_rate_limits', 'security_rate_limits_request_count_check'),
    ('security_events', 'security_events_pkey'),
    ('security_events', 'security_events_sequence_key'),
    ('security_events', 'security_events_outcome_check'),
    ('security_events', 'security_events_event_hash_key'),
    ('siem_delivery_outbox', 'siem_delivery_outbox_pkey'),
    ('siem_delivery_outbox', 'siem_delivery_outbox_status_check'),
    ('siem_delivery_outbox', 'siem_delivery_outbox_attempts_check'),
    ('siem_delivery_outbox', 'siem_delivery_outbox_lease_check'),
    ('siem_delivery_outbox', 'siem_delivery_outbox_terminal_check')
),
expected_indexes(index_name) AS (
  VALUES
    ('content_sources_program_name_uidx'),
    ('content_sources_program_active_idx'),
    ('document_versions_review_queue_idx'),
    ('document_versions_classification_active_idx'),
    ('document_versions_source_idx'),
    ('document_versions_retention_idx'),
    ('security_rate_limits_expiry_idx'),
    ('security_events_occurred_idx'),
    ('security_events_program_occurred_idx'),
    ('security_events_action_occurred_idx'),
    ('siem_delivery_outbox_due_idx'),
    ('siem_delivery_outbox_dead_letter_idx')
),
expected_functions(signature, require_security_definer, expected_search_path) AS (
  VALUES
    ('public.append_security_event(text,text,uuid,text,text,uuid,text,text,text,text,jsonb)', true, 'search_path=public, pg_catalog'),
    ('public.block_security_event_mutation()', false, NULL),
    ('public.audit_document_version_lifecycle()', true, 'search_path=public, pg_catalog'),
    ('public.audit_content_source_change()', true, 'search_path=public, pg_catalog'),
    ('public.enqueue_security_event_for_siem()', true, 'search_path=pg_catalog, public'),
    ('public.claim_siem_deliveries(integer,integer)', true, 'search_path=pg_catalog, public'),
    ('public.complete_siem_delivery(uuid,uuid)', true, 'search_path=pg_catalog, public'),
    ('public.fail_siem_delivery(uuid,uuid,text,boolean,timestamp with time zone)', true, 'search_path=pg_catalog, public'),
    ('public.get_siem_delivery_health()', true, 'search_path=pg_catalog, public')
),
expected_triggers(table_name, trigger_name) AS (
  VALUES
    ('security_events', 'security_events_append_only'),
    ('security_events', 'security_events_siem_enqueue'),
    ('document_versions', 'document_versions_audit_insert'),
    ('document_versions', 'document_versions_audit_lifecycle'),
    ('content_sources', 'content_sources_audit_insert'),
    ('content_sources', 'content_sources_audit_update')
),
siem_functions(signature, app_execute_required) AS (
  VALUES
    ('public.enqueue_security_event_for_siem()', false),
    ('public.claim_siem_deliveries(integer,integer)', true),
    ('public.complete_siem_delivery(uuid,uuid)', true),
    ('public.fail_siem_delivery(uuid,uuid,text,boolean,timestamp with time zone)', true),
    ('public.get_siem_delivery_health()', true)
),
table_checks AS (
  SELECT
    'table'::text AS category,
    'public.' || expected.table_name AS control,
    to_regclass('public.' || expected.table_name) IS NOT NULL AS passed,
    COALESCE(to_regclass('public.' || expected.table_name)::text, 'missing') AS observed
  FROM expected_tables AS expected
),
column_checks AS (
  SELECT
    'column'::text AS category,
    'public.' || expected.table_name || '.' || expected.column_name AS control,
    attribute.attname IS NOT NULL
      AND format_type(attribute.atttypid, attribute.atttypmod) = expected.expected_type
      AND (NOT expected.require_not_null OR attribute.attnotnull) AS passed,
    CASE
      WHEN attribute.attname IS NULL THEN 'missing'
      ELSE format_type(attribute.atttypid, attribute.atttypmod)
        || CASE WHEN attribute.attnotnull THEN ' not null' ELSE ' nullable' END
    END AS observed
  FROM expected_columns AS expected
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.oid = to_regclass('public.' || expected.table_name)
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attname = expected.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
),
constraint_checks AS (
  SELECT
    'constraint'::text AS category,
    'public.' || expected.table_name || '.' || expected.constraint_name AS control,
    constraint_row.oid IS NOT NULL AND constraint_row.convalidated AS passed,
    CASE
      WHEN constraint_row.oid IS NULL THEN 'missing'
      ELSE CASE WHEN constraint_row.convalidated THEN 'present and validated' ELSE 'present but not validated' END
    END AS observed
  FROM expected_constraints AS expected
  LEFT JOIN pg_catalog.pg_constraint AS constraint_row
    ON constraint_row.conrelid = to_regclass('public.' || expected.table_name)
   AND constraint_row.conname = expected.constraint_name
),
index_checks AS (
  SELECT
    'index'::text AS category,
    'public.' || expected.index_name AS control,
    index_row.indexrelid IS NOT NULL
      AND index_row.indisvalid
      AND index_row.indisready AS passed,
    CASE
      WHEN index_row.indexrelid IS NULL THEN 'missing'
      WHEN index_row.indisvalid AND index_row.indisready THEN 'present, valid, and ready'
      ELSE 'present but invalid or not ready'
    END AS observed
  FROM expected_indexes AS expected
  LEFT JOIN pg_catalog.pg_index AS index_row
    ON index_row.indexrelid = to_regclass('public.' || expected.index_name)
),
function_checks AS (
  SELECT
    'function'::text AS category,
    expected.signature AS control,
    function_row.oid IS NOT NULL
      AND (NOT expected.require_security_definer OR function_row.prosecdef)
      AND (
        expected.expected_search_path IS NULL
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(function_row.proconfig, ARRAY[]::text[])) AS setting
          WHERE setting = expected.expected_search_path
        )
      ) AS passed,
    CASE
      WHEN function_row.oid IS NULL THEN 'missing'
      ELSE
        CASE WHEN function_row.prosecdef THEN 'security definer' ELSE 'invoker security' END
        || CASE
          WHEN EXISTS (
            SELECT 1
            FROM unnest(COALESCE(function_row.proconfig, ARRAY[]::text[])) AS setting
            WHERE setting = expected.expected_search_path
          ) THEN ', approved search_path'
          WHEN expected.expected_search_path IS NULL THEN ', inherited search_path allowed'
          ELSE ', missing or unexpected search_path'
        END
    END AS observed
  FROM expected_functions AS expected
  LEFT JOIN pg_catalog.pg_proc AS function_row
    ON function_row.oid = to_regprocedure(expected.signature)
),
trigger_checks AS (
  SELECT
    'trigger'::text AS category,
    'public.' || expected.table_name || '.' || expected.trigger_name AS control,
    trigger_row.oid IS NOT NULL AND trigger_row.tgenabled <> 'D' AS passed,
    CASE
      WHEN trigger_row.oid IS NULL THEN 'missing'
      WHEN trigger_row.tgenabled = 'D' THEN 'present but disabled'
      ELSE 'present and enabled'
    END AS observed
  FROM expected_triggers AS expected
  LEFT JOIN pg_catalog.pg_trigger AS trigger_row
    ON trigger_row.tgrelid = to_regclass('public.' || expected.table_name)
   AND trigger_row.tgname = expected.trigger_name
   AND NOT trigger_row.tgisinternal
),
function_privilege_checks AS (
  SELECT
    'function privilege'::text AS category,
    expected.signature || ' PUBLIC EXECUTE revoked' AS control,
    function_row.oid IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(function_row.proacl, acldefault('f', function_row.proowner))) AS privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
      ) AS passed,
    CASE
      WHEN function_row.oid IS NULL THEN 'function missing'
      WHEN EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(function_row.proacl, acldefault('f', function_row.proowner))) AS privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
      ) THEN 'PUBLIC can execute'
      ELSE 'PUBLIC cannot execute'
    END AS observed
  FROM siem_functions AS expected
  LEFT JOIN pg_catalog.pg_proc AS function_row
    ON function_row.oid = to_regprocedure(expected.signature)

  UNION ALL

  SELECT
    'function privilege'::text AS category,
    expected.signature || ' runtime role EXECUTE' AS control,
    runtime_context.runtime_role IS NOT NULL
      AND function_row.oid IS NOT NULL
      AND has_function_privilege(runtime_context.runtime_role, function_row.oid, 'EXECUTE') AS passed,
    CASE
      WHEN runtime_context.runtime_role IS NULL THEN 'approved runtime role setting missing or invalid'
      WHEN function_row.oid IS NULL THEN 'function missing'
      WHEN has_function_privilege(runtime_context.runtime_role, function_row.oid, 'EXECUTE') THEN 'approved runtime role can execute'
      ELSE 'approved runtime role cannot execute'
    END AS observed
  FROM siem_functions AS expected
  CROSS JOIN runtime_context
  LEFT JOIN pg_catalog.pg_proc AS function_row
    ON function_row.oid = to_regprocedure(expected.signature)
  WHERE expected.app_execute_required
),
table_privilege_checks AS (
  SELECT
    'table privilege'::text AS category,
    'public.siem_delivery_outbox PUBLIC privileges revoked' AS control,
    relation.oid IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) AS privilege
        WHERE privilege.grantee = 0
      ) AS passed,
    CASE
      WHEN relation.oid IS NULL THEN 'table missing'
      WHEN EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) AS privilege
        WHERE privilege.grantee = 0
      ) THEN 'PUBLIC has table privileges'
      ELSE 'PUBLIC has no table privileges'
    END AS observed
  FROM (SELECT to_regclass('public.siem_delivery_outbox') AS oid) AS target
  LEFT JOIN pg_catalog.pg_class AS relation ON relation.oid = target.oid
),
all_checks AS (
  SELECT * FROM table_checks
  UNION ALL SELECT * FROM column_checks
  UNION ALL SELECT * FROM constraint_checks
  UNION ALL SELECT * FROM index_checks
  UNION ALL SELECT * FROM function_checks
  UNION ALL SELECT * FROM trigger_checks
  UNION ALL SELECT * FROM function_privilege_checks
  UNION ALL SELECT * FROM table_privilege_checks
)
SELECT category, control, passed, observed
FROM all_checks
ORDER BY passed, category, control;

-- Retain these definitions and hashes with the execution record. They contain
-- schema/function source, not application data. Compare them with the reviewed
-- DDL in docs/security before accepting the deployed state.
WITH definitions AS (
  SELECT
    'constraint'::text AS object_type,
    relation.oid::regclass::text || '.' || constraint_row.conname AS object_name,
    pg_get_constraintdef(constraint_row.oid, true) AS definition
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND constraint_row.conname IN (
      'content_sources_approval_check',
      'document_versions_lifecycle_check',
      'document_versions_classification_check',
      'document_versions_scan_status_check',
      'document_versions_active_control_check',
      'documents_lifecycle_check',
      'users_max_classification_check',
      'sessions_auth_method_check',
      'security_rate_limits_pkey',
      'security_rate_limits_request_count_check',
      'security_events_pkey',
      'security_events_sequence_key',
      'security_events_outcome_check',
      'security_events_event_hash_key',
      'siem_delivery_outbox_pkey',
      'siem_delivery_outbox_status_check',
      'siem_delivery_outbox_attempts_check',
      'siem_delivery_outbox_lease_check',
      'siem_delivery_outbox_terminal_check'
    )

  UNION ALL

  SELECT
    'index'::text,
    index_row.indexrelid::regclass::text,
    pg_get_indexdef(index_row.indexrelid)
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS relation ON relation.oid = index_row.indexrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname IN (
      'content_sources_program_name_uidx',
      'content_sources_program_active_idx',
      'document_versions_review_queue_idx',
      'document_versions_classification_active_idx',
      'document_versions_source_idx',
      'document_versions_retention_idx',
      'security_rate_limits_expiry_idx',
      'security_events_occurred_idx',
      'security_events_program_occurred_idx',
      'security_events_action_occurred_idx',
      'siem_delivery_outbox_due_idx',
      'siem_delivery_outbox_dead_letter_idx'
    )

  UNION ALL

  SELECT
    'function'::text,
    function_row.oid::regprocedure::text,
    pg_get_functiondef(function_row.oid)
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = function_row.pronamespace
  WHERE namespace.nspname = 'public'
    AND function_row.proname IN (
      'append_security_event',
      'block_security_event_mutation',
      'audit_document_version_lifecycle',
      'audit_content_source_change',
      'enqueue_security_event_for_siem',
      'claim_siem_deliveries',
      'complete_siem_delivery',
      'fail_siem_delivery',
      'get_siem_delivery_health'
    )

  UNION ALL

  SELECT
    'trigger'::text,
    trigger_row.tgrelid::regclass::text || '.' || trigger_row.tgname,
    pg_get_triggerdef(trigger_row.oid, true)
  FROM pg_catalog.pg_trigger AS trigger_row
  JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgname IN (
      'security_events_append_only',
      'security_events_siem_enqueue',
      'document_versions_audit_insert',
      'document_versions_audit_lifecycle',
      'content_sources_audit_insert',
      'content_sources_audit_update'
    )
)
SELECT
  object_type,
  object_name,
  encode(digest(definition, 'sha256'), 'hex') AS definition_sha256,
  definition
FROM definitions
ORDER BY object_type, object_name;

COMMIT;
