import { Router } from "express";
import multer from "multer";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../lib/db-client.js";
import { documents, documentVersions } from "@workspace/db/schema";
import { getObjectStorage } from "../lib/storage/object-storage.js";
import { sha256Hex } from "../lib/parsing/hash.js";
import { enqueueIngestion } from "../lib/ingestion/queue.js";
import {
  authedUser,
  blockDemoWrites,
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove,
  requireSeniorManagerOrAbove,
  requireSuperUser
} from "../middleware/current-user.js";
import { canAccessProgram, hasAtLeastRole } from "../lib/auth/current-user.js";
import { resolveEffectiveProgramId } from "../lib/auth/effective-program.js";
import { purgeCitationSnapshotsForDocument } from "../lib/citations.js";
import { recordAppError } from "../lib/observability/error-log.js";
import {
  canReadClassification,
  classificationSqlPredicate,
  getUserMaxClassification,
  parseClassification,
  type Classification
} from "../lib/security/classification.js";
import {
  isMissingSecuritySchema,
  SecurityControlsNotReadyError
} from "../lib/security/errors.js";
import {
  appendSecurityEvent
} from "../lib/security/audit.js";
import {
  actionableDocumentFindings,
  canApproveDocumentVersion,
  evaluateDocumentApproval,
  evaluateDocumentPurge
} from "../lib/security/document-policy.js";

export const documentsRouter = Router();

const ACCEPTED_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "text/markdown",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);

/**
 * Browsers disagree on what MIME to send for text formats. Firefox sends
 * `application/octet-stream` for .md because it has no built-in mapping;
 * some Chrome configs do the same. When we get the "I don't know" MIME,
 * fall back to extension sniffing for the text formats we accept. The
 * normalized type is what we both validate against ACCEPTED_MIMES and
 * persist on document_versions.mime_type — keeping a single source of
 * truth so the worker's parsing strategy lookup (run.ts) sees the same
 * canonical value the upload route saw.
 */
function normalizeMimeType(mimetype: string, originalName: string): string {
  const mime = (mimetype ?? "").toLowerCase();
  const name = (originalName ?? "").toLowerCase();
  if (mime && mime !== "application/octet-stream") return mime;
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "text/markdown";
  if (name.endsWith(".txt")) return "text/plain";
  return mime;
}

const MAX_BYTES = 20 * 1024 * 1024; // 20MB
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Multer in-memory storage. The 20MB cap is enforced both by multer and by
// the post-parse check below so an attacker can't sneak past the limits with
// a chunked or content-length-misreported upload.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES }
});

export interface DocumentListItem {
  documentId: string;
  title: string;
  versionId: string | null;
  parseStatus: string | null;
  uploadedAt: string | null;
  lifecycleState: string;
  scanStatus: string;
  classification: Classification;
  isActive: boolean;
  sourceName: string | null;
  sourceOriginUri: string | null;
  sourceOwner: string | null;
  uploadedById: string | null;
  uploadedByName: string | null;
  approvedByName: string | null;
  findings: unknown[];
  canApprove: boolean;
  canReject: boolean;
  canRevoke: boolean;
  canRescan: boolean;
}

export interface ContentSourceItem {
  id: string;
  name: string;
  originType: string;
  baseUri: string | null;
  ownerName: string;
}

const CreateSourceBody = z.object({
  name: z.string().trim().min(1).max(160),
  originType: z.enum(["manual_upload", "sharepoint", "confluence", "s3", "other"]),
  baseUri: z.string().trim().max(2048).nullable().optional(),
  ownerName: z.string().trim().min(1).max(200)
});

/**
 * Auth chain for the entire documents router:
 *   requireAuth          → must be logged in
 *   requireFreshPassword → first-login users must change password first
 *   requireManagerOrAbove → CSRs are read-only on their own program via
 *                           future endpoints; no document admin for CSRs
 *   blockDemoWrites      → demo accounts browse/preview but can't upload
 *                           or delete (shared demo content must survive
 *                           anonymous visitors)
 */
documentsRouter.use(
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove,
  blockDemoWrites
);

