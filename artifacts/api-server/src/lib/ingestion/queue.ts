import PgBoss from "pg-boss";
import { runIngestion } from "./run.js";

export const INGEST_DOCUMENT_VERSION_QUEUE = "ingest-document-version";

export interface IngestDocumentVersionPayload {
  documentVersionId: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __pgBoss: PgBoss | undefined;
}

async function ensureQueue(boss: PgBoss, name: string): Promise<void> {
  // pg-boss v10 requires queues to be explicitly registered before send() /
  // work(). If you skip this, send() silently returns null and nothing lands
  // in pgboss.job — the famous v9 → v10 footgun. Per-queue options live here
  // (instead of per-send) so retry / expiration are uniform.
  // Job retention rides pg-boss's defaults; `deleteAfterSeconds` used to be
  // passed here but it is a constructor-level maintenance option, not a
  // queue option — createQueue ignored it in every v10.
  // The catch is defensive: createQueue is idempotent at the SQL level, but
  // the JS wrapper has been known to surface unique-constraint errors when
  // two processes race on first start (api-server + worker). Swallowing
  // "already exists" lets both processes safely initialize.
  try {
    await boss.createQueue(name, {
      name, // pg-boss 10.4's Queue options type requires the name repeated here
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 900 // 15 min — OCR + embed + chunker should be well under
    });
  } catch (err) {
    if (!/already exists|duplicate|unique constraint/i.test(String(err))) {
      throw err;
    }
  }
}

async function getBoss(): Promise<PgBoss> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!globalThis.__pgBoss) {
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
    await boss.start();
    await ensureQueue(boss, INGEST_DOCUMENT_VERSION_QUEUE);
    globalThis.__pgBoss = boss;
  }
  return globalThis.__pgBoss;
}

/**
 * Enqueue a document version for ingestion. Returns the pg-boss job id (or
 * null on duplicate / dropped).
 */
export async function enqueueIngestion(documentVersionId: string): Promise<string | null> {
  const boss = await getBoss();
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
  await boss.work<IngestDocumentVersionPayload>(
    INGEST_DOCUMENT_VERSION_QUEUE,
    { batchSize: 1 },
    async (jobs) => {
      const list = Array.isArray(jobs) ? jobs : [jobs];
      for (const job of list) {
        await runIngestion({ documentVersionId: job.data.documentVersionId });
      }
    }
  );
}

/**
 * Graceful stop. The 30s timeout caps how long we wait for in-flight jobs to
 * drain — without it, a hung Mistral OCR call or stalled OpenAI request
 * blocks shutdown forever and the platform has to SIGKILL the process.
 */
export async function stopBoss(): Promise<void> {
  if (globalThis.__pgBoss) {
    await globalThis.__pgBoss.stop({ graceful: true, timeout: 30_000 });
    globalThis.__pgBoss = undefined;
  }
}
