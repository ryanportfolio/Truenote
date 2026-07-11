/**
 * Re-chunk + re-embed ACTIVE document versions from their stored
 * parsed_markdown — no OCR re-run, no version bump, no parse_status change.
 * Needed when chunking or embedding-input logic changes (e.g. contextual
 * headers, 2026-07) and the existing corpus must pick it up.
 *
 * Usage (Replit or any env with DATABASE_URL + OPENAI_API_KEY):
 *   pnpm --filter @workspace/scripts run reingest
 *   pnpm --filter @workspace/scripts run reingest -- --program <uuid>
 *   pnpm --filter @workspace/scripts run reingest -- --dry-run
 *
 * Image-description chunks (metadata.has_image) are PRESERVED: they came
 * from OCR-time vision calls whose source images aren't in parsed_markdown,
 * so they are re-headered + re-embedded as-is rather than regenerated.
 *
 * Each version's delete+insert runs in one transaction, mirroring
 * runIngestion's idempotency reasoning — a crash mid-corpus leaves every
 * version either fully old or fully new, never chunkless.
 */
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { db, closePool } from "../../artifacts/api-server/src/lib/db-client.js";
import {
  chunks,
  documents,
  documentVersions,
  type ChunkMetadata,
  type NewChunk
} from "@workspace/db/schema";
import { chunkMarkdown } from "../../artifacts/api-server/src/lib/parsing/chunker.js";
import { createTiktokenTokenizer } from "../../artifacts/api-server/src/lib/parsing/tokenizer.js";
import { OpenAIEmbedder } from "../../artifacts/api-server/src/lib/ingestion/embedder.js";
import {
  buildContextHeader,
  prependContextHeader,
  stripContextHeader
} from "../../artifacts/api-server/src/lib/ingestion/contextual.js";
import {
  isMissingCitationSnapshotsColumn,
  linkedSourceFromChunk,
  loadCitationSnapshots,
  saveCitationSnapshots,
  type LinkedSource
} from "../../artifacts/api-server/src/lib/citations.js";

