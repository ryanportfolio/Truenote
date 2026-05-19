/**
 * Standalone ingestion worker process.
 *
 * Usage on Replit (in a separate process or as a one-shot run):
 *   pnpm --filter @workspace/scripts run worker
 *
 * Reads DATABASE_URL, OPENAI_API_KEY, MISTRAL_API_KEY from process env (Replit
 * Secrets in production). Exits non-zero on fatal errors so the platform can
 * restart it.
 */
import { closePool } from "../../artifacts/api-server/src/lib/db-client.js";
import {
  startIngestionWorker,
  stopBoss
} from "../../artifacts/api-server/src/lib/ingestion/queue.js";

async function main(): Promise<void> {
  console.log("[worker] starting ingestion worker");
  await startIngestionWorker();
  console.log("[worker] ready");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] received ${signal}, draining…`);
    // Stop pg-boss first so no new jobs start; this also caps the wait via
    // the 30s timeout inside stopBoss. Then drain the Drizzle pool.
    await stopBoss();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
