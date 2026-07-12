import { sql } from "drizzle-orm";
import { db } from "../db-client.js";

export type ErrorSeverity = "warning" | "error" | "fatal";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ErrorLogInput {
  severity?: ErrorSeverity;
  source: string;
  operation: string;
  error: unknown;
  provider?: string | null;
  model?: string | null;
  routeId?: string | null;
  correlationId?: string | null;
  method?: string | null;
  path?: string | null;
  userId?: string | null;
  programId?: string | null;
  queryLogId?: string | null;
  context?: Record<string, unknown>;
}

export interface PreparedErrorLog {
  severity: ErrorSeverity;
  source: string;
  operation: string;
  message: string;
  name: string | null;
  stack: string | null;
  code: string | null;
  status: number | null;
  provider: string | null;
  model: string | null;
  routeId: string | null;
  requestId: string | null;
  correlationId: string | null;
  method: string | null;
  path: string | null;
  userId: string | null;
  programId: string | null;
  queryLogId: string | null;
  details: JsonValue;
}

const MAX_DEPTH = 7;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_CHARS = 32_000;

const SENSITIVE_KEY_RE = /^(authorization|proxy-authorization|cookie|set-cookie|(?:.*[-_])?api[-_]?key|.*password.*|.*secret$|.*token$|database[-_]?url|connection[-_]?string|connectionstring|dsn)$/i;

function redactString(value: string): string {
  const truncated =
    value.length > MAX_STRING_CHARS
      ? `${value.slice(0, MAX_STRING_CHARS)}… [truncated ${value.length - MAX_STRING_CHARS} chars]`
      : value;
  return truncated
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]")
    .replace(
      /((?:postgres(?:ql)?|mysql|redis):\/\/)([^@\s/]+)@/gi,
      "$1[REDACTED]@"
    )
    .replace(
      /([?&](?:api_key|token|secret|password)=)[^&\s]+/gi,
      "$1[REDACTED]"
    );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function serializeValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): JsonValue {
  if (value === null || value === undefined) return value === null ? null : "[undefined]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return redactString(String(value));
  }
  if (depth >= MAX_DEPTH) return "[max depth reached]";
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => serializeValue(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    }
    return items;
  }

  const record = objectValue(value);
  if (!record) return redactString(String(value));
  const output: Record<string, JsonValue> = {};
  const entries = Object.entries(record).slice(0, MAX_OBJECT_KEYS);
  for (const [key, child] of entries) {
    output[key] = SENSITIVE_KEY_RE.test(key)
      ? "[REDACTED]"
      : serializeValue(child, depth + 1, seen);
  }
  const keyCount = Object.keys(record).length;
  if (keyCount > MAX_OBJECT_KEYS) {
    output._truncated = `${keyCount - MAX_OBJECT_KEYS} keys omitted`;
  }
  return output;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? redactString(value) : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function serializeHeaders(value: unknown): JsonValue | null {
  const record = objectValue(value);
  if (!record) return null;
  const entriesFunction = record.entries;
  if (typeof entriesFunction === "function") {
    try {
      return serializeValue(Object.fromEntries(entriesFunction.call(value)));
    } catch {
      // Fall through to plain-object serialization.
    }
  }
  return serializeValue(value);
}

export function prepareErrorLog(input: ErrorLogInput): PreparedErrorLog {
  const record = objectValue(input.error);
  const message =
    input.error instanceof Error
      ? redactString(input.error.message)
      : typeof input.error === "string"
        ? redactString(input.error)
        : redactString(String(input.error));
  const name =
    input.error instanceof Error
      ? redactString(input.error.name)
      : readString(record, "name");
  const stack =
    input.error instanceof Error && input.error.stack
      ? redactString(input.error.stack)
      : readString(record, "stack");
  const requestId =
    readString(record, "request_id") ??
    readString(record, "requestId") ??
    readString(record, "x-request-id");

  const details: Record<string, JsonValue> = {
    error: serializeValue(input.error),
    context: serializeValue(input.context ?? {})
  };
  const headers = serializeHeaders(record?.headers);
  if (headers !== null) details.headers = headers;
  if (record?.error !== undefined) details.providerResponse = serializeValue(record.error);
  if (record?.cause !== undefined) details.cause = serializeValue(record.cause);
  const errorType = readString(record, "type");
  const errorParam = readString(record, "param");
  if (errorType) details.type = errorType;
  if (errorParam) details.param = errorParam;

  return {
    severity: input.severity ?? "error",
    source: redactString(input.source),
    operation: redactString(input.operation),
    message,
    name,
    stack,
    code: readString(record, "code"),
    status: readNumber(record, "status"),
    provider: input.provider ? redactString(input.provider) : null,
    model: input.model ? redactString(input.model) : null,
    routeId: input.routeId ? redactString(input.routeId) : null,
    requestId,
    correlationId: input.correlationId ? redactString(input.correlationId) : null,
    method: input.method ? redactString(input.method) : null,
    path: input.path ? redactString(input.path) : null,
    userId: input.userId ?? null,
    programId: input.programId ?? null,
    queryLogId: input.queryLogId ?? null,
    details
  };
}

export function isMissingErrorLogTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (code === "42P01" || code === "42703") return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return false;
}

/**
 * Best-effort durable diagnostics. Callers should still write their normal
 * console line. Missing DDL or a database outage must never hide or replace
 * the original failure.
 */
export async function recordAppError(input: ErrorLogInput): Promise<boolean> {
  const prepared = prepareErrorLog(input);
  if (process.env.NODE_ENV === "test") return false;
  try {
    const details = JSON.stringify(prepared.details);
    const result = await db.execute(sql`
      INSERT INTO error_log (
        severity, source, operation, message, name, stack, code, status,
        provider, model, route_id, request_id, correlation_id, method, path,
        user_id, program_id, query_log_id, details
      ) VALUES (
        ${prepared.severity}, ${prepared.source}, ${prepared.operation},
        ${prepared.message}, ${prepared.name}, ${prepared.stack}, ${prepared.code},
        ${prepared.status}, ${prepared.provider}, ${prepared.model},
        ${prepared.routeId}, ${prepared.requestId}, ${prepared.correlationId},
        ${prepared.method}, ${prepared.path}, ${prepared.userId},
        ${prepared.programId}::uuid, ${prepared.queryLogId}::uuid, ${details}::jsonb
      )
      RETURNING id
    `);
    return result.rows.length > 0;
  } catch (error) {
    if (!isMissingErrorLogTable(error)) {
      console.warn(
        "[error-log] persistence failed:",
        error instanceof Error ? error.message : error
      );
    }
    return false;
  }
}

/** Capture process-level failures without changing Node's fatal-exit posture. */
export function installProcessErrorLogging(source: string): void {
  let handlingFatal = false;
  process.on("unhandledRejection", (reason) => {
    console.error(`[${source}] unhandled rejection:`, reason);
    void recordAppError({
      severity: "error",
      source,
      operation: "unhandled-rejection",
      error: reason
    });
  });
  process.on("uncaughtException", (error) => {
    console.error(`[${source}] uncaught exception:`, error);
    if (handlingFatal) {
      process.exit(1);
      return;
    }
    handlingFatal = true;
    const timeout = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1_000);
      timer.unref();
    });
    void Promise.race([
      recordAppError({
        severity: "fatal",
        source,
        operation: "uncaught-exception",
        error
      }),
      timeout
    ]).finally(() => process.exit(1));
  });
}
