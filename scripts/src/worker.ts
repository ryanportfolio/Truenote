/**
 * Standalone ingestion worker process.
 *
 * Usage on Replit (in a separate process or as a one-shot run):
 *   pnpm --filter @workspace/scripts run worker
 *
 * Reads DATABASE_URL, OPENAI_API_KEY, VISION_AGENT_API_KEY from process env
 * (Replit Secrets in production). Exits non-zero on fatal errors so the platform
 * can restart it.
 */
import { closePool } from "../../artifacts/api-server/src/lib/db-client.js";
import {
  startIngestionWorker,
  stopBoss
} from "../../artifacts/api-server/src/lib/ingestion/queue.js";
import { startEvaluationWorker } from "../../artifacts/api-server/src/lib/eval/queue.js";
import {
  installProcessErrorLogging,
  recordAppError
} from "../../artifacts/api-server/src/lib/observability/error-log.js";

installProcessErrorLogging("worker");

async function closePoolWithDeadline(timeoutMs = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    closePool().then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })
  ]);
  if (timer) clearTimeout(timer);
  if (!closed) {
    // A checked-out advisory-lock client means ingestion is still hung. The
    // imminent process exit destroys that session and releases its lock.
    console.warn(`[worker] database pool did not drain within ${timeoutMs}ms; forcing exit`);
  }
}

async function main(): Promise<void> {
  console.log("[worker] starting background workers");
  // Start sequentially: both modules share one lazily initialized pg-boss
  // client, and each path explicitly registers its own queue before work().
  await startIngestionWorker();
  const stopEvaluationReconciler = await startEvaluationWorker();
  console.log("[worker] ready");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] received ${signal}, draining…`);
    stopEvaluationReconciler();
    // Stop pg-boss first so no new jobs start; this also caps the wait via
    // the 30s timeout inside stopBoss. Then drain the Drizzle pool.
    await stopBoss();
    await closePoolWithDeadline();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  void Promise.race([
    recordAppError({
      severity: "fatal",
      source: "worker",
      operation: "worker-main",
      error: err
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))
  ]).finally(() => process.exit(1));
});
