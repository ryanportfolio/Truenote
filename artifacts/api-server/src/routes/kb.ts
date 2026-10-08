import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, poolHasWaitingClients } from "../lib/db-client.js";
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
import { hasAtLeastRole } from "../lib/auth/current-user.js";
import { isDemoEmail } from "../lib/auth/demo-accounts.js";
import {
  isoOrNull,
  libraryColorOrNull,
  noteSchema,
  normalizeNote,
  personalColorSchema,
  pgErrorCode,
  pinSchema,
  serializeCategory,
  serializeTag,
  serializeUserState,
  validationMessage,
  type CategoryRow,
  type LibraryColor,
  type TagRow,
  type UserStateRow
} from "../lib/kb-library.js";
import { documentVisibleSql, snapshotsArraySql } from "../lib/kb-library-sql.js";
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
// The mutations on this router are personal: highlights, source pins, notes
// and colors, and category color overrides. They remain available to demo
// accounts so visitors can experience the features; every row is still
// owner- and program-scoped, with the normal caps.

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
  createdAt: string | null;
  /** Added, uploaded, or activated in the last NEW_WINDOW_DAYS. */
  isNew: boolean;
  /** Reader opens by anyone in the program over the last USAGE_WINDOW_DAYS. */
  viewCount: number;
  /** query_log rows in the program citing this document, last USAGE_WINDOW_DAYS. */
  citationCount: number;
  lastViewedByMeAt: string | null;
  pinnedAt: string | null;
  note: string | null;
  noteUpdatedAt: string | null;
  myColor: LibraryColor | null;
  featuredPosition: number | null;
  categoryIds: string[];
  tagIds: string[];
}

const NEW_WINDOW_DAYS = 14;
const USAGE_WINDOW_DAYS = 30;
/** One reader open per user and document per window counts as a view. */
const VIEW_DEDUPE_MINUTES = 30;

interface KbListRow {
  document_id: string;
  title: string;
  updated_at: Date | string | null;
  created_at: Date | string | null;
  is_new: boolean;
  view_count: number;
  citation_count: number;
  last_viewed_by_me_at: Date | string | null;
  pinned_at: Date | string | null;
  note: string | null;
  note_updated_at: Date | string | null;
  my_color: string | null;
  featured_position: number | null;
}

interface MembershipRow {
  owner_id: string;
  document_id: string;
}

