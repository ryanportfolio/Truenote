import { Router } from "express";
import multer from "multer";
import { and, desc, eq } from "drizzle-orm";
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
  requireManagerOrAbove
} from "../middleware/current-user.js";
import { canAccessProgram } from "../lib/auth/current-user.js";
import { resolveEffectiveProgramId } from "../lib/auth/effective-program.js";

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
}

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
    // Filter to the effective program. For managers / senior managers
    // this is their own program (DB CHECK guaranteed non-null). For
    // super_user it's whatever they selected via X-Program-Id; if
    // they haven't selected, return an empty list with the sentinel
    // so the UI can prompt without a separate "no program" endpoint.
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.json({ items: [], noProgramSelected: true });
      return;
    }
    const rows = await db
      .select({
        documentId: documents.id,
        title: documents.title,
        versionId: documentVersions.id,
        parseStatus: documentVersions.parseStatus,
        uploadedAt: documentVersions.uploadedAt,
        docCreatedAt: documents.createdAt
      })
      .from(documents)
      .leftJoin(documentVersions, eq(documentVersions.documentId, documents.id))
      .where(eq(documents.programId, programId))
      .orderBy(desc(documents.createdAt), desc(documentVersions.uploadedAt));

    // Collapse to the newest version per documentId.
    const byDocId = new Map<string, DocumentListItem>();
    for (const r of rows) {
      if (byDocId.has(r.documentId)) continue;
      byDocId.set(r.documentId, {
        documentId: r.documentId,
        title: r.title,
        versionId: r.versionId,
        parseStatus: r.parseStatus,
        uploadedAt: r.uploadedAt ? r.uploadedAt.toISOString() : null
      });
    }
    res.json({ items: Array.from(byDocId.values()) });
  } catch (err) {
    next(err);
  }
});

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

      if (!file) {
        res.status(400).json({ ok: false, error: "Missing file" });
        return;
      }
      if (title.length === 0) {
        res.status(400).json({ ok: false, error: "Missing title" });
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

      const insertedVersion = await db
        .insert(documentVersions)
        .values({
          documentId: docId,
          versionNumber,
          sourceUrl: key,
          mimeType,
          fileSha256: sha,
          parseStatus: "pending",
          uploadedBy: user.id,
          isActive: false
        })
        .returning({ id: documentVersions.id });
      const version = insertedVersion[0];
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
      next(err);
    }
  }
);

documentsRouter.get("/:versionId/preview", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const versionId = req.params.versionId;
    const rows = await db
      .select({
        parsedMarkdown: documentVersions.parsedMarkdown,
        parseStatus: documentVersions.parseStatus,
        programId: documents.programId,
        title: documents.title
      })
      .from(documentVersions)
      .leftJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(eq(documentVersions.id, versionId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.json({ markdown: null, parseStatus: null, title: null });
      return;
    }
    // The leftJoin can in principle return a row with a null programId
    // (orphaned version with no parent document). canAccessProgram
    // returns true for super_user on a null programId — which would
    // expose unscoped content. Refuse explicitly when the document
    // row didn't join, regardless of role.
    if (row.programId === null) {
      res.json({ markdown: null, parseStatus: null, title: null });
      return;
    }
    // Server-side program scope check via canAccessProgram (single source
    // of truth for "can this user touch resources in program X"). Super
    // users see across programs; everyone else is bound to their own.
    if (!canAccessProgram(user, row.programId)) {
      res.json({ markdown: null, parseStatus: null, title: null });
      return;
    }
    res.json({
      markdown: row.parsedMarkdown,
      parseStatus: row.parseStatus,
      title: row.title
    });
  } catch (err) {
    next(err);
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete a document and everything it owns. The FK chain handles the deep
 * cleanup atomically at the DB level:
 *   documents → document_versions → chunks (all ON DELETE CASCADE).
 *
 * Scoping note: we use a combined `id AND program_id` predicate so an admin
 * scoped to program A can't delete a doc in program B. We return 404 (not
 * 403) on cross-program ids to avoid leaking existence — same convention
 * the preview route uses for the same reason.
 *
 * Blob cleanup (Phase 1.5): we collect every distinct source_url owned by
 * this document's versions BEFORE the cascade fires, then after the row
 * delete we walk each key and remove it from Object Storage — but only
 * if no other document_versions row still references it. The
 * shared-blob case is real: two uploads of the same file (same SHA) hit
 * the same storage key, so an unconditional delete here would orphan a
 * sibling document. Storage.delete() is idempotent so a key that's
 * already gone is a no-op.
 *
 * Storage failures are logged, not surfaced. We've already returned
 * 200 to the user (the DB row is gone, which is what they asked for);
 * a periodic sweep can mop up stragglers.
 */
documentsRouter.delete("/:id", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ ok: false, error: "Invalid document id" });
      return;
    }
    // Scope delete to the effective program (manager/senior_manager =
    // own program; super_user = picker selection). If a super_user
    // wants to delete from another program they must switch to it —
    // this guards against deleting a stale row from the previous
    // program if they switched while a delete was in flight.
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.status(400).json({
        ok: false,
        error: "No program selected."
      });
      return;
    }

    // Collect candidate source_urls BEFORE the row goes away — the
    // cascade will null these out of reach. distinct() drops the
    // duplicates that arise when the same file was re-uploaded.
    const candidateKeys = await db
      .selectDistinct({ sourceUrl: documentVersions.sourceUrl })
      .from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(
        and(
          eq(documents.id, id),
          eq(documents.programId, programId)
        )
      );

    const deleted = await db
      .delete(documents)
      .where(and(eq(documents.id, id), eq(documents.programId, programId)))
      .returning({ id: documents.id });
    if (deleted.length === 0) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }

    // Respond first; blob cleanup is best-effort. The DB row is gone,
    // which is the user-visible outcome they expect — taking ~100ms
    // per blob in the worst case would block the response for no
    // reason.
    res.json({ ok: true });

    void (async () => {
      const storage = getObjectStorage();
      for (const { sourceUrl } of candidateKeys) {
        if (!sourceUrl) continue;
        try {
          // Shared-blob guard: another active version (in this or
          // another document) might still reference the same key.
          // Skip the blob delete in that case — the sweeper can
          // collect it later if/when the last reference goes away.
          const stillReferenced = await db
            .select({ id: documentVersions.id })
            .from(documentVersions)
            .where(eq(documentVersions.sourceUrl, sourceUrl))
            .limit(1);
          if (stillReferenced[0]) continue;
          await storage.delete(sourceUrl);
        } catch (err) {
          console.warn(
            `[documents] blob cleanup failed for ${sourceUrl}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    })();
  } catch (err) {
    next(err);
  }
});
