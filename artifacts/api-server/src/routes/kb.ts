import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../lib/db-client.js";
import { documents, documentVersions } from "@workspace/db/schema";
import {
  createHighlightSchema,
  serializeHighlight,
  updateHighlightSchema,
  type KbHighlightRow
} from "../lib/kb-highlights.js";
import {
  authedUser,
  requireAuth,
  requireCsrOrAbove,
  requireFreshPassword
} from "../middleware/current-user.js";
import { resolveEffectiveProgramId } from "../lib/auth/effective-program.js";
import {
  citationTargetMatchesMarkdown,
  loadAuthorizedCitationReceipt,
  type CitationTarget
} from "../lib/citations.js";
import {
  classificationSqlPredicate,
  getUserMaxClassification,
  type Classification
} from "../lib/security/classification.js";

/**
 * CSR-facing knowledge base reader. Unlike /api/documents (manager+ admin
 * surface: uploads, previews of any version, deletes), document reads are
 * restricted to ACTIVE + parse-ready versions and open to every authenticated
 * role. Personal highlights add owner-scoped writes around that read surface.
 *
 * Program scoping is enforced server-side on every endpoint (the same
 * `program_id` predicate retrieval uses). Cross-program ids return 404,
 * not 403, to avoid leaking existence.
 */
export const kbRouter = Router();

kbRouter.use(requireAuth, requireFreshPassword, requireCsrOrAbove);
// Personal highlights are the only mutations on this router. They remain
// available to demo accounts so visitors can experience the feature; every
// row is still owner- and program-scoped, with the normal overlap/range caps.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_HIGHLIGHTS_PER_VERSION = 500;
const MAX_CITATION_SOURCE_INDEX = 63;

export function parseCitationSourceIndex(value: unknown): number | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_CITATION_SOURCE_INDEX
    ? parsed
    : null;
}

export function canServeKbVersion(
  isActive: boolean,
  citationAuthorized: boolean,
  lifecycleState: string
): boolean {
  if (lifecycleState === "revoked" || lifecycleState === "rejected") return false;
  return (isActive && lifecycleState === "active") ||
    (citationAuthorized && lifecycleState === "retired");
}

function queryString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

interface ActiveVersionRow {
  document_version_id: string;
  parsed_markdown: string | null;
}

async function findActiveVersion(
  documentId: string,
  programId: string,
  maxClassification: Classification
): Promise<string | null> {
  const rows = await db
    .select({ documentVersionId: documentVersions.id })
    .from(documents)
    .innerJoin(
      documentVersions,
      and(
        eq(documentVersions.documentId, documents.id),
        eq(documentVersions.isActive, true),
        eq(documentVersions.parseStatus, "ready"),
        sql`document_versions.lifecycle_state = 'active'`,
        classificationSqlPredicate(
          sql.raw("document_versions.classification"),
          maxClassification
        )
      )
    )
    .where(and(eq(documents.id, documentId), eq(documents.programId, programId)))
    .orderBy(desc(documentVersions.uploadedAt))
    .limit(1);
  return rows[0]?.documentVersionId ?? null;
}

export interface KbDocumentListItem {
  documentId: string;
  title: string;
  /** Active version's upload time (ISO), null if the column is null. */
  updatedAt: string | null;
}