interface CliArgs {
  programId?: string;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--program" || a === "-p") {
      args.programId = argv[++i];
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: pnpm --filter @workspace/scripts run reingest [--] [options]

Options:
  --program, -p <uuid>    Re-ingest only one program's documents
  --dry-run               Report what would change; no embeds, no writes
  --help, -h              Show this help`);
}

interface CitationBackfillRow {
  query_log_id: string;
  user_id: string;
  program_id: string;
  expected_count: number;
  citation_index: number;
  chunk_id: string;
  content: string;
  metadata: unknown;
  document_id: string;
  document_title: string;
  document_version_id: string;
  version_number: number;
}

/**
 * Freeze legacy query-log receipts before chunk replacement. Old answers only
 * stored chunk UUIDs; deleting those rows first would erase their source
 * panels. The backfill deliberately runs before any embed/delete work and
 * uses the same guarded snapshot writer as /api/ask.
 */
async function backfillCitationSnapshots(
  dryRun: boolean,
  programId?: string
): Promise<void> {
  const programCondition = programId
    ? sql`AND q.program_id = ${programId}::uuid`
    : sql``;
  const result = await db
    .execute(sql`
      SELECT
        q.id::text AS query_log_id,
        q.user_id::text AS user_id,
        q.program_id::text AS program_id,
        cardinality(q.cited_chunk_ids)::int AS expected_count,
        (cited.ordinality - 1)::int AS citation_index,
        c.id::text AS chunk_id,
        c.content,
        c.metadata,
        d.id::text AS document_id,
        d.title AS document_title,
        v.id::text AS document_version_id,
        v.version_number
      FROM query_log AS q
      CROSS JOIN LATERAL
        unnest(q.cited_chunk_ids) WITH ORDINALITY AS cited(chunk_id, ordinality)
      INNER JOIN chunks AS c
        ON c.id = cited.chunk_id
       AND c.program_id = q.program_id
      INNER JOIN document_versions AS v ON v.id = c.document_version_id
      INNER JOIN documents AS d ON d.id = v.document_id
      WHERE q.user_id IS NOT NULL
        AND q.program_id IS NOT NULL
        ${programCondition}
        AND cardinality(q.cited_chunk_ids) > 0
        AND COALESCE(q.citation_snapshots, '[]'::jsonb) = '[]'::jsonb
      ORDER BY q.id, cited.ordinality
    `)
    .catch((error: unknown) => {
      if (isMissingCitationSnapshotsColumn(error)) {
        throw new Error(
          "query_log.citation_snapshots is missing; apply REPLIT_HANDOFF B7 before reingest"
        );
      }
      throw error;
    });

  interface PendingReceipt {
    userId: string;
    programId: string;
    expectedCount: number;
    sources: Array<LinkedSource | undefined>;
  }
  const pending = new Map<string, PendingReceipt>();
  for (const row of result.rows as unknown as CitationBackfillRow[]) {
    const receipt = pending.get(row.query_log_id) ?? {
      userId: row.user_id,
      programId: row.program_id,
      expectedCount: Number(row.expected_count),
      sources: []
    };
    receipt.sources[Number(row.citation_index)] = linkedSourceFromChunk({
      chunkId: row.chunk_id,
      docTitle: row.document_title,
      content: row.content,
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
      versionNumber: Number(row.version_number),
      metadata: row.metadata,
      citationIndex: Number(row.citation_index)
    });
    pending.set(row.query_log_id, receipt);
  }

  let eligible = 0;
  let saved = 0;
  let incomplete = 0;
  for (const [queryLogId, receipt] of pending) {
    const complete =
      receipt.sources.length === receipt.expectedCount &&
      receipt.sources.every((source) => source !== undefined);
    if (!complete) {
      incomplete++;
      continue;
    }
    eligible++;
    if (!dryRun) {
      const sources = receipt.sources as LinkedSource[];
      const wrote = await saveCitationSnapshots({
        queryLogId,
        userId: receipt.userId,
        programId: receipt.programId,
        sources
      });
      if (wrote) {
        saved++;
      } else {
        // The app may have frozen the same answer after our SELECT. Count that
        // immutable receipt as safe only when its ordered chunk ids match.
        const existing = (
          await loadCitationSnapshots({
            queryLogIds: [queryLogId],
            userId: receipt.userId,
            programId: receipt.programId
          })
        ).get(queryLogId);
        if (
          existing?.length === sources.length &&
          existing.every((source, index) => source.chunk_id === sources[index]?.chunk_id)
        ) {
          saved++;
        }
      }
    }
  }
  console.log(
    dryRun
      ? `[reingest] would freeze ${eligible} legacy citation receipt(s); ${incomplete} incomplete row(s) cannot be recovered`
      : `[reingest] froze ${saved}/${eligible} legacy citation receipt(s); ${incomplete} incomplete row(s) could not be recovered`
  );
  if (incomplete > 0) {
    throw new Error(
      `${incomplete} legacy citation receipt(s) are only partly recoverable; refusing to replace their remaining chunks`
    );
  }
  if (!dryRun && saved !== eligible) {
    throw new Error(
      `Citation receipt backfill saved ${saved}/${eligible}; refusing to replace chunk ids`
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const versionRows = await db
    .select({
      versionId: documentVersions.id,
      parsedMarkdown: documentVersions.parsedMarkdown,
      programId: documents.programId,
      title: documents.title
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(
      and(
        eq(documentVersions.isActive, true),
        eq(documentVersions.parseStatus, "ready"),
        isNotNull(documentVersions.parsedMarkdown)
      )
    );

  const targets = args.programId
    ? versionRows.filter((v) => v.programId === args.programId)
    : versionRows;
  console.log(`[reingest] ${targets.length} active version(s) to process${args.dryRun ? " (dry run)" : ""}`);

  // Must precede every chunk delete. This makes the deployment order
  // DDL -> code/backfill -> reingest mechanically enforced by the script.
  await backfillCitationSnapshots(args.dryRun, args.programId);

  const tokenize = createTiktokenTokenizer();
  const embedder = args.dryRun ? null : new OpenAIEmbedder();
  let processed = 0;
  let skipped = 0;

  for (const v of targets) {
    if (!v.programId || !v.parsedMarkdown) {
      console.warn(`[reingest] skip ${v.versionId} ("${v.title}") — missing program_id or markdown`);
      skipped++;
      continue;
    }

    const raw = chunkMarkdown(v.parsedMarkdown, { tokenize });
    if (raw.length === 0) {
      // Leave the existing chunks in place rather than wiping a version
      // the chunker can no longer handle — flag it for a human instead.
      console.warn(`[reingest] skip ${v.versionId} ("${v.title}") — chunker produced zero chunks`);
      skipped++;
      continue;
    }

    const textChunks = raw.map((c) => {
      const header = buildContextHeader(v.title, c.metadata.heading_path ?? []);
      const metadata: ChunkMetadata = header
        ? { ...c.metadata, context_header: header }
        : c.metadata;
      return {
        ordinal: c.ordinal,
        content: prependContextHeader(header, c.content),
        metadata
      };
    });

    // Preserve OCR-time image-description chunks (regenerating them would
    // need the original images + vision calls). Strip any header from a
    // prior reingest before applying the current title's header.
    const imageRows = await db
      .select({
        content: chunks.content,
        metadata: chunks.metadata
      })
      .from(chunks)
      .where(
        and(
          eq(chunks.documentVersionId, v.versionId),
          sql`${chunks.metadata}->>'has_image' = 'true'`
        )
      )
      .orderBy(asc(chunks.ordinal));
    const imageHeader = buildContextHeader(v.title);
    const imageChunks = imageRows.map((row, idx) => {
      const base = stripContextHeader(row.content, row.metadata?.context_header);
      const metadata: ChunkMetadata = {
        ...(row.metadata ?? {}),
        ...(imageHeader ? { context_header: imageHeader } : {})
      };
      return {
        ordinal: textChunks.length + idx,
        content: prependContextHeader(imageHeader, base),
        metadata
      };
    });

    if (args.dryRun) {
      const sample = textChunks[0]?.metadata.context_header ?? "(no header)";
      console.log(
        `[reingest] would rewrite "${v.title}" — ${textChunks.length} text + ${imageChunks.length} image chunk(s), e.g. ${sample}`
      );
      processed++;
      continue;
    }

    const all = [...textChunks, ...imageChunks];
    if (!embedder) throw new Error("Embedding client unavailable outside dry-run");
    const embeddings = await embedder.embed(all.map((c) => c.content));
    const rows: NewChunk[] = all.map((c, idx) => {
      const embedding = embeddings[idx];
      if (!embedding) throw new Error(`Missing embedding for chunk ${idx} of ${v.versionId}`);
      return {
        documentVersionId: v.versionId,
        programId: v.programId as string,
        ordinal: c.ordinal,
        content: c.content,
        embedding,
        metadata: c.metadata
      };
    });

    await db.transaction(async (tx) => {
      await tx.delete(chunks).where(eq(chunks.documentVersionId, v.versionId));
      await tx.insert(chunks).values(rows);
    });
    console.log(
      `[reingest] rewrote "${v.title}" — ${textChunks.length} text + ${imageChunks.length} image chunk(s)`
    );
    processed++;
  }

  console.log(`[reingest] done: ${processed} processed, ${skipped} skipped`);
  await closePool();
}

main().catch((err) => {
  console.error("[reingest] fatal:", err);
  process.exit(1);
});