kbRouter.get("/documents", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const maxClassification = await getUserMaxClassification(user.id);
    const programId = await resolveEffectiveProgramId(user, req);
    const canOrganize = hasAtLeastRole(user, "manager") && !isDemoEmail(user.email);
    if (programId === null) {
      res.json({
        items: [],
        categories: [],
        tags: [],
        canOrganize,
        noProgramSelected: true
      });
      return;
    }

    // One row per visible document with its usage counts and the caller's
    // personal state, aggregated in SQL. Multiple active versions shouldn't
    // exist (activation deactivates the predecessor), but if a race ever
    // produces two, DISTINCT ON keeps the newest upload.
    const listQuery = db.execute(sql`
      WITH visible AS (
        SELECT DISTINCT ON (d.id)
          d.id,
          d.title,
          d.created_at,
          v.uploaded_at,
          v.activated_at
        FROM documents AS d
        INNER JOIN document_versions AS v ON v.document_id = d.id
        WHERE d.program_id = ${programId}::uuid
          AND v.is_active = true
          AND v.parse_status = 'ready'
          AND v.lifecycle_state = 'active'
          AND ${classificationSqlPredicate(sql.raw("v.classification"), maxClassification)}
        ORDER BY d.id, v.uploaded_at DESC NULLS LAST
      ),
      views AS (
        SELECT document_id, count(*)::int AS view_count
        FROM kb_document_views
        WHERE program_id = ${programId}::uuid
          AND viewed_at > now() - make_interval(days => ${USAGE_WINDOW_DAYS})
        GROUP BY document_id
      ),
      my_views AS (
        SELECT document_id, max(viewed_at) AS last_viewed_at
        FROM kb_document_views
        WHERE program_id = ${programId}::uuid
          AND user_id = ${user.id}::uuid
        GROUP BY document_id
      ),
      cites AS (
        -- Count answers, not citation elements: one answer citing three
        -- excerpts of the same document counts once.
        SELECT cited.doc_id, count(*)::int AS citation_count
        FROM query_log AS q
        CROSS JOIN LATERAL (
          SELECT DISTINCT lower(elem ->> 'doc_id') AS doc_id
          FROM jsonb_array_elements(${snapshotsArraySql(sql.raw("q.citation_snapshots"))}) AS elem
          WHERE elem ->> 'doc_id' IS NOT NULL
        ) AS cited
        WHERE q.program_id = ${programId}::uuid
          AND q.created_at > now() - make_interval(days => ${USAGE_WINDOW_DAYS})
        GROUP BY cited.doc_id
      )
      SELECT
        vis.id::text AS document_id,
        vis.title,
        vis.uploaded_at AS updated_at,
        vis.created_at,
        COALESCE(
          COALESCE(vis.activated_at, vis.uploaded_at, vis.created_at)
            > now() - make_interval(days => ${NEW_WINDOW_DAYS})
          OR vis.created_at > now() - make_interval(days => ${NEW_WINDOW_DAYS}),
          false
        ) AS is_new,
        COALESCE(views.view_count, 0) AS view_count,
        COALESCE(cites.citation_count, 0) AS citation_count,
        my_views.last_viewed_at AS last_viewed_by_me_at,
        s.pinned_at,
        s.note,
        s.note_updated_at,
        s.color AS my_color,
        f.position AS featured_position
      FROM visible AS vis
      LEFT JOIN views ON views.document_id = vis.id
      LEFT JOIN my_views ON my_views.document_id = vis.id
      LEFT JOIN cites ON cites.doc_id = vis.id::text
      LEFT JOIN kb_source_user_state AS s
        ON s.user_id = ${user.id}::uuid AND s.document_id = vis.id
      LEFT JOIN kb_source_featured AS f
        ON f.document_id = vis.id AND f.program_id = ${programId}::uuid
      ORDER BY vis.title, vis.id
    `);
    const categoryQuery = db.execute(sql`
      SELECT
        c.id::text,
        c.parent_id::text,
        c.name,
        c.color,
        p.color AS my_color,
        c.position
      FROM kb_categories AS c
      LEFT JOIN kb_category_user_prefs AS p
        ON p.category_id = c.id AND p.user_id = ${user.id}::uuid
      WHERE c.program_id = ${programId}::uuid
      ORDER BY c.parent_id NULLS FIRST, c.position, lower(c.name), c.id
    `);
    const categoryMemberQuery = db.execute(sql`
      SELECT cd.category_id::text AS owner_id, cd.document_id::text AS document_id
      FROM kb_category_documents AS cd
      INNER JOIN kb_categories AS c ON c.id = cd.category_id
      WHERE c.program_id = ${programId}::uuid
      ORDER BY cd.category_id, cd.position, cd.added_at, cd.document_id
    `);
    const tagQuery = db.execute(sql`
      SELECT id::text, name, color
      FROM kb_tags
      WHERE program_id = ${programId}::uuid
      ORDER BY lower(name), id
    `);
    const tagMemberQuery = db.execute(sql`
      SELECT dt.tag_id::text AS owner_id, dt.document_id::text AS document_id
      FROM kb_document_tags AS dt
      INNER JOIN kb_tags AS t ON t.id = dt.tag_id
      WHERE t.program_id = ${programId}::uuid
    `);
    const [listResult, categoryResult, categoryMemberResult, tagResult, tagMemberResult] =
      await Promise.all([
        listQuery,
        categoryQuery,
        categoryMemberQuery,
        tagQuery,
        tagMemberQuery
      ]);

    const listRows = listResult.rows as unknown as KbListRow[];
    const visibleIds = new Set(listRows.map((r) => r.document_id));

    // Membership is filtered to documents this caller can see, so a
    // category never reveals a document above the caller's clearance.
    const categoryDocs = new Map<string, string[]>();
    const docCategories = new Map<string, string[]>();
    for (const m of categoryMemberResult.rows as unknown as MembershipRow[]) {
      if (!visibleIds.has(m.document_id)) continue;
      pushTo(categoryDocs, m.owner_id, m.document_id);
    }
    const categoryRows = categoryResult.rows as unknown as CategoryRow[];
    for (const c of categoryRows) {
      for (const docId of categoryDocs.get(c.id) ?? []) pushTo(docCategories, docId, c.id);
    }
    const tagRows = tagResult.rows as unknown as TagRow[];
    const tagOrder = new Map(tagRows.map((t, i) => [t.id, i]));
    const docTags = new Map<string, string[]>();
    for (const m of tagMemberResult.rows as unknown as MembershipRow[]) {
      if (!visibleIds.has(m.document_id)) continue;
      pushTo(docTags, m.document_id, m.owner_id);
    }

    const items: KbDocumentListItem[] = listRows.map((r) => ({
      documentId: r.document_id,
      title: r.title,
      updatedAt: isoOrNull(r.updated_at),
      createdAt: isoOrNull(r.created_at),
      isNew: r.is_new === true,
      viewCount: Number(r.view_count),
      citationCount: Number(r.citation_count),
      lastViewedByMeAt: isoOrNull(r.last_viewed_by_me_at),
      pinnedAt: isoOrNull(r.pinned_at),
      note: r.note,
      noteUpdatedAt: isoOrNull(r.note_updated_at),
      myColor: libraryColorOrNull(r.my_color),
      featuredPosition: r.featured_position === null ? null : Number(r.featured_position),
      categoryIds: docCategories.get(r.document_id) ?? [],
      tagIds: (docTags.get(r.document_id) ?? []).sort(
        (a, b) => (tagOrder.get(a) ?? 0) - (tagOrder.get(b) ?? 0)
      )
    }));
    res.json({
      items,
      categories: categoryRows.map((c) => serializeCategory(c, categoryDocs.get(c.id) ?? [])),
      tags: tagRows.map(serializeTag),
      canOrganize
    });
  } catch (err) {
    next(err);
  }
});

