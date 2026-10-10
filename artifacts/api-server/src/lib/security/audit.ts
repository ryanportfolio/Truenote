import { sql, type SQL } from "drizzle-orm";
import { db } from "../db-client.js";
import type { CurrentUser } from "../auth/current-user.js";
import { reportAuditWriteFailure } from "../monitoring/alert-email.js";
import { translateSecuritySchemaError } from "./errors.js";

export interface SecurityEventInput {
  action: string;
  outcome: "success" | "denied" | "failure";
  actor?: Pick<CurrentUser, "id" | "email" | "role"> | null;
  programId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  requestId?: string | null;
  sourceIp?: string | null;
  details?: Record<string, unknown>;
}

export interface StoredSecurityEvent {
  id: string;
  occurredAt: string;
  eventHash: string;
  action: string;
  outcome: SecurityEventInput["outcome"];
  actorUserId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  programId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  requestId: string | null;
  sourceIp: string | null;
  details: Record<string, unknown>;
}

type SqlExecutor = {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
};

/**
 * The X-Request-Id that securityAuditMiddleware set on this response, so a
 * route's own event and the middleware's http.security_mutation event share
 * one id.
 */
export function requestIdOf(res: { getHeader(name: string): unknown }): string | null {
  const value = res.getHeader("X-Request-Id");
  return typeof value === "string" ? value : null;
}

function nullableUuid(value: string | null | undefined) {
  return value ? sql`${value}::uuid` : sql`NULL::uuid`;
}

/**
 * Append through the DB-owned function. It serializes the SHA-256 hash chain
 * and the table's trigger refuses UPDATE/DELETE, making accidental mutation
 * evident and preventing application-level edits.
 */
export async function appendSecurityEvent(
  input: SecurityEventInput,
  executor: SqlExecutor = db as unknown as SqlExecutor
): Promise<StoredSecurityEvent> {
  const details = input.details ?? {};
  try {
    const result = await executor.execute(sql`
      SELECT id::text, occurred_at, event_hash
      FROM append_security_event(
        ${input.action},
        ${input.outcome},
        ${nullableUuid(input.actor?.id)},
        ${input.actor?.email ?? null},
        ${input.actor?.role ?? null},
        ${nullableUuid(input.programId)},
        ${input.resourceType ?? null},
        ${input.resourceId ?? null},
        ${input.requestId ?? null},
        ${input.sourceIp ?? null},
        ${JSON.stringify(details)}::jsonb
      )
    `);
    const row = result.rows[0] as
      | { id?: unknown; occurred_at?: unknown; event_hash?: unknown }
      | undefined;
    if (!row) {
      throw new Error("append_security_event returned no receipt");
    }
    if (
      typeof row.id !== "string" ||
      typeof row.event_hash !== "string" ||
      (!(row.occurred_at instanceof Date) &&
        typeof row.occurred_at !== "string")
    ) {
      throw new Error("append_security_event returned an invalid receipt");
    }
    return {
      id: row.id,
      occurredAt:
        row.occurred_at instanceof Date
          ? row.occurred_at.toISOString()
          : row.occurred_at,
      eventHash: row.event_hash,
      action: input.action,
      outcome: input.outcome,
      actorUserId: input.actor?.id ?? null,
      actorEmail: input.actor?.email ?? null,
      actorRole: input.actor?.role ?? null,
      programId: input.programId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      requestId: input.requestId ?? null,
      sourceIp: input.sourceIp ?? null,
      details
    };
  } catch (error) {
    // Logs and emails without touching the database, so a Postgres outage
    // still raises the alert (lib/monitoring/alert-email.ts).
    reportAuditWriteFailure(input.action, input.outcome, error);
    translateSecuritySchemaError(error);
  }
}

export async function recordSecurityEvent(
  input: SecurityEventInput
): Promise<StoredSecurityEvent> {
  // The worker's security monitor prints committed events to the log and
  // checks them against the alert rules (lib/monitoring/security-monitor.ts).
  // Nothing on this request path waits for that.
  return appendSecurityEvent(input);
}

/**
 * Best-effort wrapper for response middleware and denied requests. A failed
 * append was already logged and alerted by appendSecurityEvent.
 */
export function recordSecurityEventBestEffort(input: SecurityEventInput): void {
  void recordSecurityEvent(input).catch(() => undefined);
}
