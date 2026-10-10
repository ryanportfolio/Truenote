import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db-client.js";
import type { CheckOutcome } from "../receipts.js";

/**
 * Production database posture, read as the runtime role (truenote_app) from
 * the worker. Catalog reads only, plus refusal probes that target zero rows
 * inside a transaction that is always rolled back. Owner-side refusals need
 * the migration role and belong to the monthly operator check.
 */

export const RUNTIME_ROLE = "truenote_app";

export const REQUIRED_TRIGGERS = [
  { table: "security_events", name: "security_events_append_only" },
  { table: "security_events", name: "security_events_no_truncate" },
  { table: "evidence_receipts", name: "evidence_receipts_append_only" },
  { table: "evidence_receipts", name: "evidence_receipts_no_truncate" },
  { table: "document_versions", name: "document_versions_audit_insert" },
  { table: "document_versions", name: "document_versions_audit_lifecycle" },
  { table: "content_sources", name: "content_sources_audit_insert" },
  { table: "content_sources", name: "content_sources_audit_update" }
] as const;

export const APPEND_FUNCTIONS = ["append_security_event", "append_evidence_receipt"] as const;

export const REFUSAL_PROBES = [
  "UPDATE security_events SET action = action WHERE false",
  "DELETE FROM security_events WHERE false",
  "TRUNCATE security_events",
  "INSERT INTO security_events (action, outcome, event_hash) SELECT 'probe', 'success', 'probe' WHERE false",
  "UPDATE evidence_receipts SET result = result WHERE false",
  "DELETE FROM evidence_receipts WHERE false",
  "TRUNCATE evidence_receipts",
  "INSERT INTO evidence_receipts (id, recorded_at, recorded_at_text, check_id, check_kind, result, controls, objectives, payload, payload_sha256, receipt_hash) SELECT gen_random_uuid(), now(), '', '', 'github', 'pass', '{}', '{}', '', '', '' WHERE false",
  "DELETE FROM evidence_known_gaps WHERE false",
  "SELECT 1 FROM schema_migrations LIMIT 0"
] as const;

const INSUFFICIENT_PRIVILEGE = "42501";

type Executor = { execute(query: SQL): Promise<{ rows: unknown[] }> };

/** SQLSTATE from a pg error, including one wrapped by drizzle. */
export function sqlState(error: unknown): string | null {
  const direct = (error as { code?: unknown })?.code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
  return typeof cause === "string" ? cause : null;
}

// ---------------------------------------------------------- runtime role

export interface RuntimeRoleObservation {
  currentUser: string;
  role: {
    super: boolean;
    createrole: boolean;
    createdb: boolean;
    replication: boolean;
    bypassrls: boolean;
  } | null;
  ownedObjects: number;
  databaseCreate: boolean;
  databaseTemp: boolean;
  schemaCreate: Record<string, boolean>;
  dangerousTablePrivileges: string[];
  auditTablePrivileges: Record<string, string[]>;
  schemaMigrationsAccess: string[];
}

export function evaluateRuntimeRole(o: RuntimeRoleObservation): CheckOutcome {
  const failures: string[] = [];
  if (o.currentUser !== RUNTIME_ROLE) failures.push(`connected as ${o.currentUser}, not ${RUNTIME_ROLE}`);
  if (!o.role) failures.push(`role ${o.currentUser} not found in pg_roles`);
  else {
    for (const [attribute, value] of Object.entries(o.role)) {
      if (value) failures.push(`role has ${attribute}`);
    }
  }
  if (o.ownedObjects > 0) failures.push(`role owns ${o.ownedObjects} object(s)`);
  if (o.databaseCreate) failures.push("role has CREATE on the database");
  if (o.databaseTemp) failures.push("role has TEMPORARY on the database");
  for (const [schema, create] of Object.entries(o.schemaCreate)) {
    if (create) failures.push(`role has CREATE on schema ${schema}`);
  }
  for (const grant of o.dangerousTablePrivileges) failures.push(`role holds ${grant}`);
  for (const [table, privileges] of Object.entries(o.auditTablePrivileges)) {
    const extra = privileges.filter((p) => p !== "SELECT");
    if (extra.length > 0) failures.push(`role holds ${extra.join(", ")} on ${table}`);
    if (!privileges.includes("SELECT")) failures.push(`role cannot SELECT ${table}`);
  }
  if (o.schemaMigrationsAccess.length > 0) {
    failures.push(`role holds ${o.schemaMigrationsAccess.join(", ")} on schema_migrations`);
  }
  return {
    result: failures.length === 0 ? "pass" : "fail",
    summary:
      failures.length === 0
        ? `${RUNTIME_ROLE} is least-privilege: no role attributes, no DDL, read-only on audit and evidence tables.`
        : `${failures.length} privilege condition(s) not met.`,
    failures,
    outputs: { ...o }
  };
}

