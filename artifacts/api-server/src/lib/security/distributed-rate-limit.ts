import { sql } from "drizzle-orm";
import { db } from "../db-client.js";
import { translateSecuritySchemaError } from "./errors.js";

export interface DistributedRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  scope: "user" | "program";
}

function positiveIntEnv(key: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function hitFixedWindow(input: {
  scope: "user" | "program";
  subject: string;
  limit: number;
  windowSeconds: number;
}): Promise<DistributedRateLimitResult> {
  try {
    const result = await db.execute(sql`
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
          ${`ask:${input.scope}`},
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
          : Number(row?.["retry_after_seconds"] ?? input.windowSeconds),
      scope: input.scope
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
export async function enforceAskRateLimit(input: {
  userId: string;
  programId: string;
}): Promise<DistributedRateLimitResult> {
  const windowSeconds = positiveIntEnv("ASK_RATE_LIMIT_WINDOW_SECONDS", 60);
  const user = await hitFixedWindow({
    scope: "user",
    subject: input.userId,
    limit: positiveIntEnv("ASK_RATE_LIMIT_PER_USER", 30),
    windowSeconds
  });
  if (!user.allowed) return user;
  return hitFixedWindow({
    scope: "program",
    subject: input.programId,
    limit: positiveIntEnv("ASK_RATE_LIMIT_PER_PROGRAM", 300),
    windowSeconds
  });
}
