import { and, eq, isNull, ne, or } from "drizzle-orm";
import { db, withPgAdvisoryLock } from "../db-client.js";
import { chunks, documents, documentVersions, type ChunkMetadata } from "@workspace/db/schema";
import { sha256Hex } from "../parsing/hash.js";
import { callMistralOcr, type OcrResult } from "../parsing/mistral-ocr.js";
import { docxToMarkdown } from "../parsing/docx.js";
import { chunkMarkdown } from "../parsing/chunker.js";
import { createTiktokenTokenizer } from "../parsing/tokenizer.js";
import { getObjectStorage } from "../storage/object-storage.js";
import { buildContextHeader, prependContextHeader } from "./contextual.js";
import { findCachedParsedMarkdown } from "./dedupe.js";
import { OpenAIEmbedder, type Embedder } from "./embedder.js";
import {
  OpenAIImageDescriber,
  type ImageDescriber
} from "./image-describer.js";

export interface RunIngestionInput {
  documentVersionId: string;
}

export interface RunIngestionDeps {
  embedder?: Embedder;
  /**
   * Optional override for tests / scripts. The default lazily creates
   * an OpenAIImageDescriber inside the OCR branch — text-only paths
   * (DOCX, markdown, dedupe-hit) never touch this dependency, so
   * scripts that only ingest text files don't need to mock it out.
   */
  imageDescriber?: ImageDescriber;
}

const OCR_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp"
]);

const PASSTHROUGH_TEXT_MIMES = new Set([
  "text/markdown",
  "text/plain",
  "text/x-markdown",
  "application/markdown"
]);

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Ingestion pipeline (one document version):
 *
 *   parse_status: pending → parsing → ready | failed
 *
 *   1. mark `parsing`
 *   2. fetch file from object storage
 *   3. compute / persist SHA-256 if not already set
 *   4. dedupe: if another ready version has the same SHA-256, reuse its
 *      parsed_markdown (no OCR call)
 *   5. parse — Mistral OCR for PDFs and images; mammoth for DOCX (via
 *      lib/parsing/docx.ts); passthrough for text/markdown
 *   6. persist parsed_markdown
 *   7. chunk via the structural chunker (target 500 tokens)
 *   8. image-describe → TODO Phase 1.5 (no-op for now; chunks with embedded
 *      image refs still flow through but are not enriched with descriptions)
 *   9. embed all chunks (batched 100/req)
 *  10. insert chunks rows with denormalized program_id
 *  11. activate version: set is_active=true, deactivate prior active versions
 *      of the same document_id, set documents.current_version_id
 *
 * On any error, parse_status is set to "failed" and the error rethrown.
 */
export async function runIngestion(
  input: RunIngestionInput,
  deps: RunIngestionDeps = {}
): Promise<void> {
  const ran = await withPgAdvisoryLock(
    `document-version-ingestion:${input.documentVersionId}`,
    () => runClaimedIngestion(input, deps)
  );
  if (!ran) {
    // Lock contention is not proof the other worker will commit. In
    // particular, pg-boss can redeliver an expired job while its original
    // handler is still alive. A soft-success here would acknowledge that
    // retry; if the original then failed, no job would remain to recover it.
    // Throw so pg-boss retains retry responsibility. Once the other worker
    // commits, a later delivery acquires the lock and no-ops on `ready`.
    throw new Error(
      `Document version ${input.documentVersionId} is already being processed`
    );
  }
}

