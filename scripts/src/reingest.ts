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

  const tokenize = createTiktokenTokenizer();
  const embedder = new OpenAIEmbedder();
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