kbRouter.get("/documents", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const maxClassification = await getUserMaxClassification(user.id);
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
          eq(documentVersions.parseStatus, "ready"),
          sql`document_versions.lifecycle_state = 'active'`,
          classificationSqlPredicate(
            sql.raw("document_versions.classification"),
            maxClassification
          )
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
    const maxClassification = await getUserMaxClassification(user.id);
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
    const rawVersion = queryString(req.query.version);
    if (rawVersion !== null && !UUID_RE.test(rawVersion)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const rows = await db
      .select({
        documentId: documents.id,
        documentVersionId: documentVersions.id,
        versionNumber: documentVersions.versionNumber,
        isActive: documentVersions.isActive,
        lifecycleState: sql<string>`document_versions.lifecycle_state`,
        title: documents.title,
        markdown: documentVersions.parsedMarkdown,
        updatedAt: documentVersions.uploadedAt
      })
      .from(documents)
      .innerJoin(
        documentVersions,
        and(
          eq(documentVersions.documentId, documents.id),
          eq(documentVersions.parseStatus, "ready"),
          classificationSqlPredicate(
            sql.raw("document_versions.classification"),
            maxClassification
          ),
          rawVersion
            ? sql`document_versions.lifecycle_state IN ('active', 'retired')`
            : sql`document_versions.lifecycle_state = 'active'`,
          rawVersion
            ? eq(documentVersions.id, rawVersion)
            : eq(documentVersions.isActive, true)
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
    const queryLogId = queryString(req.query.query);
    const sourceIndex = parseCitationSourceIndex(req.query.source);
    let citationTarget: CitationTarget | null = null;
    let citationAuthorized = false;
    if (
      rawVersion !== null &&
      queryLogId !== null &&
      UUID_RE.test(queryLogId) &&
      sourceIndex !== null
    ) {
      const receipt = await loadAuthorizedCitationReceipt({
        queryLogId,
        sourceIndex,
        userId: user.id,
        programId,
        documentId: row.documentId,
        documentVersionId: row.documentVersionId
      });
      citationAuthorized = receipt !== null;
      citationTarget = receipt?.target ?? null;
      if (
        citationTarget &&
        (!row.markdown || !citationTargetMatchesMarkdown(row.markdown, citationTarget))
      ) {
        citationTarget = null;
      }
    }
    // Inactive versions are audit history, not a general CSR browsing API.
    // Only the owner of a matching immutable answer receipt may open one.
    if (
      !canServeKbVersion(
        row.isActive === true,
        citationAuthorized,
        row.lifecycleState
      )
    ) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({
      documentId: row.documentId,
      documentVersionId: row.documentVersionId,
      versionNumber: row.versionNumber,
      isCurrentVersion: row.isActive === true,
      title: row.title,
      markdown: row.markdown,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      citationAuthorized,
      citationTarget
    });
  } catch (err) {
    next(err);
  }
});

/** Personal highlights for the document's current active parsed version. */
kbRouter.get("/documents/:id/highlights", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const maxClassification = await getUserMaxClassification(user.id);
    const documentId = req.params.id;
    if (!UUID_RE.test(documentId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.status(400).json({ error: "No program selected." });
      return;
    }
    const documentVersionId = await findActiveVersion(
      documentId,
      programId,
      maxClassification
    );
    if (documentVersionId === null) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const result = await db.execute(sql`
      SELECT
        id::text,
        highlighted_text,
        start_offset,
        end_offset,
        color,
        created_at,
        updated_at
      FROM kb_highlights
      WHERE user_id = ${user.id}::uuid
        AND document_id = ${documentId}::uuid
        AND document_version_id = ${documentVersionId}::uuid
      ORDER BY start_offset, created_at
    `);
    const rows = result.rows as unknown as KbHighlightRow[];
    res.json({
      items: rows.map(serializeHighlight),
      documentVersionId,
      canWriteHighlights: true
    });
  } catch (err) {
    next(err);
  }
});

