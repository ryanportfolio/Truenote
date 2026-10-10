/**
 * Install or migrate the pg-boss schema and create every queue the app uses,
 * connected as the migration role (`postgres`).
 *
 * web and worker connect as truenote_app (lib/db/sql/0007_app_runtime_role.sql),
 * which cannot create tables. pg-boss creates tables when it installs or
 * migrates its schema and when it meets a new queue name, so those three cases
 * run here first: a restore from a dump without the `pgboss` schema, a pg-boss
 * version upgrade, and a new queue. Default privileges from 0007 give
 * truenote_app row access to the tables this creates.
 *
 * Run locally through an SSH tunnel to `pgvector`
 * (docs/security/backup-restore-runbook.md, section 4.4, step 5):
 *   DATABASE_URL=<migration-role URL> pnpm --filter @workspace/scripts run pgboss:install
 *
 * Starts no job handlers. Exits non-zero if the connection is not the
 * migration role.
 */
import { sql } from "drizzle-orm";
import { closePool, db } from "../../artifacts/api-server/src/lib/db-client.js";
import { ensureQueue, getBoss, stopBoss } from "../../artifacts/api-server/src/lib/jobs/boss.js";
import {
  INGEST_DOCUMENT_VERSION_QUEUE,
  INGEST_QUEUE_POLICY
} from "../../artifacts/api-server/src/lib/ingestion/queue.js";
import { EVAL_QUEUE_POLICY, RUN_EVALUATION_QUEUE } from "../../artifacts/api-server/src/lib/eval/queue.js";
import {
  EVIDENCE_QUEUE_POLICY,
  EVIDENCE_RUN_QUEUE
} from "../../artifacts/api-server/src/lib/evidence/queue.js";

async function main(): Promise<void> {
  const who = await db.execute(sql`SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user`);
  const role = who.rows[0] as { name?: string; rolsuper?: boolean } | undefined;
  if (!role?.rolsuper) {
    throw new Error(`connected as ${role?.name ?? "unknown"}; run this as the migration role (postgres)`);
  }

  // start() installs the schema when it is missing and migrates an older one.
  const boss = await getBoss();
  await ensureQueue(boss, INGEST_DOCUMENT_VERSION_QUEUE, INGEST_QUEUE_POLICY);
  await ensureQueue(boss, RUN_EVALUATION_QUEUE, EVAL_QUEUE_POLICY);
  await ensureQueue(boss, EVIDENCE_RUN_QUEUE, EVIDENCE_QUEUE_POLICY);
  const version = await boss.schemaVersion();
  const queues = (await boss.getQueues()).map((q) => q.name).sort();
  console.log(`[pgboss-install] schema version ${version}; queues: ${queues.join(", ")}`);
}

try {
  await main();
} catch (error) {
  console.error("[pgboss-install] failed:", error);
  process.exitCode = 1;
} finally {
  await stopBoss();
  await closePool();
}
