import { sql, type SQL } from "drizzle-orm";
import { db } from "../db-client.js";
import { translateSecuritySchemaError } from "./errors.js";

export interface DistributedRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  scope: "user" | "program";
}

export type WorkloadRateLimitOperation =
  | "document_ingestion"
  | "evaluation_run"
  | "bulk_user_import"
  | "credential_administration"
  | "password_change";

export interface WorkloadRateLimitResult extends DistributedRateLimitResult {
  operation: WorkloadRateLimitOperation;
}

export interface RateLimitExecutor {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface FixedWindowResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const WORKLOAD_LIMITS: Record<
  WorkloadRateLimitOperation,
  { envKey: string; fallback: number }
> = {
  // Document upload and rescan share one bucket because both can trigger
  // malware scanning, parsing, embedding, and provider cost.
  document_ingestion: {
    envKey: "DOCUMENT_INGEST_RATE_LIMIT_PER_USER",
    fallback: 60
  },
  // One run can evaluate up to 250 questions through the full RAG pipeline.
  evaluation_run: {
    envKey: "EVAL_RUN_RATE_LIMIT_PER_USER",
    fallback: 10
  },
  // One request can hash and invite up to 100 users.
  bulk_user_import: {
    envKey: "BULK_USER_IMPORT_RATE_LIMIT_PER_USER",
    fallback: 5
  },
  // Individual account creation and password reset both perform Argon2 work.
  credential_administration: {
    envKey: "USER_ADMIN_RATE_LIMIT_PER_USER",
    fallback: 60
  },
  // A signed-in user has no reason to rotate a password repeatedly.
  password_change: {
    envKey: "PASSWORD_CHANGE_RATE_LIMIT_PER_USER",
    fallback: 10
  }
};

function positiveIntEnv(
  key: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  const parsed = Number.parseInt(env[key] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function workloadRateLimitSettings(
  operation: WorkloadRateLimitOperation,
  env: NodeJS.ProcessEnv = process.env
): { limit: number; windowSeconds: number } {
  const configured = WORKLOAD_LIMITS[operation];
  return {
    limit: positiveIntEnv(configured.envKey, configured.fallback, env),
    windowSeconds: positiveIntEnv(
      "WORKLOAD_RATE_LIMIT_WINDOW_SECONDS",
      60 * 60,
      env
    )
  };
}

async function hitFixedWindow(
  input: {
    counterScope: string;
    subject: string;
    limit: number;
    windowSeconds: number;
  },
  executor: RateLimitExecutor
): Promise<FixedWindowResult> {
  try {
    const result = await executor.execute(sql`
      WITH clock AS (
        SELECT
          to_timestamp(
            floor(extract(epoch FROM clock_timestamp()) / ${input.windowSeconds})
            * ${input.windowSeconds}
          ) AS window_start
      ), bumped AS (
        INSERT INTO security_rate_limits (
          scope, subject, window_start, request_count, expires_at
        )
        SELECT
          ${input.counterScope},
          ${input.subject},
          clock.window_start,
          1,
          clock.window_start + (${input.windowSeconds} * interval '1 second')
        FROM clock
        ON CONFLICT (scope, subject, window_start)
        DO UPDATE SET request_count = security_rate_limits.request_count + 1
        WHERE security_rate_limits.request_count < ${input.limit}
        RETURNING request_count
      )
      SELECT
        EXISTS (SELECT 1 FROM bumped) AS allowed,
        greatest(
          1,
          ceil(extract(epoch FROM (
            clock.window_start + (${input.windowSeconds} * interval '1 second')
            - clock_timestamp()
          )))::int
        ) AS retry_after_seconds
      FROM clock
    `);
    const row = result.rows[0];
    return {
      allowed: row?.["allowed"] === true,
      retryAfterSeconds:
        typeof row?.["retry_after_seconds"] === "number"
          ? row["retry_after_seconds"]
          : Number(row?.["retry_after_seconds"] ?? input.windowSeconds)
    };
  } catch (error) {
    translateSecuritySchemaError(error);
  }
}

/**
 * Shared Postgres counters work across every api-server replica. Both limits
 * apply: one user cannot exhaust model spend, and many users cannot stampede
 * one program's provider allocation.
 */
export async function enforceAskRateLimit(
  input: { userId: string; programId: string },
  executor: RateLimitExecutor = db as unknown as RateLimitExecutor
): Promise<DistributedRateLimitResult> {
  const windowSeconds = positiveIntEnv("ASK_RATE_LIMIT_WINDOW_SECONDS", 60);
  const user = await hitFixedWindow(
    {
      counterScope: "ask:user",
      subject: input.userId,
      limit: positiveIntEnv("ASK_RATE_LIMIT_PER_USER", 30),
      windowSeconds
    },
    executor
  );
  if (!user.allowed) return { ...user, scope: "user" };
  const program = await hitFixedWindow(
    {
      counterScope: "ask:program",
      subject: input.programId,
      limit: positiveIntEnv("ASK_RATE_LIMIT_PER_PROGRAM", 300),
      windowSeconds
    },
    executor
  );
  return { ...program, scope: "program" };
}

/**
 * Bound authenticated actions that amplify CPU, storage, queue, or provider
 * cost. Counters are per user—not per IP—so many employees behind one office
 * egress address cannot lock each other out. Operation-specific buckets keep a
 * legitimate document-import burst from consuming evaluation or identity work.
 */
export async function enforceWorkloadRateLimit(
  input: { operation: WorkloadRateLimitOperation; userId: string },
  executor: RateLimitExecutor = db as unknown as RateLimitExecutor
): Promise<WorkloadRateLimitResult> {
  const settings = workloadRateLimitSettings(input.operation);
  const result = await hitFixedWindow(
    {
      counterScope: `workload:${input.operation}:user`,
      subject: input.userId,
      limit: settings.limit,
      windowSeconds: settings.windowSeconds
    },
    executor
  );
  return { ...result, scope: "user", operation: input.operation };
}