documentsRouter.get("/", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const maxClassification = await getUserMaxClassification(user.id);
    // Filter to the effective program. For managers / senior managers
    // this is their own program (DB CHECK guaranteed non-null). For
    // super_user it's whatever they selected via X-Program-Id; if
    // they haven't selected, return an empty list with the sentinel
    // so the UI can prompt without a separate "no program" endpoint.
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.json({ items: [], sources: [], controlsReady: true, noProgramSelected: true });
      return;
    }
    const result = await db.execute(sql`
      SELECT
        d.id::text AS document_id,
        d.title,
        latest.id::text AS version_id,
        latest.parse_status,
        latest.uploaded_at,
        latest.lifecycle_state,
        latest.scan_status,
        latest.classification,
        latest.is_active,
        latest.source_origin_uri,
        latest.source_owner,
        latest.uploaded_by,
        latest.scan_findings,
        source.name AS source_name,
        uploader.name AS uploaded_by_name,
        approver.name AS approved_by_name
      FROM documents d
      LEFT JOIN LATERAL (
        SELECT dv.*
        FROM document_versions dv
        WHERE dv.document_id = d.id
          AND ${classificationSqlPredicate(sql.raw("dv.classification"), maxClassification)}
        ORDER BY dv.version_number DESC, dv.uploaded_at DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN content_sources source ON source.id = latest.source_id
      LEFT JOIN users uploader ON uploader.id::text = latest.uploaded_by
      LEFT JOIN users approver ON approver.id = latest.approved_by
      WHERE d.program_id = ${programId}::uuid
        AND latest.id IS NOT NULL
      ORDER BY d.created_at DESC
    `);
    const reviewer = hasAtLeastRole(user, "senior_manager");
    const items: DocumentListItem[] = result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      const lifecycleState =
        typeof row["lifecycle_state"] === "string"
          ? row["lifecycle_state"]
          : "submitted";
      const uploadedById =
        typeof row["uploaded_by"] === "string" ? row["uploaded_by"] : null;
      const classification = parseClassification(row["classification"]) ?? "internal";
      const findings = actionableDocumentFindings(row["scan_findings"]);
      return {
        documentId: String(row["document_id"]),
        title: String(row["title"] ?? "Untitled"),
        versionId: typeof row["version_id"] === "string" ? row["version_id"] : null,
        parseStatus:
          typeof row["parse_status"] === "string" ? row["parse_status"] : null,
        uploadedAt:
          row["uploaded_at"] instanceof Date
            ? row["uploaded_at"].toISOString()
            : typeof row["uploaded_at"] === "string"
              ? row["uploaded_at"]
              : null,
        lifecycleState,
        scanStatus:
          typeof row["scan_status"] === "string" ? row["scan_status"] : "pending",
        classification,
        isActive: row["is_active"] === true,
        sourceName:
          typeof row["source_name"] === "string" ? row["source_name"] : null,
        sourceOriginUri:
          typeof row["source_origin_uri"] === "string"
            ? row["source_origin_uri"]
            : null,
        sourceOwner:
          typeof row["source_owner"] === "string" ? row["source_owner"] : null,
        uploadedById,
        uploadedByName:
          typeof row["uploaded_by_name"] === "string"
            ? row["uploaded_by_name"]
            : null,
        approvedByName:
          typeof row["approved_by_name"] === "string"
            ? row["approved_by_name"]
            : null,
        findings,
        canApprove: canApproveDocumentVersion(user.role, lifecycleState),
        canReject:
          reviewer && ["pending_review", "quarantined"].includes(lifecycleState),
        canRevoke: reviewer && lifecycleState === "active",
        canRescan: ["quarantined", "failed"].includes(lifecycleState)
      };
    });
    let sourcesResult = await db.execute(sql`
      SELECT id::text, name, origin_type, base_uri, owner_name
      FROM content_sources
      WHERE program_id = ${programId}::uuid
        AND is_active = true
        AND approved_at IS NOT NULL
      ORDER BY name
    `);
    if (
      sourcesResult.rows.length === 0 &&
      (user.role === "super_user" || user.role === "senior_manager")
    ) {
      sourcesResult = await db.execute(sql`
        INSERT INTO content_sources (
          program_id, name, origin_type, owner_name, is_active,
          created_by, approved_by, approved_at, approval_basis, retired_at
        ) VALUES (
          ${programId}::uuid,
          'Manual administrator upload',
          'manual_upload',
          'Program data steward',
          true,
          ${user.id}::uuid,
          ${user.id}::uuid,
          now(),
          'Enabled by an authorized data steward through Truenote',
          NULL
        )
        ON CONFLICT (program_id, (lower(name))) DO UPDATE
        SET origin_type = EXCLUDED.origin_type,
            owner_name = EXCLUDED.owner_name,
            is_active = true,
            approved_by = EXCLUDED.approved_by,
            approved_at = EXCLUDED.approved_at,
            approval_basis = EXCLUDED.approval_basis,
            retired_at = NULL
        RETURNING id::text, name, origin_type, base_uri, owner_name
      `);
    }
    const sources: ContentSourceItem[] = sourcesResult.rows.map((raw) => ({
      id: String(raw["id"]),
      name: String(raw["name"]),
      originType: String(raw["origin_type"]),
      baseUri: typeof raw["base_uri"] === "string" ? raw["base_uri"] : null,
      ownerName: String(raw["owner_name"])
    }));
    res.json({ items, sources, controlsReady: true });
  } catch (err) {
    if (isMissingSecuritySchema(err)) {
      res.json({ items: [], sources: [], controlsReady: false });
      return;
    }
    next(err);
  }
});