function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Best-effort reader-open event. Skips when the same user opened the same
 * document within VIEW_DEDUPE_MINUTES, so counts track reads, not reloads.
 * Two concurrent first opens can both insert; the counts tolerate that.
 * Skipped while requests queue for a pool connection: a lost view is
 * cheaper than delaying someone's read.
 */
async function recordDocumentView(input: {
  documentId: string;
  programId: string;
  userId: string;
  via: "browse" | "citation";
}): Promise<void> {
  if (poolHasWaitingClients()) return;
  await db.execute(sql`
    INSERT INTO kb_document_views (document_id, program_id, user_id, via)
    SELECT ${input.documentId}::uuid, ${input.programId}::uuid, ${input.userId}::uuid, ${input.via}
    WHERE NOT EXISTS (
      SELECT 1
      FROM kb_document_views
      WHERE user_id = ${input.userId}::uuid
        AND document_id = ${input.documentId}::uuid
        AND viewed_at > now() - make_interval(mins => ${VIEW_DEDUPE_MINUTES})
    )
  `);
}

/** The caller's pin, note and color for one document (all null when unset). */
async function loadPersonalState(userId: string, documentId: string) {
  const result = await db.execute(sql`
    SELECT document_id::text, pinned_at, note, note_updated_at, color
    FROM kb_source_user_state
    WHERE user_id = ${userId}::uuid
      AND document_id = ${documentId}::uuid
  `);
  return serializeUserState(documentId, result.rows[0] as unknown as UserStateRow | undefined);
}

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
    // Personal state belongs to the document, not the version, so a reader
    // opened on an older version through a receipt shows it too.
    const personal = await loadPersonalState(user.id, row.documentId);
    res.json({
      documentId: row.documentId,
      documentVersionId: row.documentVersionId,
      versionNumber: row.versionNumber,
      isCurrentVersion: row.isActive === true,
      title: row.title,
      markdown: row.markdown,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      citationAuthorized,
      citationTarget,
      pinnedAt: personal.pinnedAt,
      note: personal.note,
      noteUpdatedAt: personal.noteUpdatedAt,
      myColor: personal.color
    });
    // Views count reads of the current version only; opening an older
    // version through a citation receipt is history, not library usage.
    if (row.isActive === true && row.lifecycleState === "active") {
      recordDocumentView({
        documentId: row.documentId,
        programId,
        userId: user.id,
        via: citationAuthorized ? "citation" : "browse"
      }).catch((error: unknown) => {
        console.warn(
          "[kb] failed to record document view:",
          error instanceof Error ? error.message : error
        );
      });
    }
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

