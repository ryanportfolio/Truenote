import { withPgAdvisoryLock } from "../db-client.js";
import { ensureQueue, getBoss } from "../jobs/boss.js";
import { recordAppError } from "../observability/error-log.js";
import { notifyRun } from "./notify.js";
import { runEvidenceChecks } from "./runner.js";

/**
 * Daily evidence run on pg-boss. The queue is created by
 * scripts/src/pgboss-install.ts as the migration role (a new pg-boss queue
 * creates a table, which truenote_app cannot); the worker only registers the
 * schedule and the handler.
 */

export const EVIDENCE_RUN_QUEUE = "evidence-run";
/** 05:23 UTC daily (proposed cadence). */
export const EVIDENCE_RUN_CRON = "23 5 * * *";

export const EVIDENCE_QUEUE_POLICY = {
  retryLimit: 1,
  retryDelay: 600,
  expireInSeconds: 30 * 60
} as const;

export interface EvidenceRunPayload {
  trigger: "schedule" | "manual";
  checkIds?: string[];
}

export async function enqueueEvidenceRun(payload: EvidenceRunPayload): Promise<string | null> {
  const boss = await getBoss();
  await ensureQueue(boss, EVIDENCE_RUN_QUEUE, EVIDENCE_QUEUE_POLICY);
  return boss.send(EVIDENCE_RUN_QUEUE, payload, { singletonKey: "evidence-run", singletonSeconds: 10 * 60 });
}

async function executeEvidenceRun(payload: EvidenceRunPayload): Promise<void> {
  const ran = await withPgAdvisoryLock("truenote.evidence.run", async () => {
    const { runId, entries } = await runEvidenceChecks(payload.checkIds);
    const counts = entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.result] = (acc[entry.result] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`[evidence] run ${runId} (${payload.trigger}): ${JSON.stringify(counts)}`);
    try {
      await notifyRun(runId, entries);
    } catch (error) {
      // Receipts are already recorded; a failed email must not retry the run.
      console.warn("[evidence] notification failed:", error instanceof Error ? error.message : error);
      void recordAppError({ severity: "warning", source: "evidence", operation: "evidence-notify", error, context: { runId } });
    }
  });
  if (!ran) console.warn("[evidence] another evidence run holds the lock; skipped");
}

/**
 * Never throws: a missing queue (pgboss:install not yet run) or a missing
 * table must not stop the ingestion and evaluation workers in the same
 * process. A harness that did not start writes no receipts, which the public
 * heartbeat and the evidence-watch Action report.
 */
export async function startEvidenceWorker(): Promise<boolean> {
  try {
    await registerEvidenceWorker();
    return true;
  } catch (error) {
    console.error("[evidence] worker not started:", error instanceof Error ? error.message : error);
    void recordAppError({ source: "evidence", operation: "evidence-worker-start", error, context: {} });
    return false;
  }
}

async function registerEvidenceWorker(): Promise<void> {
  const boss = await getBoss();
  await ensureQueue(boss, EVIDENCE_RUN_QUEUE, EVIDENCE_QUEUE_POLICY);
  await boss.schedule(EVIDENCE_RUN_QUEUE, EVIDENCE_RUN_CRON, { trigger: "schedule" } satisfies EvidenceRunPayload, { tz: "UTC" });
  await boss.work<EvidenceRunPayload>(EVIDENCE_RUN_QUEUE, { batchSize: 1 }, async (jobs) => {
    const list = Array.isArray(jobs) ? jobs : [jobs];
    for (const job of list) {
      try {
        await executeEvidenceRun(job.data ?? { trigger: "schedule" });
      } catch (error) {
        console.error("[evidence] run failed:", error instanceof Error ? error.message : error);
        void recordAppError({ source: "evidence", operation: "evidence-run", error, context: { jobId: job.id } });
        throw error;
      }
    }
  });
}