export async function observeRuntimeRole(executor: Executor = db as unknown as Executor): Promise<RuntimeRoleObservation> {
  const result = await executor.execute(sql`
    SELECT json_build_object(
      'currentUser', current_user,
      'role', (
        SELECT json_build_object(
          'super', rolsuper, 'createrole', rolcreaterole, 'createdb', rolcreatedb,
          'replication', rolreplication, 'bypassrls', rolbypassrls)
        FROM pg_roles WHERE rolname = current_user),
      'ownedObjects', (
        SELECT
          (SELECT count(*) FROM pg_class c WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) +
          (SELECT count(*) FROM pg_proc p WHERE p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) +
          (SELECT count(*) FROM pg_namespace n WHERE n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) +
          (SELECT count(*) FROM pg_type t WHERE t.typowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND t.typrelid = 0)),
      'databaseCreate', has_database_privilege(current_database(), 'CREATE'),
      'databaseTemp', has_database_privilege(current_database(), 'TEMPORARY'),
      'schemaCreate', (
        SELECT json_object_agg(nspname, has_schema_privilege(nspname, 'CREATE'))
        FROM pg_namespace WHERE nspname IN ('public', 'pgboss')),
      'dangerousTablePrivileges', COALESCE((
        SELECT json_agg(format('%s on %I.%I', privilege, n.nspname, c.relname) ORDER BY n.nspname, c.relname, privilege)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege
        WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'pgboss')
          AND has_table_privilege(c.oid, privilege)), '[]'::json),
      'auditTablePrivileges', (
        SELECT json_object_agg(t, ARRAY(
          SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
          WHERE to_regclass(t) IS NOT NULL AND has_table_privilege(t, p)))
        FROM unnest(ARRAY['security_events', 'evidence_receipts']) AS t),
      'schemaMigrationsAccess', ARRAY(
        SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
        WHERE to_regclass('public.schema_migrations') IS NOT NULL
          AND has_table_privilege('public.schema_migrations', p))
    ) AS observation
  `);
  return (result.rows[0] as { observation: RuntimeRoleObservation }).observation;
}

export async function checkRuntimeRole(): Promise<CheckOutcome> {
  return { ...evaluateRuntimeRole(await observeRuntimeRole()), inputs: { expectedRole: RUNTIME_ROLE } };
}

// --------------------------------------------------------- audit triggers

export interface TriggerObservation {
  table: string;
  name: string;
  enabled: string | null;
}

export interface FunctionObservation {
  name: string;
  exists: boolean;
  securityDefiner: boolean;
  config: string[];
  ownerIsSuperuser: boolean;
  definitionSha256: string | null;
}

export function evaluateAuditTriggers(triggers: TriggerObservation[], functions: FunctionObservation[]): CheckOutcome {
  const failures: string[] = [];
  for (const required of REQUIRED_TRIGGERS) {
    const found = triggers.find((t) => t.table === required.table && t.name === required.name);
    if (!found || found.enabled === null) failures.push(`trigger ${required.name} on ${required.table} is missing`);
    else if (found.enabled === "D") failures.push(`trigger ${required.name} on ${required.table} is disabled`);
  }
  for (const fn of functions) {
    if (!fn.exists) {
      failures.push(`function ${fn.name} is missing`);
      continue;
    }
    if (!fn.securityDefiner) failures.push(`${fn.name} is not SECURITY DEFINER`);
    if (!fn.config.some((setting) => setting.startsWith("search_path="))) failures.push(`${fn.name} does not pin search_path`);
    if (!fn.ownerIsSuperuser) failures.push(`${fn.name} is not owned by the migration role`);
  }
  return {
    result: failures.length === 0 ? "pass" : "fail",
    summary:
      failures.length === 0
        ? `${REQUIRED_TRIGGERS.length} audit triggers enabled; append functions are pinned SECURITY DEFINER.`
        : `${failures.length} audit condition(s) not met.`,
    failures,
    outputs: { triggers, functions }
  };
}

