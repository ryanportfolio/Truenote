import { eq, sql } from "drizzle-orm";
import { db, withPgAdvisoryLock } from "../db-client.js";
import { getDeadlineConfig } from "../deadlines.js";
import { chunks, documents, documentVersions, type ChunkMetadata } from "@workspace/db/schema";
import { sha256Hex } from "../parsing/hash.js";
import {
  callLandingParse,
  normalizeLandingMarkdown
} from "../parsing/landing-parse.js";
import { docxToMarkdown } from "../parsing/docx.js";
import { chunkMarkdown } from "../parsing/chunker.js";
import { createTiktokenTokenizer } from "../parsing/tokenizer.js";
import { getObjectStorage } from "../storage/object-storage.js";
import { buildContextHeader, prependContextHeader } from "./contextual.js";
import { findCachedParsedMarkdown } from "./dedupe.js";
import { OpenAIEmbedder, type Embedder } from "./embedder.js";
import {
  disabledMalwareScanResult,
  hasBlockingFindings,
  scanForMalware,
  scanTextForSensitiveContent,
  validateFileSignature,
  type SecurityFinding
} from "../security/content-scan.js";
import { getMalwareScanningPolicy } from "../security/malware-policy.js";
import {
  evaluateDocumentApproval,
  shouldAutoActivateDocumentUpload
} from "../security/document-policy.js";

export interface RunIngestionInput {
  documentVersionId: string;
}

export interface RunIngestionDeps {
  embedder?: Embedder;
}

