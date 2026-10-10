-- One-time data cleanup for citation receipts of revoked and deleted
-- documents (purgeCitationSnapshotsForDocument, lib/citations.ts).
-- Until #232 the purge set query_log.citation_snapshots to NULL. The column
-- is NOT NULL, so every purge failed and the excerpts stayed at rest; on
-- 2026-10-10, 12 rows held receipts of revoked versions and 0 held receipts
-- of deleted documents. History reads already withhold them.
--
-- Replace each such snapshot with the tombstone the purge now writes,
-- {"purged": true}. The whole snapshot goes, because a partial edit would
-- break the index alignment with cited_chunk_ids; those exchanges fall back
-- to the legacy resolver, which withholds them. A row qualifies when any
-- receipt names a revoked version or a document that no longer exists.
-- Receipts of other versions of a revoked version's document are kept: they
-- hold no revoked text.
--
-- Data only: no DDL. Safe before or after the #232 deploy; the deployed
-- readers already treat a non-array snapshot as no receipt.

UPDATE query_log q
SET citation_snapshots = '{"purged": true}'::jsonb
WHERE jsonb_typeof(q.citation_snapshots) = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(q.citation_snapshots) AS e(receipt)
    WHERE EXISTS (
        SELECT 1
        FROM document_versions v
        WHERE v.id::text = e.receipt ->> 'document_version_id'
          AND (v.revoked_at IS NOT NULL OR v.lifecycle_state = 'revoked')
      )
      OR (
        e.receipt ? 'doc_id'
        AND NOT EXISTS (
          SELECT 1 FROM documents d WHERE d.id::text = e.receipt ->> 'doc_id'
        )
      )
  );
