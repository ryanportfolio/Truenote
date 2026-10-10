import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db-client.js";
import { safeErrorMessage } from "../observability/error-log.js";
import { withDeadline } from "./alert-email.js";

type SqlExecutor = {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
};

const BEAT_INTERVAL_MS = 30_000;
/** A worker that missed six beats is reported as stale. */
export const WORKER_STALE_AFTER_MS = 180_000;
const READINESS_QUERY_TIMEOUT_MS = 2_000;
const READINESS_CACHE_MS = 5_000;

/**
 * Upsert the worker's row in service_heartbeats (lib/db/sql/0011) every 30
 * seconds. /health/ready on web reads it. A failed beat logs once per
 * distinct message; the readiness check reports the worker as stale if beats
 * stop arriving for any reason.
 */
export function startWorkerHeartbeat(
  executor: SqlExecutor = db as unknown as SqlExecutor
): () => void {
  const instanceId = randomUUID();
  const startedAt = new Date();
  let lastError = "";
  let stopped = false;

  const beat = async (): Promise<void> => {
    if (stopped) return;
    try {
      await executor.execute(sql`
        INSERT INTO service_heartbeats (service, instance_id, started_at, beat_at)
        VALUES ('worker', ${instanceId}, ${startedAt}, now())
        ON CONFLICT (service) DO UPDATE
        SET instance_id = EXCLUDED.instance_id,
            started_at = EXCLUDED.started_at,
            beat_at = EXCLUDED.beat_at
      `);
      lastError = "";
    } catch (error) {
      const message = safeErrorMessage(error);
      if (message !== lastError) {
        console.error("[heartbeat] worker heartbeat failed:", message);
        lastError = message;
      }
    }
  };

  const timer = setInterval(() => void beat(), BEAT_INTERVAL_MS);
  timer.unref();
  void beat();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export interface Readiness {
  ok: boolean;
  database: "ok" | "error";
  worker: "ok" | "stale" | "missing" | "unknown";
}

export async function checkReadiness(
  executor: SqlExecutor = db as unknown as SqlExecutor,
  now: () => number = Date.now
): Promise<Readiness> {
  let beatAt: unknown;
  try {
    const result = await withDeadline(
      executor.execute(sql`
        SELECT beat_at FROM service_heartbeats WHERE service = 'worker'
      `),
      READINESS_QUERY_TIMEOUT_MS,
      "readiness query"
    );
    beatAt = (result.rows[0] as { beat_at?: unknown } | undefined)?.beat_at;
  } catch (error) {
    console.warn("[health] readiness check failed:", safeErrorMessage(error));
    return { ok: false, database: "error", worker: "unknown" };
  }
  if (beatAt === undefined || beatAt === null) {
    return { ok: false, database: "ok", worker: "missing" };
  }
  const beatMs = new Date(beatAt as string | Date).getTime();
  if (!Number.isFinite(beatMs) || now() - beatMs > WORKER_STALE_AFTER_MS) {
    return { ok: false, database: "ok", worker: "stale" };
  }
  return { ok: true, database: "ok", worker: "ok" };
}

let cached: { at: number; value: Promise<Readiness> } | null = null;

/**
 * The route is public, so one result is shared for five seconds. A flood of
 * requests then costs at most one primary-key lookup per five seconds.
 */
export function cachedReadiness(now: () => number = Date.now): Promise<Readiness> {
  const at = now();
  if (cached && at - cached.at < READINESS_CACHE_MS) return cached.value;
  const value = checkReadiness();
  cached = { at, value };
  return value;
}