/**
 * Personal pin, private note and color label. Same audience as highlights:
 * every role, demo accounts included, and the document must be one this user
 * can read right now (program + active version + clearance). The row is
 * removed once the pin, the note and the color are all cleared.
 */
type PersonalStateChange =
  | { kind: "pin"; pinned: boolean }
  | { kind: "note"; note: string | null }
  | { kind: "color"; color: LibraryColor | null };

async function writePersonalState(input: {
  userId: string;
  documentId: string;
  programId: string;
  maxClassification: Classification;
  change: PersonalStateChange;
}): Promise<UserStateRow | null | "not_found"> {
  const { userId, documentId, programId, maxClassification, change } = input;
  return db.transaction(async (tx) => {
    const visible = await tx.execute(sql`
      SELECT ${documentVisibleSql(sql`${documentId}::uuid`, programId, maxClassification)} AS ok
    `);
    if ((visible.rows[0] as { ok?: unknown } | undefined)?.ok !== true) {
      return "not_found" as const;
    }
    if (change.kind === "pin") {
      await tx.execute(sql`
        INSERT INTO kb_source_user_state (user_id, document_id, pinned_at, updated_at)
        VALUES (
          ${userId}::uuid,
          ${documentId}::uuid,
          CASE WHEN ${change.pinned}::boolean THEN now() END,
          now()
        )
        ON CONFLICT (user_id, document_id) DO UPDATE
        SET pinned_at = CASE
              WHEN ${change.pinned}::boolean
                THEN COALESCE(kb_source_user_state.pinned_at, now())
            END,
            updated_at = now()
      `);
    } else if (change.kind === "color") {
      await tx.execute(sql`
        INSERT INTO kb_source_user_state (user_id, document_id, color, updated_at)
        VALUES (${userId}::uuid, ${documentId}::uuid, ${change.color}::text, now())
        ON CONFLICT (user_id, document_id) DO UPDATE
        SET color = EXCLUDED.color,
            updated_at = now()
      `);
    } else {
      await tx.execute(sql`
        INSERT INTO kb_source_user_state (user_id, document_id, note, note_updated_at, updated_at)
        VALUES (
          ${userId}::uuid,
          ${documentId}::uuid,
          ${change.note}::text,
          CASE WHEN ${change.note}::text IS NULL THEN NULL ELSE now() END,
          now()
        )
        ON CONFLICT (user_id, document_id) DO UPDATE
        SET note = EXCLUDED.note,
            note_updated_at = EXCLUDED.note_updated_at,
            updated_at = now()
      `);
    }
    await tx.execute(sql`
      DELETE FROM kb_source_user_state
      WHERE user_id = ${userId}::uuid
        AND document_id = ${documentId}::uuid
        AND pinned_at IS NULL
        AND note IS NULL
        AND color IS NULL
    `);
    const result = await tx.execute(sql`
      SELECT document_id::text, pinned_at, note, note_updated_at, color
      FROM kb_source_user_state
      WHERE user_id = ${userId}::uuid
        AND document_id = ${documentId}::uuid
    `);
    return (result.rows[0] as unknown as UserStateRow | undefined) ?? null;
  });
}

