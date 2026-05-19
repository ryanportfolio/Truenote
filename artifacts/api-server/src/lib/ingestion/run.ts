import { and, eq, ne } from "drizzle-orm";
import { db } from "../db-client.js";
import { chunks, documents, documentVersions, type ChunkMetadata } from "@workspace/db/schema";
import { sha256Hex } from "../parsing/hash.js";
import { callMistralOcr } from "../parsing/mistral-ocr.js";
import { docxToMarkdown } from "../parsing/docx.js";
import { chunkMarkdown } from "../parsing/chunker.js";
import { createTiktokenTokenizer } from "../parsing/tokenizer.js";
import { getObjectStorage } from "../storage/object-storage.js";
import { findCachedParsedMarkdown } from "./dedupe.js";
import { OpenAIEmbedder, type Embedder } from "./embedder.js";

export interface RunIngestionInput {
  documentVersionId: string;
}

export interface RunIngestionDeps {
  embedder?: Embedder;
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
  const versionId = input.documentVersionId;

  await db
    .update(documentVersions)
    .set({ parseStatus: "parsing" })
    .where(eq(documentVersions.id, versionId));

  try {
    const versionRows = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId))
      .limit(1);
    const version = versionRows[0];
    if (!version) throw new Error(`Document version not found: ${versionId}`);
    if (!version.documentId) throw new Error(`Version ${versionId} has no document_id`);
    if (!version.sourceUrl) throw new Error(`Version ${versionId} has no source_url`);

    const documentRows = await db
      .select()
      .from(documents)
      .where(eq(documents.id, version.documentId))
      .limit(1);
    const doc = documentRows[0];
    if (!doc?.programId) {
      throw new Error(`Document ${version.documentId} has no program_id`);
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

    const cached = await findCachedParsedMarkdown(fileSha256, versionId);
    if (cached) {
      parsedMarkdown = cached.parsedMarkdown;
    } else if (OCR_MIMES.has(mimeType)) {
      const result = await callMistralOcr(fileBuffer, mimeType);
      parsedMarkdown = result.markdown;
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

    // 7. Chunk.
    const tokenize = createTiktokenTokenizer();
    const semanticChunks = chunkMarkdown(parsedMarkdown, { tokenize });
    if (semanticChunks.length === 0) {
      throw new Error("Chunker produced zero chunks");
    }

    // 8. Image describe — TODO Phase 1.5.
    //    Scan parsedMarkdown for ![](...) image refs and call gpt-4o vision
    //    against the corresponding image_base64 from OCR. Insert each
    //    description as a chunk with metadata.has_image = true. For Phase 1,
    //    embedded images flow through as plain markdown references inside
    //    their chunk and are not separately described.

    // 9. Embed.
    const embedder = deps.embedder ?? new OpenAIEmbedder();
    const embeddings = await embedder.embed(semanticChunks.map((c) => c.content));

    // 10. Insert chunks.
    const chunkRows = semanticChunks.map((c, idx) => {
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
    });
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
            eq(documentVersions.documentId, version.documentId),
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
        .where(eq(documents.id, version.documentId));
    });
  } catch (err) {
    await db
      .update(documentVersions)
      .set({ parseStatus: "failed" })
      .where(eq(documentVersions.id, versionId));
    throw err;
  }
}