// Document types routed to LandingAI ADE Parse v2. Parse returns markdown with
// any figures/screenshots described inline, so there is no separate image stage.
const PARSE_MIMES = new Set([
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
 *   lifecycle: submitted → scanning → pending_review → active
 *
 *   1. mark `parsing`
 *   2. fetch file from object storage
 *   3. compute / persist SHA-256 if not already set
 *   4. dedupe: if another ready version has the same SHA-256, reuse its
 *      parsed_markdown (no OCR call)
 *   5. parse — LandingAI ADE Parse v2 for PDFs and images (figures described
 *      inline in the returned markdown); mammoth for DOCX (via
 *      lib/parsing/docx.ts); passthrough for text/markdown
 *   6. persist parsed_markdown
 *   7. chunk via the structural chunker (target 500 tokens)
 *   8. embed all chunks (batched 100/req)
 *   9. insert chunks rows with denormalized program_id
 *  10. activate senior-manager and super-user uploads immediately; leave
 *      uploads from other roles inactive in `pending_review`
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
  const claimed = await db.execute(sql`
    UPDATE document_versions
    SET parse_status = 'parsing',
        lifecycle_state = 'scanning',
        scan_status = 'running',
        scan_findings = '[]'::jsonb
    WHERE id = ${versionId}::uuid
      AND parse_status IS DISTINCT FROM 'ready'
      AND lifecycle_state IN ('submitted', 'scanning', 'quarantined', 'failed')
    RETURNING id
  `);
  if (claimed.rows.length === 0) {
    console.log(
      `[ingestion] version ${versionId} is not claimable; ` +
        "treating as soft-success (deleted or already ready)."
    );
    return;
  }

  try {
    interface ControlledVersionRow {
      id: string;
      document_id: string | null;
      source_url: string | null;
      mime_type: string | null;
      file_sha256: string | null;
      original_file_name: string | null;
    }
    const versionResult = await db.execute(sql`
      SELECT id::text, document_id::text, source_url, mime_type, file_sha256,
             original_file_name
      FROM document_versions
      WHERE id = ${versionId}::uuid
      LIMIT 1
    `);
    const version = versionResult.rows[0] as unknown as ControlledVersionRow | undefined;
    if (!version) throw new Error(`Document version not found: ${versionId}`);
    // Hoisted into a const so the non-null narrowing survives into the
    // transaction closure below — TS drops property narrowing inside
    // nested functions.
    const documentId = version.document_id;
    if (!documentId) throw new Error(`Version ${versionId} has no document_id`);
    if (!version.source_url) throw new Error(`Version ${versionId} has no source_url`);

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
    const fileBuffer = await storage.get(version.source_url);

    // 3. SHA-256 (compute if not stored on upload).
    const fileSha256 = version.file_sha256 ?? sha256Hex(fileBuffer);
    if (!version.file_sha256) {
      await db
        .update(documentVersions)
        .set({ fileSha256 })
        .where(eq(documentVersions.id, versionId));
    }

    // File validation + organization-approved malware scanning happen before
    // any third-party parser receives bytes. Scanner absence is a quarantine,
    // never an implicit clean verdict.
    const mimeType = (version.mime_type ?? "application/pdf").toLowerCase();
    const originalFileName = version.original_file_name ?? "document";
    const boundaryFindings = validateFileSignature(fileBuffer, mimeType);
    const malwarePolicy = await getMalwareScanningPolicy();
    const malware = malwarePolicy.enabled
      ? await scanForMalware({
          buffer: fileBuffer,
          sha256: fileSha256,
          mimeType,
          originalFileName
        })
      : disabledMalwareScanResult();
    const preParseFindings: SecurityFinding[] = [
      ...boundaryFindings,
      ...malware.findings
    ];
    if (
      !["clean", "disabled"].includes(malware.status) ||
      hasBlockingFindings(boundaryFindings)
    ) {
      await db.execute(sql`
        UPDATE document_versions
        SET parse_status = 'failed',
            lifecycle_state = 'quarantined',
            scan_status = ${malware.status},
            scan_engine = ${malware.engine},
            scan_id = ${malware.scanId},
            scan_findings = ${JSON.stringify(preParseFindings)}::jsonb,
            scan_completed_at = now(),
            is_active = false
        WHERE id = ${versionId}::uuid
      `);
      console.warn(
        `[ingestion] version ${versionId} quarantined: scanner=${malware.status}, ` +
          `findings=${preParseFindings.length}`
      );
      return;
    }
    await db.execute(sql`
      UPDATE document_versions
      SET scan_status = ${malware.status},
          scan_engine = ${malware.engine},
          scan_id = ${malware.scanId},
          scan_findings = ${JSON.stringify(preParseFindings)}::jsonb,
          scan_completed_at = now(),
          lifecycle_state = 'parsing'
      WHERE id = ${versionId}::uuid
    `);

    // 4. Dedupe + 5. Parse.
    let parsedMarkdown: string | null = null;

    const cached = await findCachedParsedMarkdown(fileSha256, versionId);
    if (cached) {
      parsedMarkdown = PARSE_MIMES.has(mimeType)
        ? normalizeLandingMarkdown(cached.parsedMarkdown)
        : cached.parsedMarkdown;
    } else if (PARSE_MIMES.has(mimeType)) {
      const { documentParse } = getDeadlineConfig();
      const parsed = await callLandingParse(fileBuffer, mimeType, {
        timeoutMs: documentParse.timeoutMs,
        maxRetries: documentParse.maxRetries
      });
      parsedMarkdown = parsed.markdown;
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

    const contentFindings = scanTextForSensitiveContent(parsedMarkdown);
    const allFindings = [...preParseFindings, ...contentFindings];
    if (hasBlockingFindings(contentFindings)) {
      await db.execute(sql`
        UPDATE document_versions
        SET parse_status = 'ready',
            lifecycle_state = 'quarantined',
            scan_findings = ${JSON.stringify(allFindings)}::jsonb,
            is_active = false
        WHERE id = ${versionId}::uuid
      `);
      console.warn(
        `[ingestion] version ${versionId} quarantined before embedding: ` +
          `blocking content findings=${contentFindings.filter((finding) => finding.blocking).length}`
      );
      return;
    }

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

    // 8. Embed all chunks (batched 100/req). Figures/screenshots are already
    //    described inline in the parsed markdown by LandingAI Parse v2, so there
    //    is no separate per-image describe stage — image content rides along as
    //    ordinary text chunks.
    const embedder =
      deps.embedder ??
      new OpenAIEmbedder({
        timeoutMs: getDeadlineConfig().ingestionEmbedding.timeoutMs,
        maxRetries: getDeadlineConfig().ingestionEmbedding.maxRetries
      });
    const embeddings = await embedder.embed(semanticChunks.map((c) => c.content));

    // 9. Insert chunks.
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
    // 9–10. Delete-then-insert chunks and resolve activation, all atomically. The
    // single transaction prevents three known footguns:
    //   (a) a retry doubling the chunks: if a previous run of this job
    //       committed the transaction but the worker died before pg-boss
    //       recorded success, a retry would otherwise insert a second full
    //       set of chunks for the same document_version_id (no unique
    //       constraint on (document_version_id, ordinal) to catch it).
    //       Deleting first makes the whole transaction idempotent — the
    //       second run replaces rather than duplicates.
    await db.transaction(async (tx) => {
      interface AutoApprovalRow {
        document_id: string;
        uploaded_by: string | null;
        uploader_role: string | null;
        uploader_active: boolean | null;
        scan_status: string;
        source_id: string | null;
        source_active: boolean | null;
        source_approved_at: Date | string | null;
      }
      const approvalResult = await tx.execute(sql`
        SELECT
          dv.document_id::text,
          dv.uploaded_by,
          uploader.role::text AS uploader_role,
          uploader.is_active AS uploader_active,
          dv.scan_status,
          dv.source_id::text,
          source.is_active AS source_active,
          source.approved_at AS source_approved_at
        FROM document_versions dv
        JOIN documents d ON d.id = dv.document_id
        LEFT JOIN users uploader ON uploader.id::text = dv.uploaded_by
        LEFT JOIN content_sources source ON source.id = dv.source_id
        WHERE dv.id = ${versionId}::uuid
        FOR UPDATE OF dv, d
      `);
      const approvalRow = approvalResult.rows[0] as unknown as
        | AutoApprovalRow
        | undefined;
      if (!approvalRow) {
        throw new Error(`Document version not found during activation: ${versionId}`);
      }

      await tx.delete(chunks).where(eq(chunks.documentVersionId, versionId));
      await tx.insert(chunks).values(chunkRows);
      await tx.execute(sql`
        UPDATE document_versions
        SET parse_status = 'ready',
            lifecycle_state = 'pending_review',
            scan_findings = ${JSON.stringify(allFindings)}::jsonb,
            is_active = false
        WHERE id = ${versionId}::uuid
      `);

      const uploaderRole = approvalRow.uploader_role;
      const autoActivate =
        approvalRow.uploader_active === true &&
        (uploaderRole === "senior_manager" || uploaderRole === "super_user") &&
        shouldAutoActivateDocumentUpload(uploaderRole);
      if (!autoActivate || !approvalRow.uploaded_by) return;

      const approval = evaluateDocumentApproval({
        lifecycleState: "pending_review",
        parseStatus: "ready",
        scanStatus: approvalRow.scan_status,
        sourceId: approvalRow.source_id,
        sourceActive: approvalRow.source_active,
        sourceApprovedAt: approvalRow.source_approved_at,
        findings: allFindings,
        acknowledgeFindings: true
      });
      if (!approval.allowed) return;

      await tx.execute(sql`
        UPDATE document_versions
        SET is_active = false,
            lifecycle_state = 'retired',
            retired_at = now()
        WHERE document_id = ${approvalRow.document_id}::uuid
          AND id <> ${versionId}::uuid
          AND is_active = true
      `);
      const activated = await tx.execute(sql`
        UPDATE document_versions
        SET approved_by = ${approvalRow.uploaded_by}::uuid,
            approved_at = now(),
            approval_notes = 'Automatically activated for privileged uploader.',
            lifecycle_state = 'active',
            activated_at = now(),
            is_active = true
        WHERE id = ${versionId}::uuid
          AND lifecycle_state = 'pending_review'
        RETURNING id
      `);
      if (activated.rows.length !== 1) {
        throw new Error(`Document activation state changed: ${versionId}`);
      }
      await tx.execute(sql`
        UPDATE documents
        SET current_version_id = ${versionId}::uuid,
            lifecycle_state = 'active',
            retired_at = NULL,
            retired_by = NULL,
            retirement_reason = NULL
        WHERE id = ${approvalRow.document_id}::uuid
      `);
    });
  } catch (err) {
    await db.execute(sql`
      UPDATE document_versions
      SET parse_status = 'failed',
          lifecycle_state = CASE
            WHEN lifecycle_state = 'quarantined' THEN lifecycle_state
            ELSE 'failed'
          END,
          is_active = false
      WHERE id = ${versionId}::uuid
    `);
    throw err;
  }
}