export async function checkAuditTriggers(executor: Executor = db as unknown as Executor): Promise<CheckOutcome> {
  const triggerRows = await executor.execute(sql`
    SELECT c.relname AS "table", t.tgname AS name, t.tgenabled::text AS enabled
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
      AND c.relname IN ('security_events', 'evidence_receipts', 'document_versions', 'content_sources')
    ORDER BY c.relname, t.tgname
  `);
  const functionRows = await executor.execute(sql`
    SELECT f.name,
           p.oid IS NOT NULL AS exists,
           COALESCE(p.prosecdef, false) AS "securityDefiner",
           COALESCE(p.proconfig, ARRAY[]::text[]) AS config,
           COALESCE(r.rolsuper, false) AS "ownerIsSuperuser",
           CASE WHEN p.oid IS NULL THEN NULL
                ELSE encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') END AS "definitionSha256"
    FROM unnest(${sql.raw(`ARRAY[${APPEND_FUNCTIONS.map((f) => `'${f}'`).join(", ")}]`)}) AS f(name)
    LEFT JOIN pg_proc p ON p.proname = f.name
      AND p.pronamespace = 'public'::regnamespace
    LEFT JOIN pg_roles r ON r.oid = p.proowner
    ORDER BY f.name
  `);
  const outcome = evaluateAuditTriggers(
    triggerRows.rows as unknown as TriggerObservation[],
    functionRows.rows as unknown as FunctionObservation[]
  );
  return { ...outcome, inputs: { requiredTriggers: REQUIRED_TRIGGERS, functions: APPEND_FUNCTIONS } };
}

// -------------------------------------------------------- refusal probes

export interface ProbeObservation {
  statement: string;
  sqlState: string | null;
  message: string;
}

export function evaluateRefusals(probes: ProbeObservation[]): CheckOutcome {
  const failures = probes
    .filter((probe) => probe.sqlState !== INSUFFICIENT_PRIVILEGE)
    .map((probe) =>
      probe.sqlState === null
        ? `accepted: ${probe.statement}`
        : `refused with ${probe.sqlState}, expected ${INSUFFICIENT_PRIVILEGE}: ${probe.statement}`
    );
  return {
    result: failures.length === 0 ? "pass" : "fail",
    summary:
      failures.length === 0
        ? `All ${probes.length} probes refused with ${INSUFFICIENT_PRIVILEGE}.`
        : `${failures.length} of ${probes.length} probes not refused as expected.`,
    failures,
    outputs: { probes }
  };
}

class ProbeRollback extends Error {}

export async function observeRefusals(): Promise<ProbeObservation[]> {
  const probes: ProbeObservation[] = [];
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      for (const statement of REFUSAL_PROBES) {
        try {
          // Savepoint per probe: a refusal aborts only its own savepoint.
          await tx.transaction(async (probe) => {
            await probe.execute(sql.raw(statement));
          });
          probes.push({ statement, sqlState: null, message: "accepted" });
        } catch (error) {
          const message = (error as { cause?: Error })?.cause?.message ?? (error as Error).message;
          probes.push({ statement, sqlState: sqlState(error), message: message.slice(0, 200) });
        }
      }
      throw new ProbeRollback();
    });
  } catch (error) {
    if (!(error instanceof ProbeRollback)) throw error;
  }
  return probes;
}

export async function checkAppendOnlyRefusals(): Promise<CheckOutcome> {
  return { ...evaluateRefusals(await observeRefusals()), inputs: { probes: REFUSAL_PROBES, rolledBack: true } };
}
