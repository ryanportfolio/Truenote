import { Router } from "express";
import multer from "multer";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../lib/db-client.js";
import { documents, documentVersions } from "@workspace/db/schema";
import { getObjectStorage } from "../lib/storage/object-storage.js";
import { sha256Hex } from "../lib/parsing/hash.js";
import { enqueueIngestion } from "../lib/ingestion/queue.js";
import { requireAdmin } from "../middleware/current-user.js";

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

documentsRouter.get("/", requireAdmin, async (req, res, next) => {
  try {
    const user = req.user;
    // Latest version per document — for Phase 1, list shows the newest version
    // (regardless of active state) so the admin can watch ingestion progress.
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
      .where(eq(documents.programId, user.programId))
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
  requireAdmin,
  upload.single("file"),
  async (req, res, next) => {
    try {
      const user = req.user;
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
      if (!ACCEPTED_MIMES.has(file.mimetype)) {
        res.status(400).json({
          ok: false,
          error: `Unsupported file type: ${file.mimetype || "unknown"}`
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
      await storage.put(key, bytes, { contentType: file.mimetype });

      // Re-upload semantics (.claude/reference/ingestion.md):
      // "Re-uploading a document creates a NEW version. Do not overwrite."
      // Look up an existing document with the same (program_id, title); if one
      // exists, this upload becomes its next version. Otherwise create a new
      // documents row.
      const existing = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.programId, user.programId), eq(documents.title, title)))
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
          .values({ programId: user.programId, title })
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
          mimeType: file.mimetype,
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

documentsRouter.get("/:versionId/preview", requireAdmin, async (req, res, next) => {
  try {
    const user = req.user;
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
    // Server-side program scope check. Even an admin can only preview within
    // their current program. Phase 2 widens admin scope when multi-program is
    // a real concept.
    if (row.programId !== user.programId) {
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