kbRouter.put("/documents/:id/pin", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const documentId = req.params.id;
    if (!UUID_RE.test(documentId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = pinSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: validationMessage(parsed.error, "Say whether to pin or unpin this source.")
      });
      return;
    }
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.status(400).json({ error: "No program selected." });
      return;
    }
    const maxClassification = await getUserMaxClassification(user.id);
    const outcome = await writePersonalState({
      userId: user.id,
      documentId: documentId.toLowerCase(),
      programId,
      maxClassification,
      change: { kind: "pin", pinned: parsed.data.pinned }
    });
    if (outcome === "not_found") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ item: serializeUserState(documentId.toLowerCase(), outcome ?? undefined) });
  } catch (err) {
    next(err);
  }
});

kbRouter.put("/documents/:id/note", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const documentId = req.params.id;
    if (!UUID_RE.test(documentId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error, "Send the note text.") });
      return;
    }
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.status(400).json({ error: "No program selected." });
      return;
    }
    const maxClassification = await getUserMaxClassification(user.id);
    const outcome = await writePersonalState({
      userId: user.id,
      documentId: documentId.toLowerCase(),
      programId,
      maxClassification,
      change: { kind: "note", note: normalizeNote(parsed.data.note) }
    });
    if (outcome === "not_found") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ item: serializeUserState(documentId.toLowerCase(), outcome ?? undefined) });
  } catch (err) {
    next(err);
  }
});

kbRouter.put("/documents/:id/color", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const documentId = req.params.id;
    if (!UUID_RE.test(documentId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = personalColorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: validationMessage(parsed.error, "Pick a color, or send null to clear it.")
      });
      return;
    }
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.status(400).json({ error: "No program selected." });
      return;
    }
    const maxClassification = await getUserMaxClassification(user.id);
    const outcome = await writePersonalState({
      userId: user.id,
      documentId: documentId.toLowerCase(),
      programId,
      maxClassification,
      change: { kind: "color", color: parsed.data.color }
    });
    if (outcome === "not_found") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ item: serializeUserState(documentId.toLowerCase(), outcome ?? undefined) });
  } catch (err) {
    next(err);
  }
});

/**
 * Personal override of a category's team color, private to the caller.
 * Every role, demo included. Categories are listed to everyone in their
 * program, so the only boundary is the effective program: a category from
 * another program, or an unknown id, is a 404. `color: null` resets the
 * caller's view to the team color.
 */
kbRouter.put("/categories/:id/color", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const rawId = req.params.id;
    if (!UUID_RE.test(rawId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const categoryId = rawId.toLowerCase();
    const parsed = personalColorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: validationMessage(parsed.error, "Pick a color, or send null to use the team color.")
      });
      return;
    }
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.status(400).json({ error: "No program selected." });
      return;
    }
    const { color } = parsed.data;
    // One statement each, so the program check and the write can't drift
    // apart. The CTE reports whether the category exists in the program.
    const result =
      color === null
        ? await db.execute(sql`
            WITH cat AS (
              SELECT id
              FROM kb_categories
              WHERE id = ${categoryId}::uuid
                AND program_id = ${programId}::uuid
            ),
            cleared AS (
              DELETE FROM kb_category_user_prefs AS p
              USING cat
              WHERE p.user_id = ${user.id}::uuid
                AND p.category_id = cat.id
            )
            SELECT NULL::text AS color FROM cat
          `)
        : await db
            .execute(sql`
              INSERT INTO kb_category_user_prefs (user_id, category_id, color, updated_at)
              SELECT ${user.id}::uuid, c.id, ${color}::text, now()
              FROM kb_categories AS c
              WHERE c.id = ${categoryId}::uuid
                AND c.program_id = ${programId}::uuid
              ON CONFLICT (user_id, category_id) DO UPDATE
              SET color = EXCLUDED.color,
                  updated_at = now()
              RETURNING color
            `)
            .catch((err: unknown) => {
              // The category was deleted between the read and the insert.
              if (pgErrorCode(err) === "23503") return null;
              throw err;
            });
    const row = result?.rows[0] as { color: string | null } | undefined;
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ item: { categoryId, myColor: libraryColorOrNull(row.color) } });
  } catch (err) {
    next(err);
  }
});