documentsRouter.post(
  "/sources",
  requireSeniorManagerOrAbove,
  async (req, res, next) => {
    try {
      const user = authedUser(req);
      const programId = await resolveEffectiveProgramId(user, req);
      if (programId === null) {
        res.status(400).json({ error: "No program selected." });
        return;
      }
      const parsed = CreateSourceBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid source definition." });
        return;
      }
      const created = await db.execute(sql`
        INSERT INTO content_sources (
          program_id, name, origin_type, base_uri, owner_name,
          created_by, approved_by, approved_at, approval_basis
        ) VALUES (
          ${programId}::uuid,
          ${parsed.data.name},
          ${parsed.data.originType},
          ${parsed.data.baseUri ?? null},
          ${parsed.data.ownerName},
          ${user.id}::uuid,
          ${user.id}::uuid,
          now(),
          'Created by an authorized data steward through Truenote'
        )
        RETURNING id::text, name, origin_type, base_uri, owner_name
      `);
      res.status(201).json({ item: created.rows[0] });
    } catch (err) {
      if (isMissingSecuritySchema(err)) {
        next(new SecurityControlsNotReadyError());
        return;
      }
      next(err);
    }
  }
);

documentsRouter.post(
  "/upload",
  upload.single("file"),
  async (req, res, next) => {
    try {
      const user = authedUser(req);
      // Resolve target program from the actor's effective program: own
      // program for manager/senior_manager (DB CHECK enforces non-null);
      // X-Program-Id header for super_user. Refuse cleanly when a
      // super_user hasn't selected — uploads are program-scoped and
      // there's no "all programs" fallback that makes sense.
      const programId = await resolveEffectiveProgramId(user, req);
      if (programId === null) {
        res.status(400).json({
          ok: false,
          error:
            "No program selected. Choose a program from the picker in the header to upload a document."
        });
        return;
      }
      if (!canAccessProgram(user, programId)) {
        res.status(403).json({ ok: false, error: "Forbidden" });
        return;
      }
      const file = req.file;
      const titleRaw = typeof req.body.title === "string" ? req.body.title : "";
      const title = titleRaw.trim();
      const sourceId =
        typeof req.body.sourceId === "string" ? req.body.sourceId.trim() : "";
      const sourceOriginUri =
        typeof req.body.sourceOriginUri === "string"
          ? req.body.sourceOriginUri.trim()
          : "";
      const classification = parseClassification(req.body.classification);

      if (!file) {
        res.status(400).json({ ok: false, error: "Missing file" });
        return;
      }
      if (title.length === 0) {
        res.status(400).json({ ok: false, error: "Missing title" });
        return;
      }
      if (!UUID_RE.test(sourceId)) {
        res.status(400).json({ ok: false, error: "Choose an approved content source." });
        return;
      }
      if (sourceOriginUri.length > 2048) {
        res.status(400).json({
          ok: false,
          error: "Original source location must be 2,048 characters or fewer."
        });
        return;
      }
      if (!classification) {
        res.status(400).json({ ok: false, error: "Choose a data classification." });
        return;
      }
      const maxClassification = await getUserMaxClassification(user.id);
      if (!canReadClassification(maxClassification, classification)) {
        res.status(403).json({
          ok: false,
          error: "You cannot upload content above your approved data clearance."
        });
        return;
      }
      const sourceResult = await db.execute(sql`
        SELECT id::text, owner_name
        FROM content_sources
        WHERE id = ${sourceId}::uuid
          AND program_id = ${programId}::uuid
          AND is_active = true
          AND approved_at IS NOT NULL
        LIMIT 1
      `);
      const source = sourceResult.rows[0];
      if (!source) {
        res.status(400).json({ ok: false, error: "Content source is not approved." });
        return;
      }
      const mimeType = normalizeMimeType(file.mimetype, file.originalname);
      if (!ACCEPTED_MIMES.has(mimeType)) {
        res.status(400).json({
          ok: false,
          error:
            `Unsupported file type: ${file.mimetype || "unknown"}` +
            ` (filename: ${file.originalname || "unknown"}).` +
            ` Supported: PDF, DOCX, Markdown (.md/.markdown), plain text (.txt),` +
            ` PNG/JPEG/WebP images.`
        });
        return;
      }
      if (file.size > MAX_BYTES) {
        res.status(413).json({
          ok: false,
          error: `File too large (max ${MAX_BYTES / (1024 * 1024)}MB)`
        });
        return;
      }

      const bytes = file.buffer;
      const sha = sha256Hex(bytes);
      const storage = getObjectStorage();
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const key = `uploads/${sha}-${safeName}`;
      // Persist the normalized MIME both in object storage metadata and on
      // document_versions.mime_type so run.ts's parser-selection map sees a
      // canonical value (not "application/octet-stream" for a markdown file).
      await storage.put(key, bytes, { contentType: mimeType });

      // Re-upload semantics (.claude/reference/ingestion.md):
      // "Re-uploading a document creates a NEW version. Do not overwrite."
      // Look up an existing document with the same (program_id, title); if one
      // exists, this upload becomes its next version. Otherwise create a new
      // documents row.
      const existing = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.programId, programId), eq(documents.title, title)))
        .limit(1);

      let docId: string;
      let createdNewDoc = false;
      let versionNumber: number;

      if (existing[0]) {
        docId = existing[0].id;
        const maxRows = await db
          .select({ versionNumber: documentVersions.versionNumber })
          .from(documentVersions)
          .where(eq(documentVersions.documentId, docId))
          .orderBy(desc(documentVersions.versionNumber))
          .limit(1);
        versionNumber = (maxRows[0]?.versionNumber ?? 0) + 1;
      } else {
        const insertedDoc = await db
          .insert(documents)
          .values({ programId, title })
          .returning({ id: documents.id });
        const doc = insertedDoc[0];
        if (!doc) {
          res.status(500).json({ ok: false, error: "Failed to create document" });
          return;
        }
        docId = doc.id;
        createdNewDoc = true;
        versionNumber = 1;
      }

      const insertedVersion = await db.execute(sql`
        INSERT INTO document_versions (
          document_id, version_number, source_url, mime_type, file_sha256,
          parse_status, uploaded_by, is_active, lifecycle_state,
          classification, source_id, source_origin_uri, source_owner,
          original_file_name, scan_status
        ) VALUES (
          ${docId}::uuid,
          ${versionNumber},
          ${key},
          ${mimeType},
          ${sha},
          'pending',
          ${user.id},
          false,
          'submitted',
          ${classification},
          ${sourceId}::uuid,
          ${sourceOriginUri || null},
          ${String(source["owner_name"])},
          ${file.originalname.slice(0, 255)},
          'pending'
        )
        RETURNING id::text
      `);
      const versionId = insertedVersion.rows[0]?.["id"];
      const version = typeof versionId === "string" ? { id: versionId } : null;
      if (!version) {
        res.status(500).json({ ok: false, error: "Failed to create document version" });
        return;
      }

      try {
        await enqueueIngestion(version.id);
      } catch (err) {
        // Rollback only what THIS upload created. If we created the documents
        // row, delete it (document_versions cascades via FK). Otherwise the doc
        // pre-existed (and may have other active versions); just delete the new
        // version row.
        if (createdNewDoc) {
          await db.delete(documents).where(eq(documents.id, docId));
        } else {
          await db.delete(documentVersions).where(eq(documentVersions.id, version.id));
        }
        res.status(500).json({
          ok: false,
          error:
            err instanceof Error
              ? `Failed to enqueue ingestion: ${err.message}`
              : "Failed to enqueue ingestion"
        });
        return;
      }

      res.json({ ok: true, documentVersionId: version.id });
    } catch (err) {
      if (isMissingSecuritySchema(err)) {
        next(new SecurityControlsNotReadyError());
        return;
      }
      next(err);
    }
  }
);

