import { sql, type SQL } from "drizzle-orm";
import {
  classificationSqlPredicate,
  type Classification
} from "./security/classification.js";

/**
 * Shared SQL fragments for the source library and source-usage analytics.
 * Every fragment takes the effective program id and the viewer's clearance
 * so callers cannot forget either half of the read boundary.
 */

/** `ARRAY[...]::uuid[]`. Drizzle expands JS arrays into a value list, so build it by hand. */
export function uuidArray(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `
  )}]::uuid[]`;
}

/**
 * True when `documentIdSql` names a document in the program whose ACTIVE,
 * parse-ready version the viewer's clearance may read. This is the same rule
 * GET /api/kb/documents lists by.
 */
export function documentVisibleSql(
  documentIdSql: SQL,
  programId: string,
  clearance: Classification
): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM documents AS vis_d
    INNER JOIN document_versions AS vis_v ON vis_v.document_id = vis_d.id
    WHERE vis_d.id = ${documentIdSql}
      AND vis_d.program_id = ${programId}::uuid
      AND vis_v.is_active = true
      AND vis_v.parse_status = 'ready'
      AND vis_v.lifecycle_state = 'active'
      AND ${classificationSqlPredicate(sql.raw("vis_v.classification"), clearance)}
  )`;
}

/**
 * True when the document is live in the program but its active version is
 * above the viewer's clearance. Replace-style writes keep rows for these
 * documents so a lower-clearance manager cannot silently drop them.
 */
export function documentHiddenByClearanceSql(
  documentIdSql: SQL,
  programId: string,
  clearance: Classification
): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM documents AS hid_d
    INNER JOIN document_versions AS hid_v ON hid_v.document_id = hid_d.id
    WHERE hid_d.id = ${documentIdSql}
      AND hid_d.program_id = ${programId}::uuid
      AND hid_v.is_active = true
      AND hid_v.parse_status = 'ready'
      AND hid_v.lifecycle_state = 'active'
      AND NOT (${classificationSqlPredicate(sql.raw("hid_v.classification"), clearance)})
  )`;
}

const LIVE_VERSION = sql.raw(
  "v.is_active = true AND v.parse_status = 'ready' AND v.lifecycle_state = 'active'"
);

/**
 * For analytics rows joined to `documents AS d`: is the document live now
 * (not retired, has an active parse-ready version)?
 */
export function documentIsLiveSql(): SQL {
  return sql`(d.lifecycle_state = 'active' AND EXISTS (
    SELECT 1 FROM document_versions AS v
    WHERE v.document_id = d.id AND ${LIVE_VERSION}
  ))`;
}

/**
 * For analytics rows joined to `documents AS d`: may the viewer see the
 * title? Live documents use the active version's classification, the same
 * rule as the reader. Retired documents or ones without an active version
 * show the title only when every version is within clearance.
 */
export function documentTitleVisibleSql(clearance: Classification): SQL {
  const predicate = classificationSqlPredicate(sql.raw("v.classification"), clearance);
  return sql`COALESCE((
    SELECT CASE
      WHEN d.lifecycle_state = 'active' AND bool_or(${LIVE_VERSION})
        THEN bool_or(${LIVE_VERSION} AND ${predicate})
      ELSE bool_and(${predicate})
    END
    FROM document_versions AS v
    WHERE v.document_id = d.id
  ), false)`;
}

/**
 * Citation snapshots as a jsonb array, tolerating NULL (purged rows) and any
 * legacy non-array value.
 */
export function snapshotsArraySql(column: SQL): SQL {
  return sql`CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END`;
}
