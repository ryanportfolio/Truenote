import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../lib/db-client.js";
import { documents, documentVersions } from "@workspace/db/schema";
import {
  authedUser,
  requireAuth,
  requireCsrOrAbove,
  requireFreshPassword
} from "../middleware/current-user.js";
import { resolveEffectiveProgramId } from "../lib/auth/effective-program.js";

/**
 * CSR-facing knowledge base reader. Unlike /api/documents (manager+ admin
 * surface: uploads, previews of any version, deletes), these endpoints are
 * read-only, restricted to ACTIVE + parse-ready versions, and open to every
 * authenticated role — a CSR browsing the KB is the product working as
 * intended.
 *
 * Program scoping is enforced server-side on both endpoints (the same
 * `program_id` predicate retrieval uses). Cross-program ids return 404,
 * not 403, to avoid leaking existence.
 */
export const kbRouter = Router();

kbRouter.use(requireAuth, requireFreshPassword, requireCsrOrAbove);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface KbDocumentListItem {
  documentId: string;
  title: string;
  /** Active version's upload time (ISO), null if the column is null. */
  updatedAt: string | null;
}

kbRouter.get("/documents", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.json({ items: [], noProgramSelected: true });
      return;
    }
    const rows = await db
      .select({
        documentId: documents.id,
        title: documents.title,
        updatedAt: documentVersions.uploadedAt
      })
      .from(documents)
      .innerJoin(
        documentVersions,
        and(
          eq(documentVersions.documentId, documents.id),
          eq(documentVersions.isActive, true),
          eq(documentVersions.parseStatus, "ready")
        )
      )
      .where(eq(documents.programId, programId))
      .orderBy(documents.title, desc(documentVersions.uploadedAt));

    // One row per document. Multiple active versions shouldn't exist
    // (activation deactivates the predecessor), but if a race ever
    // produces two, keep the newest upload.
    const byDocId = new Map<string, KbDocumentListItem>();
    for (const r of rows) {
      if (byDocId.has(r.documentId)) continue;
      byDocId.set(r.documentId, {
        documentId: r.documentId,
        title: r.title,
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null
      });
    }
    res.json({ items: Array.from(byDocId.values()) });
  } catch (err) {
    next(err);
  }
});

kbRouter.get("/documents/:id", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.status(400).json({ error: "No program selected." });
      return;
    }
    const rows = await db
      .select({
        documentId: documents.id,
        title: documents.title,
        markdown: documentVersions.parsedMarkdown,
        updatedAt: documentVersions.uploadedAt
      })
      .from(documents)
      .innerJoin(
        documentVersions,
        and(
          eq(documentVersions.documentId, documents.id),
          eq(documentVersions.isActive, true),
          eq(documentVersions.parseStatus, "ready")
        )
      )
      .where(and(eq(documents.id, id), eq(documents.programId, programId)))
      .orderBy(desc(documentVersions.uploadedAt))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({
      documentId: row.documentId,
      title: row.title,
      markdown: row.markdown,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null
    });
  } catch (err) {
    next(err);
  }
});