kbRouter.post("/documents/:id/highlights", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const maxClassification = await getUserMaxClassification(user.id);
    const documentId = req.params.id;
    if (!UUID_RE.test(documentId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = createHighlightSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid highlight." });
      return;
    }
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.status(400).json({ error: "No program selected." });
      return;
    }
    const outcome = await db.transaction(async (tx) => {
      // Lock the active version row so activation cannot invalidate it
      // between validation and insert. This join also re-enforces program
      // scope inside the write transaction.
      const activeResult = await tx.execute(sql`
        SELECT
          v.id::text AS document_version_id,
          v.parsed_markdown
        FROM documents AS d
        INNER JOIN document_versions AS v ON v.document_id = d.id
        WHERE d.id = ${documentId}::uuid
          AND d.program_id = ${programId}::uuid
          AND v.is_active = true
          AND v.parse_status = 'ready'
          AND v.lifecycle_state = 'active'
          AND ${classificationSqlPredicate(sql.raw("v.classification"), maxClassification)}
        ORDER BY v.uploaded_at DESC
        LIMIT 1
        FOR SHARE OF v
      `);
      const active = activeResult.rows[0] as unknown as ActiveVersionRow | undefined;
      if (!active) return { kind: "not_found" } as const;
      if (active.document_version_id !== parsed.data.documentVersionId) {
        return { kind: "changed" } as const;
      }

      // ReactMarkdown's flattened text should never materially exceed its
      // source. This generous ceiling rejects off-document writes without
      // rejecting passages that span markdown formatting markers.
      const markdownLength = active.parsed_markdown?.length ?? 0;
      const renderedTextCeiling = Math.max(1_024, markdownLength * 2 + 1_024);
      if (markdownLength === 0 || parsed.data.endOffset > renderedTextCeiling) {
        return { kind: "invalid_range" } as const;
      }

      // Serialize creates for one user's document version. This makes the
      // overlap check + insert atomic without requiring btree_gist.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${`${user.id}:${active.document_version_id}`})
        )
      `);

      const countResult = await tx.execute(sql`
        SELECT count(*)::int AS count
        FROM kb_highlights
        WHERE user_id = ${user.id}::uuid
          AND document_version_id = ${active.document_version_id}::uuid
      `);
      const count = Number(countResult.rows[0]?.["count"] ?? 0);
      if (count >= MAX_HIGHLIGHTS_PER_VERSION) {
        return { kind: "limit" } as const;
      }

      const overlap = await tx.execute(sql`
        SELECT id
        FROM kb_highlights
        WHERE user_id = ${user.id}::uuid
          AND document_version_id = ${active.document_version_id}::uuid
          AND start_offset < ${parsed.data.endOffset}
          AND end_offset > ${parsed.data.startOffset}
        LIMIT 1
      `);
      if (overlap.rows.length > 0) return { kind: "overlap" } as const;

      const result = await tx.execute(sql`
        INSERT INTO kb_highlights (
          user_id,
          document_id,
          document_version_id,
          highlighted_text,
          start_offset,
          end_offset,
          color
        ) VALUES (
          ${user.id}::uuid,
          ${documentId}::uuid,
          ${active.document_version_id}::uuid,
          ${parsed.data.highlightedText},
          ${parsed.data.startOffset},
          ${parsed.data.endOffset},
          ${parsed.data.color}
        )
        RETURNING
          id::text,
          highlighted_text,
          start_offset,
          end_offset,
          color,
          created_at,
          updated_at
      `);
      const row = result.rows[0] as unknown as KbHighlightRow | undefined;
      if (!row) throw new Error("Highlight insert returned no row");
      return { kind: "created", row } as const;
    });

    if (outcome.kind === "not_found") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (outcome.kind === "changed") {
      res.status(409).json({
        error: "This document changed. Reload it before highlighting."
      });
      return;
    }
    if (outcome.kind === "invalid_range") {
      res.status(400).json({ error: "Invalid highlight range." });
      return;
    }
    if (outcome.kind === "limit") {
      res.status(409).json({
        error: `You can save up to ${MAX_HIGHLIGHTS_PER_VERSION} highlights per document.`
      });
      return;
    }
    if (outcome.kind === "overlap") {
      res.status(409).json({
        error: "That passage overlaps an existing highlight."
      });
      return;
    }
    res.status(201).json({ item: serializeHighlight(outcome.row) });
  } catch (err) {
    next(err);
  }
});

kbRouter.patch("/highlights/:id", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const maxClassification = await getUserMaxClassification(user.id);
    const highlightId = req.params.id;
    if (!UUID_RE.test(highlightId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = updateHighlightSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid highlight color." });
      return;
    }
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.status(400).json({ error: "No program selected." });
      return;
    }
    const result = await db.execute(sql`
      UPDATE kb_highlights AS h
      SET color = ${parsed.data.color}, updated_at = now()
      FROM documents AS d, document_versions AS v
      WHERE h.id = ${highlightId}::uuid
        AND h.user_id = ${user.id}::uuid
        AND d.id = h.document_id
        AND d.program_id = ${programId}::uuid
        AND v.id = h.document_version_id
        AND v.document_id = d.id
        AND v.is_active = true
        AND v.parse_status = 'ready'
        AND v.lifecycle_state = 'active'
        AND ${classificationSqlPredicate(sql.raw("v.classification"), maxClassification)}
      RETURNING
        h.id::text,
        h.highlighted_text,
        h.start_offset,
        h.end_offset,
        h.color,
        h.created_at,
        h.updated_at
    `);
    const row = result.rows[0] as unknown as KbHighlightRow | undefined;
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ item: serializeHighlight(row) });
  } catch (err) {
    next(err);
  }
});

kbRouter.delete("/highlights/:id", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const maxClassification = await getUserMaxClassification(user.id);
    const highlightId = req.params.id;
    if (!UUID_RE.test(highlightId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.status(400).json({ error: "No program selected." });
      return;
    }
    const result = await db.execute(sql`
      DELETE FROM kb_highlights AS h
      USING documents AS d, document_versions AS v
      WHERE h.id = ${highlightId}::uuid
        AND h.user_id = ${user.id}::uuid
        AND d.id = h.document_id
        AND d.program_id = ${programId}::uuid
        AND v.id = h.document_version_id
        AND v.document_id = d.id
        AND v.is_active = true
        AND v.parse_status = 'ready'
        AND v.lifecycle_state = 'active'
        AND ${classificationSqlPredicate(sql.raw("v.classification"), maxClassification)}
      RETURNING h.id
    `);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
