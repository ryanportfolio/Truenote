import { runIngestion } from "./run.js";
import {
  ensureQueue,
  getBoss,
  stopBoss
} from "../jobs/boss.js";
import { recordAppError } from "../observability/error-log.js";

export const INGEST_DOCUMENT_VERSION_QUEUE = "ingest-document-version";

export interface IngestDocumentVersionPayload {
  documentVersionId: string;
}

const INGEST_QUEUE_POLICY = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 900 // 15 min — OCR + embed + chunker should be well under
} as const;

/**
 * Enqueue a document version for ingestion. Returns the pg-boss job id (or
 * null on duplicate / dropped).
 */
export async function enqueueIngestion(documentVersionId: string): Promise<string | null> {
  const boss = await getBoss();
  await ensureQueue(boss, INGEST_DOCUMENT_VERSION_QUEUE, INGEST_QUEUE_POLICY);
  return boss.send(INGEST_DOCUMENT_VERSION_QUEUE, { documentVersionId });
}

/**
 * Start a worker that consumes the queue and runs the ingestion pipeline.
 *
 * Concurrency is intentionally low (batchSize: 1, one fetch loop) because
 * each job calls Mistral OCR + OpenAI embeddings — bottlenecks are upstream
 * rate limits, not our process. Increase only after monitoring. (The old
 * teamSize/teamConcurrency options were v9 API; every v10 ignores them, so
 * dropping them changes nothing at runtime.)
 *
 * batchSize is set explicitly to 1 (rather than relying on pg-boss v10's
 * default) so the value is auditable from the options object alone, and the
 * defensive Array.isArray() wrap below tolerates both calling conventions.
 */
export async function startIngestionWorker(): Promise<void> {
  const boss = await getBoss();
  await ensureQueue(boss, INGEST_DOCUMENT_VERSION_QUEUE, INGEST_QUEUE_POLICY);
  await boss.work<IngestDocumentVersionPayload>(
    INGEST_DOCUMENT_VERSION_QUEUE,
    { batchSize: 1 },
    async (jobs) => {
      const list = Array.isArray(jobs) ? jobs : [jobs];
      for (const job of list) {
        try {
          await runIngestion({ documentVersionId: job.data.documentVersionId });
        } catch (error) {
          console.error(
            `[ingestion-worker] version ${job.data.documentVersionId} failed:`,
            error
          );
          void recordAppError({
            source: "ingestion",
            operation: "document-version-job",
            error,
            context: {
              documentVersionId: job.data.documentVersionId,
              jobId: "id" in job ? job.id : null
            }
          });
          throw error;
        }
      }
    }
  );
}

/**
 * Graceful stop. The 30s timeout caps how long we wait for in-flight jobs to
 * drain — without it, a hung Mistral OCR call or stalled OpenAI request
 * blocks shutdown forever and the platform has to SIGKILL the process.
 */
export { stopBoss };