documentsRouter.get("/:versionId/preview", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const maxClassification = await getUserMaxClassification(user.id);
    const versionId = req.params.versionId;
    if (!UUID_RE.test(versionId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const result = await db.execute(sql`
      SELECT
        dv.parsed_markdown,
        dv.parse_status,
        dv.lifecycle_state,
        dv.scan_status,
        dv.scan_findings,
        dv.classification,
        dv.source_origin_uri,
        dv.source_owner,
        dv.uploaded_by,
        dv.is_active,
        d.program_id::text,
        d.title,
        source.name AS source_name,
        uploader.name AS uploaded_by_name,
        approver.name AS approved_by_name,
        dv.approval_notes
      FROM document_versions dv
      JOIN documents d ON d.id = dv.document_id
      LEFT JOIN content_sources source ON source.id = dv.source_id
      LEFT JOIN users uploader ON uploader.id::text = dv.uploaded_by
      LEFT JOIN users approver ON approver.id = dv.approved_by
      WHERE dv.id = ${versionId}::uuid
        AND ${classificationSqlPredicate(sql.raw("dv.classification"), maxClassification)}
      LIMIT 1
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // The leftJoin can in principle return a row with a null programId
    // (orphaned version with no parent document). canAccessProgram
    // returns true for super_user on a null programId — which would
    // expose unscoped content. Refuse explicitly when the document
    // row didn't join, regardless of role.
    const rowProgramId = row["program_id"];
    if (typeof rowProgramId !== "string") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Server-side program scope check via canAccessProgram (single source
    // of truth for "can this user touch resources in program X"). Super
    // users see across programs; everyone else is bound to their own.
    if (!canAccessProgram(user, rowProgramId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({
      markdown:
        typeof row["parsed_markdown"] === "string" ? row["parsed_markdown"] : null,
      parseStatus:
        typeof row["parse_status"] === "string" ? row["parse_status"] : null,
      title: typeof row["title"] === "string" ? row["title"] : null,
      lifecycleState: row["lifecycle_state"],
      scanStatus: row["scan_status"],
      findings: actionableDocumentFindings(row["scan_findings"]),
      classification: row["classification"],
      sourceName: row["source_name"],
      sourceOriginUri: row["source_origin_uri"],
      sourceOwner: row["source_owner"],
      uploadedByName: row["uploaded_by_name"],
      approvedByName: row["approved_by_name"],
      approvalNotes: row["approval_notes"],
      isActive: row["is_active"] === true,
      canApprove: canApproveDocumentVersion(
        user.role,
        String(row["lifecycle_state"]),
      ),
      canReject:
        hasAtLeastRole(user, "senior_manager") &&
        ["pending_review", "quarantined"].includes(String(row["lifecycle_state"])),
      canRevoke:
        hasAtLeastRole(user, "senior_manager") && row["lifecycle_state"] === "active",
      canRescan: ["quarantined", "failed"].includes(String(row["lifecycle_state"]))
    });
  } catch (err) {
    if (isMissingSecuritySchema(err)) {
      next(new SecurityControlsNotReadyError());
      return;
    }
    next(err);
  }
});

const ReviewBody = z.object({
  notes: z.string().trim().max(2000).optional().default(""),
  acknowledgeFindings: z.boolean().optional().default(false)
});

const ReasonBody = z.object({
  reason: z.string().trim().min(3).max(2000)
});

class DocumentControlError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "DocumentControlError";
  }
}

interface ReviewRow {
  version_id: string;
  document_id: string;
  lifecycle_state: string;
  parse_status: string;
  scan_status: string;
  scan_findings: unknown;
  source_id: string | null;
  source_active: boolean | null;
  source_approved_at: Date | string | null;
}

async function effectiveDocumentProgram(
  req: import("express").Request,
  res: import("express").Response
): Promise<string | null> {
  const programId = await resolveEffectiveProgramId(authedUser(req), req);
  if (programId === null) {
    res.status(400).json({ error: "No program selected." });
    return null;
  }
  return programId;
}

documentsRouter.post(
  "/:versionId/approve",
  requireSeniorManagerOrAbove,
  async (req, res, next) => {
    try {
      const user = authedUser(req);
      const maxClassification = await getUserMaxClassification(user.id);
      const versionId = req.params.versionId;
      if (!versionId || !UUID_RE.test(versionId)) {
        throw new DocumentControlError(404, "Not found");
      }
      const parsed = ReviewBody.safeParse(req.body);
      if (!parsed.success) throw new DocumentControlError(400, "Invalid review decision.");
      const programId = await effectiveDocumentProgram(req, res);
      if (programId === null) return;

      await db.transaction(async (tx) => {
        const locked = await tx.execute(sql`
          SELECT
            dv.id::text AS version_id,
            d.id::text AS document_id,
            dv.lifecycle_state,
            dv.parse_status,
            dv.scan_status,
            dv.scan_findings,
            dv.source_id::text,
            source.is_active AS source_active,
            source.approved_at AS source_approved_at
          FROM document_versions dv
          JOIN documents d ON d.id = dv.document_id
          LEFT JOIN content_sources source ON source.id = dv.source_id
          WHERE dv.id = ${versionId}::uuid
            AND d.program_id = ${programId}::uuid
            AND ${classificationSqlPredicate(sql.raw("dv.classification"), maxClassification)}
          FOR UPDATE OF dv, d
        `);
        const row = locked.rows[0] as unknown as ReviewRow | undefined;
        if (!row) throw new DocumentControlError(404, "Not found");
        const approval = evaluateDocumentApproval({
          lifecycleState: row.lifecycle_state,
          parseStatus: row.parse_status,
          scanStatus: row.scan_status,
          sourceId: row.source_id,
          sourceActive: row.source_active,
          sourceApprovedAt: row.source_approved_at,
          findings: row.scan_findings,
          acknowledgeFindings: parsed.data.acknowledgeFindings
        });
        if (!approval.allowed) {
          throw new DocumentControlError(approval.status, approval.error);
        }

        await tx.execute(sql`
          UPDATE document_versions
          SET is_active = false,
              lifecycle_state = 'retired',
              retired_at = now()
          WHERE document_id = ${row.document_id}::uuid
            AND id <> ${versionId}::uuid
            AND is_active = true
        `);
        const activated = await tx.execute(sql`
          UPDATE document_versions
          SET approved_by = ${user.id}::uuid,
              approved_at = now(),
              approval_notes = ${parsed.data.notes || null},
              lifecycle_state = 'active',
              activated_at = now(),
              is_active = true
          WHERE id = ${versionId}::uuid
            AND lifecycle_state = 'pending_review'
          RETURNING id
        `);
        if (activated.rows.length !== 1) {
          throw new DocumentControlError(409, "Document review state changed. Refresh and try again.");
        }
        await tx.execute(sql`
          UPDATE documents
          SET current_version_id = ${versionId}::uuid,
              lifecycle_state = 'active',
              retired_at = NULL,
              retired_by = NULL,
              retirement_reason = NULL
          WHERE id = ${row.document_id}::uuid
        `);
      });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof DocumentControlError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (isMissingSecuritySchema(err)) {
        next(new SecurityControlsNotReadyError());
        return;
      }
      next(err);
    }
  }
);

documentsRouter.post(
  "/:versionId/reject",
  requireSeniorManagerOrAbove,
  async (req, res, next) => {
    try {
      const user = authedUser(req);
      const maxClassification = await getUserMaxClassification(user.id);
      const versionId = req.params.versionId;
      if (!versionId || !UUID_RE.test(versionId)) {
        throw new DocumentControlError(404, "Not found");
      }
      const parsed = ReasonBody.safeParse(req.body);
      if (!parsed.success) throw new DocumentControlError(400, "A rejection reason is required.");
      const programId = await effectiveDocumentProgram(req, res);
      if (programId === null) return;
      const result = await db.execute(sql`
        UPDATE document_versions dv
        SET lifecycle_state = 'rejected',
            rejected_by = ${user.id}::uuid,
            rejected_at = now(),
            rejection_reason = ${parsed.data.reason},
            is_active = false
        FROM documents d
        WHERE dv.id = ${versionId}::uuid
          AND d.id = dv.document_id
          AND d.program_id = ${programId}::uuid
          AND ${classificationSqlPredicate(sql.raw("dv.classification"), maxClassification)}
          AND dv.lifecycle_state IN ('pending_review', 'quarantined')
        RETURNING dv.id
      `);
      if (result.rows.length === 0) {
        throw new DocumentControlError(409, "Document is not rejectable in its current state.");
      }
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof DocumentControlError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (isMissingSecuritySchema(err)) {
        next(new SecurityControlsNotReadyError());
        return;
      }
      next(err);
    }
  }
);

documentsRouter.post("/:versionId/rescan", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const maxClassification = await getUserMaxClassification(user.id);
    const versionId = req.params.versionId;
    if (!UUID_RE.test(versionId)) throw new DocumentControlError(404, "Not found");
    const programId = await effectiveDocumentProgram(req, res);
    if (programId === null) return;
    const result = await db.execute(sql`
      UPDATE document_versions dv
      SET lifecycle_state = 'submitted',
          parse_status = 'pending',
          scan_status = 'pending',
          scan_findings = '[]'::jsonb,
          scan_engine = NULL,
          scan_id = NULL,
          scan_completed_at = NULL,
          is_active = false
      FROM documents d
      WHERE dv.id = ${versionId}::uuid
        AND d.id = dv.document_id
        AND d.program_id = ${programId}::uuid
        AND ${classificationSqlPredicate(sql.raw("dv.classification"), maxClassification)}
        AND dv.lifecycle_state IN ('quarantined', 'failed')
      RETURNING dv.id::text
    `);
    if (result.rows.length === 0) {
      throw new DocumentControlError(409, "Document is not eligible for another scan.");
    }
    try {
      await enqueueIngestion(versionId);
    } catch (error) {
      await db.execute(sql`
        UPDATE document_versions
        SET lifecycle_state = 'failed', parse_status = 'failed'
        WHERE id = ${versionId}::uuid
      `);
      throw error;
    }
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DocumentControlError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (isMissingSecuritySchema(err)) {
      next(new SecurityControlsNotReadyError());
      return;
    }
    next(err);
  }
});

documentsRouter.post(
  "/:versionId/revoke",
  requireSeniorManagerOrAbove,
  async (req, res, next) => {
    try {
      const user = authedUser(req);
      const maxClassification = await getUserMaxClassification(user.id);
      const versionId = req.params.versionId;
      if (!versionId || !UUID_RE.test(versionId)) {
        throw new DocumentControlError(404, "Not found");
      }
      const parsed = ReasonBody.safeParse(req.body);
      if (!parsed.success) throw new DocumentControlError(400, "A revocation reason is required.");
      const programId = await effectiveDocumentProgram(req, res);
      if (programId === null) return;
      const result = await db.transaction(async (tx) => {
        const revoked = await tx.execute(sql`
          UPDATE document_versions dv
          SET lifecycle_state = 'revoked',
              revoked_by = ${user.id}::uuid,
              revoked_at = now(),
              revocation_reason = ${parsed.data.reason},
              is_active = false
          FROM documents d
          WHERE dv.id = ${versionId}::uuid
            AND d.id = dv.document_id
            AND d.program_id = ${programId}::uuid
            AND ${classificationSqlPredicate(sql.raw("dv.classification"), maxClassification)}
            AND dv.lifecycle_state = 'active'
          RETURNING d.id::text AS document_id
        `);
        const documentId = revoked.rows[0]?.["document_id"];
        if (typeof documentId !== "string") {
          throw new DocumentControlError(409, "Document version is not active.");
        }
        await tx.execute(sql`
          UPDATE documents
          SET current_version_id = NULL
          WHERE id = ${documentId}::uuid
            AND current_version_id = ${versionId}::uuid
        `);
        return documentId;
      });
      res.json({ ok: true });
      void purgeCitationSnapshotsForDocument({ programId, documentId: result }).catch(
        (error: unknown) => {
          console.warn(
            "[documents] revoked citation purge failed:",
            error instanceof Error ? error.message : error
          );
        }
      );
    } catch (err) {
      if (err instanceof DocumentControlError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (isMissingSecuritySchema(err)) {
        next(new SecurityControlsNotReadyError());
        return;
      }
      next(err);
    }
  }
);

/** Normal removal is reversible retirement. Evidence and source bytes remain. */
documentsRouter.delete("/:id", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const maxClassification = await getUserMaxClassification(user.id);
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ ok: false, error: "Invalid document id" });
      return;
    }
    const parsed = ReasonBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "A retirement reason is required." });
      return;
    }
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.status(400).json({
        ok: false,
        error: "No program selected."
      });
      return;
    }

    const retired = await db.transaction(async (tx) => {
      const documentResult = await tx.execute(sql`
        UPDATE documents
        SET lifecycle_state = 'retired',
            retired_at = now(),
            retired_by = ${user.id}::uuid,
            retirement_reason = ${parsed.data.reason},
            current_version_id = NULL
        WHERE id = ${id}::uuid
          AND program_id = ${programId}::uuid
          AND lifecycle_state <> 'retired'
          AND NOT EXISTS (
            SELECT 1
            FROM document_versions clearance_dv
            WHERE clearance_dv.document_id = documents.id
              AND NOT (${classificationSqlPredicate(
                sql.raw("clearance_dv.classification"),
                maxClassification
              )})
          )
        RETURNING id
      `);
      if (documentResult.rows.length === 0) return false;
      await tx.execute(sql`
        UPDATE document_versions
        SET lifecycle_state = CASE
              WHEN lifecycle_state IN ('revoked', 'rejected') THEN lifecycle_state
              ELSE 'retired'
            END,
            retired_at = COALESCE(retired_at, now()),
            is_active = false
        WHERE document_id = ${id}::uuid
      `);
      return true;
    });
    if (!retired) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    if (isMissingSecuritySchema(err)) {
      next(new SecurityControlsNotReadyError());
      return;
    }
    next(err);
  }
});

const PurgeBody = z.object({
  reason: z.string().trim().min(10).max(2000),
  confirmTitle: z.string().trim().min(1).max(120),
  allowRetentionOverride: z.boolean().optional().default(false)
});

/**
 * Irreversible purge is super-user-only, title-confirmed, and retention-gated.
 * Normal admins only retire. A retained security event is committed in the
 * same transaction before the document/version/chunk cascade executes.
 */
documentsRouter.post(
  "/:id/purge",
  requireSuperUser,
  async (req, res, next) => {
    try {
      const user = authedUser(req);
      const maxClassification = await getUserMaxClassification(user.id);
      const id = req.params.id;
      if (!id || !UUID_RE.test(id)) {
        throw new DocumentControlError(404, "Not found");
      }
      const parsed = PurgeBody.safeParse(req.body);
      if (!parsed.success) throw new DocumentControlError(400, "Invalid purge confirmation.");
      const programId = await effectiveDocumentProgram(req, res);
      if (programId === null) return;
      const overrideEnabled =
        ["1", "true", "yes"].includes(
          process.env.ALLOW_RETENTION_OVERRIDE?.trim().toLowerCase() ?? ""
        ) && parsed.data.allowRetentionOverride;
      const purgeReceipt = await db.transaction(async (tx) => {
        const locked = await tx.execute(sql`
          SELECT d.title, d.lifecycle_state
          FROM documents d
          WHERE d.id = ${id}::uuid
            AND d.program_id = ${programId}::uuid
            AND NOT EXISTS (
              SELECT 1
              FROM document_versions clearance_dv
              WHERE clearance_dv.document_id = d.id
                AND NOT (${classificationSqlPredicate(
                  sql.raw("clearance_dv.classification"),
                  maxClassification
                )})
            )
          FOR UPDATE OF d
        `);
        const row = locked.rows[0];
        if (!row) throw new DocumentControlError(404, "Not found");
        const versions = await tx.execute(sql`
          SELECT
            coalesce(bool_and(retention_until <= now()), true) AS retention_elapsed,
            coalesce(
              jsonb_agg(DISTINCT source_url) FILTER (WHERE source_url IS NOT NULL),
              '[]'::jsonb
            ) AS source_keys
          FROM document_versions
          WHERE document_id = ${id}::uuid
        `);
        const versionState = versions.rows[0];
        const purge = evaluateDocumentPurge({
          title: row["title"],
          confirmTitle: parsed.data.confirmTitle,
          lifecycleState: row["lifecycle_state"],
          retentionElapsed: versionState?.["retention_elapsed"] === true,
          retentionOverrideEnabled: overrideEnabled
        });
        if (!purge.allowed) {
          throw new DocumentControlError(purge.status, purge.error);
        }
        await appendSecurityEvent(
          {
            action: "document.purge",
            outcome: "success",
            actor: user,
            programId,
            resourceType: "document",
            resourceId: id,
            details: {
              reason: parsed.data.reason,
              retentionOverride: overrideEnabled
            }
          },
          tx as unknown as Parameters<typeof appendSecurityEvent>[1]
        );
        await tx.execute(sql`
          DELETE FROM documents
          WHERE id = ${id}::uuid
            AND program_id = ${programId}::uuid
        `);
        const sourceKeys = Array.isArray(versionState?.["source_keys"])
          ? versionState["source_keys"].filter(
              (value): value is string => typeof value === "string"
            )
          : [];
        return { sourceKeys };
      });

      await purgeCitationSnapshotsForDocument({ programId, documentId: id });
      const storage = getObjectStorage();
      const failedKeys: string[] = [];
      for (const sourceUrl of purgeReceipt.sourceKeys) {
        try {
          const stillReferenced = await db
            .select({ id: documentVersions.id })
            .from(documentVersions)
            .where(eq(documentVersions.sourceUrl, sourceUrl))
            .limit(1);
          if (!stillReferenced[0]) await storage.delete(sourceUrl);
        } catch (error) {
          failedKeys.push(sourceUrl);
          void recordAppError({
            severity: "warning",
            source: "storage",
            operation: "purge-document-blob",
            error,
            programId,
            context: { documentId: id, sourceUrl }
          });
        }
      }
      res.json({ ok: true, storageCleanupPending: failedKeys.length });
    } catch (err) {
      if (err instanceof DocumentControlError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (isMissingSecuritySchema(err)) {
        next(new SecurityControlsNotReadyError());
        return;
      }
      next(err);
    }
  }
);