async function runClaimedIngestion(
  input: RunIngestionInput,
  deps: RunIngestionDeps
): Promise<void> {
  const versionId = input.documentVersionId;

  // Atomic test-and-set: UPDATE...WHERE...RETURNING is the only DB
  // round-trip that can both (a) prove the row still exists and (b)
  // flip its parseStatus, in one shot. A separate preflight SELECT
  // + UPDATE has a TOCTOU window where the row could be deleted
  // between them — the UPDATE would silently affect zero rows and
  // we'd press on into a SELECT that throws "not found," driving
  // pg-boss to retry the job to exhaustion against a resource the
  // user already discarded. The empty `returning` is the soft-
  // success signal: the version was deleted or is already ready. A session-
  // level advisory lock above serializes duplicate workers while still being
  // released by a crash, so an expired retry can reclaim `parsing`. Ready
  // versions are immutable audit/citation evidence;
  // re-chunking them goes through scripts/reingest.ts, which never overwrites
  // parsed_markdown.
  const claimed = await db
    .update(documentVersions)
    .set({ parseStatus: "parsing" })
    .where(
      and(
        eq(documentVersions.id, versionId),
        or(
          isNull(documentVersions.parseStatus),
          ne(documentVersions.parseStatus, "ready")
        )
      )
    )
    .returning({ id: documentVersions.id });
  if (claimed.length === 0) {
    console.log(
      `[ingestion] version ${versionId} is not claimable; ` +
        "treating as soft-success (deleted or already ready)."
    );
    return;
  }

  try {
    const versionRows = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId))
      .limit(1);
    const version = versionRows[0];
    if (!version) throw new Error(`Document version not found: ${versionId}`);
    // Hoisted into a const so the non-null narrowing survives into the
    // transaction closure below — TS drops property narrowing inside
    // nested functions.
    const documentId = version.documentId;
    if (!documentId) throw new Error(`Version ${versionId} has no document_id`);
    if (!version.sourceUrl) throw new Error(`Version ${versionId} has no source_url`);

    const documentRows = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    const doc = documentRows[0];
    if (!doc?.programId) {
      throw new Error(`Document ${documentId} has no program_id`);
    }
    const programId: string = doc.programId;

    // 2. Fetch raw bytes.
    const storage = getObjectStorage();
    const fileBuffer = await storage.get(version.sourceUrl);

    // 3. SHA-256 (compute if not stored on upload).
    const fileSha256 = version.fileSha256 ?? sha256Hex(fileBuffer);
    if (!version.fileSha256) {
      await db
        .update(documentVersions)
        .set({ fileSha256 })
        .where(eq(documentVersions.id, versionId));
    }

    // 4. Dedupe + 5. Parse.
    const mimeType = (version.mimeType ?? "application/pdf").toLowerCase();
    let parsedMarkdown: string | null = null;
    // Holds the full OCR result (incl. per-page image extracts) for
    // step 8 image-describe. Null when:
    //   - the file took the dedupe path (no fresh OCR call)
    //   - the file took the DOCX / text passthrough path (no images)
    // Image enrichment is therefore only present on fresh OCR
    // ingestions of PDFs / images — same scope as the original
    // OCR call. Dedupe's main job is to skip the OCR cost on
    // re-uploads; re-running image-describe on cached docs would
    // defeat that purpose.
    let ocrResult: OcrResult | null = null;

    const cached = await findCachedParsedMarkdown(fileSha256, versionId);
    if (cached) {
      parsedMarkdown = cached.parsedMarkdown;
    } else if (OCR_MIMES.has(mimeType)) {
      ocrResult = await callMistralOcr(fileBuffer, mimeType, {
        includeImageBase64: true
      });
      parsedMarkdown = ocrResult.markdown;
    } else if (mimeType === DOCX_MIME) {
      parsedMarkdown = await docxToMarkdown(fileBuffer);
    } else if (PASSTHROUGH_TEXT_MIMES.has(mimeType)) {
      parsedMarkdown = fileBuffer.toString("utf-8");
    } else {
      throw new Error(`Unsupported mime type for Phase 1: ${mimeType}`);
    }

    // 6. Persist parsed markdown.
    await db
      .update(documentVersions)
      .set({ parsedMarkdown })
      .where(eq(documentVersions.id, versionId));

    // 7. Chunk, then prepend a contextual header ([Doc Title > Heading >
    //    Subheading]) to every chunk. The header lands in the stored content
    //    — which content_tsv is generated from — AND in the embedding input,
    //    so both retrieval legs see the chunk's provenance. See contextual.ts.
    const tokenize = createTiktokenTokenizer();
    const rawChunks = chunkMarkdown(parsedMarkdown, { tokenize });
    if (rawChunks.length === 0) {
      throw new Error("Chunker produced zero chunks");
    }
    const semanticChunks = rawChunks.map((c) => {
      const header = buildContextHeader(doc.title, c.metadata.heading_path ?? []);
      return {
        ...c,
        content: prependContextHeader(header, c.content),
        metadata: header ? { ...c.metadata, context_header: header } : c.metadata
      };
    });

    // 8. Image describe.
    //
    // For each base64 image returned by Mistral OCR, call gpt-4o
    // vision and emit a separate chunk with metadata.has_image=true.
    // Per-image failures are non-fatal — we lose enrichment for that
    // one image but the rest of the document still ingests cleanly.
    //
    // Only OCR'd documents (PDF + image MIMEs) produce per-image
    // data; the DOCX / text passthrough paths skip this step
    // entirely. Dedupe also skips — see the ocrResult comment above.
    interface ImageDescription {
      content: string;
      metadata: ChunkMetadata;
    }
    const imageDescriptions: ImageDescription[] = [];
    if (ocrResult) {
      const describer = deps.imageDescriber ?? new OpenAIImageDescriber();
      for (const page of ocrResult.pages) {
        for (const image of page.images) {
          if (!image.image_base64) continue;
          try {
            // Mistral returns PNG-encoded extracts; pass the MIME
            // explicitly so a future encoding change surfaces here.
            const description = await describer.describe(
              image.image_base64,
              "image/png"
            );
            const trimmed = description.trim();
            if (trimmed.length === 0) continue;
            // Doc-title header (no heading path — OCR image extracts don't
            // carry section position) so images retrieve by document name.
            const imageHeader = buildContextHeader(doc.title);
            imageDescriptions.push({
              content: prependContextHeader(
                imageHeader,
                `[Image on page ${page.index + 1}]: ${trimmed}`
              ),
              metadata: {
                has_image: true,
                ...(imageHeader ? { context_header: imageHeader } : {}),
                ...(image.id ? { image_url: image.id } : {})
              }
            });
          } catch (err) {
            console.warn(
              `[ingestion] vision describe failed for page ${page.index} image ${image.id ?? "?"}:`,
              err instanceof Error ? err.message : err
            );
          }
        }
      }
    }

    // 9. Embed (text chunks + image-description chunks together so
    //    we get one batched OpenAI call when feasible).
    const embedder = deps.embedder ?? new OpenAIEmbedder();
    const allInputs = [
      ...semanticChunks.map((c) => c.content),
      ...imageDescriptions.map((d) => d.content)
    ];
    const embeddings = await embedder.embed(allInputs);

    // 10. Insert chunks. Image-description chunks land after text
    //     chunks in ordinal order so the storage layout reflects the
    //     "text first, image descriptions appended" mental model.
    const chunkRows = [
      ...semanticChunks.map((c, idx) => {
        const embedding = embeddings[idx];
        if (!embedding) {
          throw new Error(`Missing embedding for chunk ${idx}`);
        }
        const metadata: ChunkMetadata = c.metadata;
        return {
          documentVersionId: versionId,
          programId,
          ordinal: c.ordinal,
          content: c.content,
          embedding,
          metadata
        };
      }),
      ...imageDescriptions.map((d, idx) => {
        const slot = semanticChunks.length + idx;
        const embedding = embeddings[slot];
        if (!embedding) {
          throw new Error(`Missing embedding for image chunk ${idx}`);
        }
        return {
          documentVersionId: versionId,
          programId,
          // Continue numbering after the last text chunk so retrieval
          // sort-by-ordinal returns image descriptions in a stable
          // post-text position.
          ordinal: semanticChunks.length + idx,
          content: d.content,
          embedding,
          metadata: d.metadata
        };
      })
    ];
    // 10–11. Delete-then-insert chunks AND activate, all atomically. The
    // single transaction prevents three known footguns:
    //   (a) a window where the prior active version has been deactivated
    //       but the new one hasn't been activated yet — retrieval finds zero
    //       candidates and spuriously refuses;
    //   (b) chunks committed for a version that never becomes active because
    //       a later step failed — leaving orphan rows that count toward
    //       reranker candidates but can never be selected via the active
    //       filter;
    //   (c) a retry doubling the chunks: if a previous run of this job
    //       committed the transaction but the worker died before pg-boss
    //       recorded success, a retry would otherwise insert a second full
    //       set of chunks for the same document_version_id (no unique
    //       constraint on (document_version_id, ordinal) to catch it).
    //       Deleting first makes the whole transaction idempotent — the
    //       second run replaces rather than duplicates.
    // The deactivation includes `AND is_active = true` so concurrent
    // ingestion jobs on the same document don't redundantly flip rows that
    // already-newer versions just activated.
    await db.transaction(async (tx) => {
      await tx.delete(chunks).where(eq(chunks.documentVersionId, versionId));
      await tx.insert(chunks).values(chunkRows);
      await tx
        .update(documentVersions)
        .set({ isActive: false })
        .where(
          and(
            eq(documentVersions.documentId, documentId),
            ne(documentVersions.id, versionId),
            eq(documentVersions.isActive, true)
          )
        );
      await tx
        .update(documentVersions)
        .set({ parseStatus: "ready", isActive: true })
        .where(eq(documentVersions.id, versionId));
      await tx
        .update(documents)
        .set({ currentVersionId: versionId })
        .where(eq(documents.id, documentId));
    });
  } catch (err) {
    await db
      .update(documentVersions)
      .set({ parseStatus: "failed" })
      .where(eq(documentVersions.id, versionId));
    throw err;
  }
}
