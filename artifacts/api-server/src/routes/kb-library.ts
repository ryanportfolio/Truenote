import { Router, type NextFunction, type Request, type Response } from "express";
import type { z, ZodTypeAny } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../lib/db-client.js";
import {
  authedUser,
  blockDemoWrites,
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove
} from "../middleware/current-user.js";
import { canAccessProgram, type CurrentUser } from "../lib/auth/current-user.js";
import { resolveEffectiveProgramId } from "../lib/auth/effective-program.js";
import { clientIpFrom } from "../lib/auth/rate-limit.js";
import { appendSecurityEvent } from "../lib/security/audit.js";
import {
  getUserMaxClassification,
  type Classification
} from "../lib/security/classification.js";
import {
  CATEGORY_CYCLE_MESSAGE,
  CATEGORY_DEPTH_MESSAGE,
  FEATURED_LIMIT_MESSAGE,
  TAG_NAME_TAKEN_MESSAGE,
  canNestAt,
  canPinForTeam,
  categoryConflictMessage,
  categoryDocumentsSchema,
  createCategorySchema,
  createTagSchema,
  documentCategoriesSchema,
  documentTagsSchema,
  featuredOverCap,
  featuredSchema,
  pgErrorCode,
  reorderCategoriesSchema,
  sameIdSet,
  serializeCategory,
  serializeTag,
  teamShortcutsSchema,
  updateCategorySchema,
  updateTagSchema,
  validationMessage,
  type CategoryRow,
  type TagRow
} from "../lib/kb-library.js";
import { documentVisibleSql, uuidArray } from "../lib/kb-library-sql.js";
import { libraryOrganizeLimit } from "../lib/security/route-rate-limit.js";

/**
 * Source library organization: categories (nested, many-to-many with
 * documents), tags, and team pins. Manager+ and never demo accounts; the
 * personal pin and note live on the CSR-facing kbRouter instead. The one
 * exception is PUT /team-shortcuts, a supervisor's own list for their team
 * (supervisors only, never demo accounts).
 *
 * Program scoping is a security boundary. Every statement filters by the
 * effective program, unknown or cross-program ids return 404, and the 0003
 * triggers refuse any row that would link two programs. Documents must be
 * visible to the acting manager (active version within clearance) to be
 * placed anywhere. Replace-style writes remove only documents the manager
 * can see and left out; rows for documents the manager can't see right now
 * (above clearance, or not live) are kept, so nothing is dropped unseen.
 *
 * Every mutation takes a per-program advisory lock (structure checks such as
 * sibling order and nesting depth stay consistent under concurrent edits) and
 * appends one security event as the last statement of the same transaction.
 */
export const kbLibraryRouter = Router();

kbLibraryRouter.use(requireAuth, requireFreshPassword);
// A supervisor's own team list is the one route below manager. It is
// registered ahead of the manager+ guard so supervisors can reach it.
kbLibraryRouter.put(
  "/team-shortcuts",
  requireTeamPinner,
  blockDemoWrites,
  libraryOrganizeLimit,
  libraryRoute(putTeamShortcuts)
);
kbLibraryRouter.use(requireManagerOrAbove, blockDemoWrites);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

class LibraryError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const notFound = () => new LibraryError(404, "Not found");

interface LibraryContext {
  req: Request;
  user: CurrentUser;
  programId: string;
  clearance: Classification;
}

/**
 * Shared guard + error mapping. `conflict` turns a database refusal into a
 * plain 409 message for the route's object type.
 */
function libraryRoute(
  handler: (ctx: LibraryContext, res: Response) => Promise<void>,
  conflict: (err: unknown) => string | null = () => null
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = authedUser(req);
      const programId = await resolveEffectiveProgramId(user, req);
      if (programId === null) {
        res.status(400).json({ error: "No program selected." });
        return;
      }
      if (!canAccessProgram(user, programId)) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const clearance = await getUserMaxClassification(user.id);
      await handler({ req, user, programId, clearance }, res);
    } catch (err) {
      if (err instanceof LibraryError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      const message = conflict(err);
      if (message) {
        res.status(409).json({ error: message });
        return;
      }
      // A referenced row vanished mid-request (concurrent delete).
      if (pgErrorCode(err) === "23503") {
        res.status(404).json({ error: "Not found" });
        return;
      }
      next(err);
    }
  };
}

function pathId(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !UUID_RE.test(value)) throw notFound();
  return value.toLowerCase();
}

function parseBody<S extends ZodTypeAny>(
  schema: S,
  body: unknown,
  fallback: string
): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new LibraryError(400, validationMessage(parsed.error, fallback));
  }
  return parsed.data;
}

async function lockLibrary(tx: Tx, programId: string): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtext(${`kb_library:${programId}`}))
  `);
}

async function audit(
  tx: Tx,
  ctx: LibraryContext,
  res: Response,
  action: string,
  resourceType: string,
  resourceId: string | null,
  details: Record<string, unknown>
): Promise<void> {
  const requestId = res.getHeader("X-Request-Id");
  await appendSecurityEvent(
    {
      action,
      outcome: "success",
      actor: ctx.user,
      programId: ctx.programId,
      resourceType,
      resourceId,
      requestId: typeof requestId === "string" ? requestId : null,
      sourceIp: clientIpFrom(ctx.req),
      details
    },
    tx as unknown as Parameters<typeof appendSecurityEvent>[1]
  );
}

async function loadCategory(
  tx: Tx,
  ctx: LibraryContext,
  categoryId: string
) {
  const result = await tx.execute(sql`
    SELECT
      c.id::text,
      c.parent_id::text,
      c.name,
      c.color,
      p.color AS my_color,
      c.position
    FROM kb_categories AS c
    LEFT JOIN kb_category_user_prefs AS p
      ON p.category_id = c.id AND p.user_id = ${ctx.user.id}::uuid
    WHERE c.id = ${categoryId}::uuid
      AND c.program_id = ${ctx.programId}::uuid
  `);
  const row = result.rows[0] as unknown as CategoryRow | undefined;
  if (!row) throw notFound();
  const members = await tx.execute(sql`
    SELECT cd.document_id::text AS document_id
    FROM kb_category_documents AS cd
    WHERE cd.category_id = ${categoryId}::uuid
      AND ${documentVisibleSql(sql.raw("cd.document_id"), ctx.programId, ctx.clearance)}
    ORDER BY cd.position, cd.added_at, cd.document_id
  `);
  return serializeCategory(
    row,
    (members.rows as Array<{ document_id: string }>).map((m) => m.document_id)
  );
}

async function requireCategory(
  tx: Tx,
  programId: string,
  categoryId: string
): Promise<{ id: string; parent_id: string | null; name: string }> {
  const result = await tx.execute(sql`
    SELECT id::text, parent_id::text, name
    FROM kb_categories
    WHERE id = ${categoryId}::uuid
      AND program_id = ${programId}::uuid
    FOR UPDATE
  `);
  const row = result.rows[0] as
    | { id: string; parent_id: string | null; name: string }
    | undefined;
  if (!row) throw notFound();
  return row;
}

async function requireVisibleDocuments(
  tx: Tx,
  ctx: LibraryContext,
  documentIds: string[]
): Promise<void> {
  if (documentIds.length === 0) return;
  const result = await tx.execute(sql`
    SELECT count(*)::int AS count
    FROM unnest(${uuidArray(documentIds)}) AS t(id)
    WHERE ${documentVisibleSql(sql.raw("t.id"), ctx.programId, ctx.clearance)}
  `);
  const count = Number((result.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
  if (count !== documentIds.length) throw notFound();
}

async function requireProgramRows(
  tx: Tx,
  table: "kb_categories" | "kb_tags",
  programId: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  const result = await tx.execute(sql`
    SELECT count(*)::int AS count
    FROM ${sql.raw(table)}
    WHERE id = ANY(${uuidArray(ids)})
      AND program_id = ${programId}::uuid
  `);
  const count = Number((result.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
  if (count !== ids.length) throw notFound();
}

/** Next sibling position under `parentId` (null = top level). */
function nextSiblingPosition(programId: string, parentId: string | null, excludeId?: string): SQL {
  return sql`(
    SELECT COALESCE(max(position) + 1, 0)
    FROM kb_categories
    WHERE program_id = ${programId}::uuid
      AND parent_id IS NOT DISTINCT FROM ${parentId}::uuid
      ${excludeId ? sql`AND id <> ${excludeId}::uuid` : sql``}
  )`;
}

// Categories

kbLibraryRouter.post(
  "/categories",
  libraryOrganizeLimit,
  libraryRoute(async (ctx, res) => {
    const body = parseBody(createCategorySchema, ctx.req.body, "Enter a category name.");
    const parentId = body.parentId ? body.parentId.toLowerCase() : null;
    const item = await db.transaction(async (tx) => {
      await lockLibrary(tx, ctx.programId);
      if (parentId) await requireCategory(tx, ctx.programId, parentId);
      const inserted = await tx.execute(sql`
        INSERT INTO kb_categories (program_id, parent_id, name, color, position, created_by)
        VALUES (
          ${ctx.programId}::uuid,
          ${parentId}::uuid,
          ${body.name},
          ${body.color ?? "slate"},
          ${nextSiblingPosition(ctx.programId, parentId)},
          ${ctx.user.id}::uuid
        )
        RETURNING id::text
      `);
      const id = (inserted.rows[0] as { id: string } | undefined)?.id;
      if (!id) throw new Error("Category insert returned no row");
      const created = await loadCategory(tx, ctx, id);
      await audit(tx, ctx, res, "kb.library.category.create", "kb_category", id, {
        name: body.name,
        parentId
      });
      return created;
    });
    res.status(201).json({ item });
  }, categoryConflictMessage)
);

// Registered before "/categories/:id" routes for readability; the methods
// differ (PUT here, PATCH/DELETE there) so Express never confuses them.
kbLibraryRouter.put(
  "/categories/order",
  libraryOrganizeLimit,
  libraryRoute(async (ctx, res) => {
    const body = parseBody(
      reorderCategoriesSchema,
      ctx.req.body,
      "Send the parent and the new order."
    );
    const parentId = body.parentId ? body.parentId.toLowerCase() : null;
    await db.transaction(async (tx) => {
      await lockLibrary(tx, ctx.programId);
      if (parentId) await requireCategory(tx, ctx.programId, parentId);
      const siblings = await tx.execute(sql`
        SELECT id::text
        FROM kb_categories
        WHERE program_id = ${ctx.programId}::uuid
          AND parent_id IS NOT DISTINCT FROM ${parentId}::uuid
      `);
      const siblingIds = (siblings.rows as Array<{ id: string }>).map((r) => r.id);
      if (!sameIdSet(siblingIds, body.orderedIds)) {
        throw new LibraryError(
          400,
          "The order must list every category at this level exactly once. Reload and try again."
        );
      }
      if (body.orderedIds.length > 0) {
        await tx.execute(sql`
          UPDATE kb_categories AS c
          SET position = (t.ord - 1)::int, updated_at = now()
          FROM unnest(${uuidArray(body.orderedIds)}) WITH ORDINALITY AS t(id, ord)
          WHERE c.id = t.id
            AND c.program_id = ${ctx.programId}::uuid
        `);
      }
      await audit(tx, ctx, res, "kb.library.category.reorder", "kb_category", parentId, {
        parentId,
        orderedIds: body.orderedIds
      });
    });
    res.json({ ok: true });
  })
);

kbLibraryRouter.patch(
  "/categories/:id",
  libraryOrganizeLimit,
  libraryRoute(async (ctx, res) => {
    const categoryId = pathId(ctx.req, "id");
    const body = parseBody(updateCategorySchema, ctx.req.body, "Nothing to change.");
    const item = await db.transaction(async (tx) => {
      await lockLibrary(tx, ctx.programId);
      const current = await requireCategory(tx, ctx.programId, categoryId);
      const newParent =
        body.parentId === undefined ? undefined : body.parentId ? body.parentId.toLowerCase() : null;
      const move = newParent !== undefined && newParent !== current.parent_id;
      if (move) await checkMove(tx, ctx.programId, categoryId, newParent);
      await tx.execute(sql`
        UPDATE kb_categories
        SET name = COALESCE(${body.name ?? null}::text, name),
            color = COALESCE(${body.color ?? null}::text, color),
            parent_id = ${move ? sql`${newParent}::uuid` : sql`parent_id`},
            position = ${move ? nextSiblingPosition(ctx.programId, newParent, categoryId) : sql`position`},
            updated_at = now()
        WHERE id = ${categoryId}::uuid
          AND program_id = ${ctx.programId}::uuid
      `);
      const updated = await loadCategory(tx, ctx, categoryId);
      await audit(tx, ctx, res, "kb.library.category.update", "kb_category", categoryId, {
        ...(body.name !== undefined ? { name: body.name, previousName: current.name } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(move ? { parentId: newParent, previousParentId: current.parent_id } : {})
      });
      return updated;
    });
    res.json({ item });
  }, categoryConflictMessage)
);

/**
 * Cycle and depth checks for moving a category with its whole subtree.
 * The trigger catches a cycle too, but only measures the moved row's own
 * depth, not the descendants that come along.
 */
async function checkMove(
  tx: Tx,
  programId: string,
  categoryId: string,
  newParent: string | null
): Promise<void> {
  const subtree = await tx.execute(sql`
    WITH RECURSIVE sub AS (
      SELECT id, 1 AS lvl
      FROM kb_categories
      WHERE id = ${categoryId}::uuid AND program_id = ${programId}::uuid
      UNION ALL
      SELECT c.id, sub.lvl + 1
      FROM kb_categories AS c
      INNER JOIN sub ON c.parent_id = sub.id
      WHERE sub.lvl < 16
    )
    SELECT
      max(lvl)::int AS height,
      COALESCE(bool_or(id = ${newParent}::uuid), false) AS contains_parent
    FROM sub
  `);
  const sub = subtree.rows[0] as { height: number | null; contains_parent: boolean } | undefined;
  if (sub?.contains_parent) throw new LibraryError(409, CATEGORY_CYCLE_MESSAGE);
  let parentDepth = 0;
  if (newParent) {
    await requireCategory(tx, programId, newParent);
    const up = await tx.execute(sql`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, 1 AS lvl
        FROM kb_categories
        WHERE id = ${newParent}::uuid AND program_id = ${programId}::uuid
        UNION ALL
        SELECT c.id, c.parent_id, up.lvl + 1
        FROM kb_categories AS c
        INNER JOIN up ON c.id = up.parent_id
        WHERE up.lvl < 16
      )
      SELECT max(lvl)::int AS depth FROM up
    `);
    parentDepth = Number((up.rows[0] as { depth?: unknown } | undefined)?.depth ?? 0);
  }
  if (!canNestAt(parentDepth, Number(sub?.height ?? 1))) {
    throw new LibraryError(409, CATEGORY_DEPTH_MESSAGE);
  }
}

kbLibraryRouter.delete(
  "/categories/:id",
  libraryOrganizeLimit,
  libraryRoute(
    async (ctx, res) => {
      const categoryId = pathId(ctx.req, "id");
      await db.transaction(async (tx) => {
        await lockLibrary(tx, ctx.programId);
        const current = await requireCategory(tx, ctx.programId, categoryId);
        // Free the name first: a child may share it and is about to move
        // to this category's level. The row is deleted below.
        await tx.execute(sql`
          UPDATE kb_categories SET name = id::text WHERE id = ${categoryId}::uuid
        `);
        // Children move up to this category's parent, appended in their
        // current order. Must happen before the DELETE: parent_id cascades.
        const moved = await tx.execute(sql`
          WITH base AS (
            SELECT ${nextSiblingPosition(ctx.programId, current.parent_id, categoryId)} AS start
          ),
          kids AS (
            SELECT id, (row_number() OVER (ORDER BY position, lower(name), id) - 1)::int AS rn
            FROM kb_categories
            WHERE parent_id = ${categoryId}::uuid
              AND program_id = ${ctx.programId}::uuid
          )
          UPDATE kb_categories AS c
          SET parent_id = ${current.parent_id}::uuid,
              position = base.start + kids.rn,
              updated_at = now()
          FROM base, kids
          WHERE c.id = kids.id
          RETURNING c.id
        `);
        await tx.execute(sql`
          DELETE FROM kb_categories
          WHERE id = ${categoryId}::uuid
            AND program_id = ${ctx.programId}::uuid
        `);
        await audit(tx, ctx, res, "kb.library.category.delete", "kb_category", categoryId, {
          name: current.name,
          parentId: current.parent_id,
          movedChildren: moved.rows.length
        });
      });
      res.json({ ok: true });
    },
    (err) =>
      pgErrorCode(err) === "23505"
        ? "A subcategory has the same name as a category at the level it would move to. Rename one of them first."
        : categoryConflictMessage(err)
  )
);

kbLibraryRouter.put(
  "/categories/:id/documents",
  libraryOrganizeLimit,
  libraryRoute(async (ctx, res) => {
    const categoryId = pathId(ctx.req, "id");
    const { documentIds } = parseBody(
      categoryDocumentsSchema,
      ctx.req.body,
      "Send the list of sources for this category."
    );
    const item = await db.transaction(async (tx) => {
      await lockLibrary(tx, ctx.programId);
      await requireCategory(tx, ctx.programId, categoryId);
      await requireVisibleDocuments(tx, ctx, documentIds);
      const ids = uuidArray(documentIds);
      await tx.execute(sql`
        DELETE FROM kb_category_documents AS cd
        WHERE cd.category_id = ${categoryId}::uuid
          AND cd.document_id <> ALL(${ids})
          AND ${documentVisibleSql(sql.raw("cd.document_id"), ctx.programId, ctx.clearance)}
      `);
      if (documentIds.length > 0) {
        await tx.execute(sql`
          INSERT INTO kb_category_documents (category_id, document_id, position, added_by)
          SELECT ${categoryId}::uuid, t.id, (t.ord - 1)::int, ${ctx.user.id}::uuid
          FROM unnest(${ids}) WITH ORDINALITY AS t(id, ord)
          ON CONFLICT (category_id, document_id) DO UPDATE
          SET position = EXCLUDED.position
        `);
      }
      // Members kept because this manager can't see them (above clearance,
      // or not live) go after the new list, in their previous order.
      await tx.execute(sql`
        UPDATE kb_category_documents AS cd
        SET position = ${documentIds.length} + kept.rn
        FROM (
          SELECT document_id,
            (row_number() OVER (ORDER BY position, added_at, document_id) - 1)::int AS rn
          FROM kb_category_documents
          WHERE category_id = ${categoryId}::uuid
            AND document_id <> ALL(${ids})
        ) AS kept
        WHERE cd.category_id = ${categoryId}::uuid
          AND cd.document_id = kept.document_id
      `);
      const members = await loadCategory(tx, ctx, categoryId);
      await audit(tx, ctx, res, "kb.library.category.members", "kb_category", categoryId, {
        documentIds
      });
      return members;
    });
    res.json({ item });
  })
);

// Per-document memberships

kbLibraryRouter.put(
  "/documents/:id/categories",
  libraryOrganizeLimit,
  libraryRoute(async (ctx, res) => {
    const documentId = pathId(ctx.req, "id");
    const { categoryIds } = parseBody(
      documentCategoriesSchema,
      ctx.req.body,
      "Send the list of categories for this source."
    );
    await db.transaction(async (tx) => {
      await lockLibrary(tx, ctx.programId);
      await requireVisibleDocuments(tx, ctx, [documentId]);
      await requireProgramRows(tx, "kb_categories", ctx.programId, categoryIds);
      const ids = uuidArray(categoryIds);
      await tx.execute(sql`
        DELETE FROM kb_category_documents AS cd
        USING kb_categories AS c
        WHERE cd.document_id = ${documentId}::uuid
          AND c.id = cd.category_id
          AND c.program_id = ${ctx.programId}::uuid
          AND cd.category_id <> ALL(${ids})
      `);
      if (categoryIds.length > 0) {
        // Existing memberships keep their position; new ones append.
        await tx.execute(sql`
          INSERT INTO kb_category_documents (category_id, document_id, position, added_by)
          SELECT
            c.id,
            ${documentId}::uuid,
            COALESCE((
              SELECT max(x.position) + 1
              FROM kb_category_documents AS x
              WHERE x.category_id = c.id
            ), 0),
            ${ctx.user.id}::uuid
          FROM kb_categories AS c
          WHERE c.id = ANY(${ids})
            AND c.program_id = ${ctx.programId}::uuid
          ON CONFLICT (category_id, document_id) DO NOTHING
        `);
      }
      await audit(tx, ctx, res, "kb.library.document.categories", "document", documentId, {
        categoryIds
      });
    });
    res.json({ ok: true });
  })
);

kbLibraryRouter.put(
  "/documents/:id/tags",
  libraryOrganizeLimit,
  libraryRoute(async (ctx, res) => {
    const documentId = pathId(ctx.req, "id");
    const { tagIds } = parseBody(
      documentTagsSchema,
      ctx.req.body,
      "Send the list of tags for this source."
    );
    await db.transaction(async (tx) => {
      await lockLibrary(tx, ctx.programId);
      await requireVisibleDocuments(tx, ctx, [documentId]);
      await requireProgramRows(tx, "kb_tags", ctx.programId, tagIds);
      const ids = uuidArray(tagIds);
      await tx.execute(sql`
        DELETE FROM kb_document_tags AS dt
        USING kb_tags AS t
        WHERE dt.document_id = ${documentId}::uuid
          AND t.id = dt.tag_id
          AND t.program_id = ${ctx.programId}::uuid
          AND dt.tag_id <> ALL(${ids})
      `);
      if (tagIds.length > 0) {
        await tx.execute(sql`
          INSERT INTO kb_document_tags (tag_id, document_id)
          SELECT t.id, ${documentId}::uuid
          FROM kb_tags AS t
          WHERE t.id = ANY(${ids})
            AND t.program_id = ${ctx.programId}::uuid
          ON CONFLICT (tag_id, document_id) DO NOTHING
        `);
      }
      await audit(tx, ctx, res, "kb.library.document.tags", "document", documentId, {
        tagIds
      });
    });
    res.json({ ok: true });
  })
);

// Tags

const tagConflict = (err: unknown) =>
  pgErrorCode(err) === "23505" ? TAG_NAME_TAKEN_MESSAGE : null;

kbLibraryRouter.post(
  "/tags",
  libraryOrganizeLimit,
  libraryRoute(async (ctx, res) => {
    const body = parseBody(createTagSchema, ctx.req.body, "Enter a tag name.");
    const item = await db.transaction(async (tx) => {
      await lockLibrary(tx, ctx.programId);
      const inserted = await tx.execute(sql`
        INSERT INTO kb_tags (program_id, name, color, created_by)
        VALUES (
          ${ctx.programId}::uuid,
          ${body.name},
          ${body.color ?? "slate"},
          ${ctx.user.id}::uuid
        )
        RETURNING id::text, name, color
      `);
      const row = inserted.rows[0] as unknown as TagRow | undefined;
      if (!row) throw new Error("Tag insert returned no row");
      await audit(tx, ctx, res, "kb.library.tag.create", "kb_tag", row.id, {
        name: row.name
      });
      return serializeTag(row);
    });
    res.status(201).json({ item });
  }, tagConflict)
);

kbLibraryRouter.patch(
  "/tags/:id",
  libraryOrganizeLimit,
  libraryRoute(async (ctx, res) => {
    const tagId = pathId(ctx.req, "id");
    const body = parseBody(updateTagSchema, ctx.req.body, "Nothing to change.");
    const item = await db.transaction(async (tx) => {
      await lockLibrary(tx, ctx.programId);
      const updated = await tx.execute(sql`
        UPDATE kb_tags
        SET name = COALESCE(${body.name ?? null}::text, name),
            color = COALESCE(${body.color ?? null}::text, color)
        WHERE id = ${tagId}::uuid
          AND program_id = ${ctx.programId}::uuid
        RETURNING id::text, name, color
      `);
      const row = updated.rows[0] as unknown as TagRow | undefined;
      if (!row) throw notFound();
      await audit(tx, ctx, res, "kb.library.tag.update", "kb_tag", tagId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.color !== undefined ? { color: body.color } : {})
      });
      return serializeTag(row);
    });
    res.json({ item });
  }, tagConflict)
);

kbLibraryRouter.delete(
  "/tags/:id",
  libraryOrganizeLimit,
  libraryRoute(async (ctx, res) => {
    const tagId = pathId(ctx.req, "id");
    await db.transaction(async (tx) => {
      await lockLibrary(tx, ctx.programId);
      const deleted = await tx.execute(sql`
        DELETE FROM kb_tags
        WHERE id = ${tagId}::uuid
          AND program_id = ${ctx.programId}::uuid
        RETURNING name
      `);
      const row = deleted.rows[0] as { name: string } | undefined;
      if (!row) throw notFound();
      await audit(tx, ctx, res, "kb.library.tag.delete", "kb_tag", tagId, {
        name: row.name
      });
    });
    res.json({ ok: true });
  })
);

// Team pins

kbLibraryRouter.put(
  "/featured",
  libraryOrganizeLimit,
  libraryRoute(async (ctx, res) => {
    const { documentIds } = parseBody(
      featuredSchema,
      ctx.req.body,
      "Send the list of sources to pin for the team."
    );
    await db.transaction(async (tx) => {
      await lockLibrary(tx, ctx.programId);
      await requireVisibleDocuments(tx, ctx, documentIds);
      const ids = uuidArray(documentIds);
      await tx.execute(sql`
        DELETE FROM kb_source_featured AS f
        WHERE f.program_id = ${ctx.programId}::uuid
          AND f.document_id <> ALL(${ids})
          AND ${documentVisibleSql(sql.raw("f.document_id"), ctx.programId, ctx.clearance)}
      `);
      if (documentIds.length > 0) {
        await tx.execute(sql`
          INSERT INTO kb_source_featured (document_id, program_id, position, featured_by)
          SELECT t.id, ${ctx.programId}::uuid, (t.ord - 1)::int, ${ctx.user.id}::uuid
          FROM unnest(${ids}) WITH ORDINALITY AS t(id, ord)
          ON CONFLICT (document_id) DO UPDATE
          SET position = EXCLUDED.position
        `);
      }
      await tx.execute(sql`
        UPDATE kb_source_featured AS f
        SET position = ${documentIds.length} + kept.rn
        FROM (
          SELECT document_id,
            (row_number() OVER (ORDER BY position, featured_at, document_id) - 1)::int AS rn
          FROM kb_source_featured
          WHERE program_id = ${ctx.programId}::uuid
            AND document_id <> ALL(${ids})
        ) AS kept
        WHERE f.document_id = kept.document_id
      `);
      // Kept rows for sources this manager can't see count toward the cap
      // too. Throwing rolls the whole replace back.
      const total = await tx.execute(sql`
        SELECT count(*)::int AS count
        FROM kb_source_featured
        WHERE program_id = ${ctx.programId}::uuid
      `);
      if (featuredOverCap(Number((total.rows[0] as { count?: unknown } | undefined)?.count ?? 0))) {
        throw new LibraryError(400, FEATURED_LIMIT_MESSAGE);
      }
      await audit(tx, ctx, res, "kb.library.featured.set", "kb_featured", null, {
        documentIds
      });
    });
    res.json({ ok: true });
  })
);

// Team shortcuts: a supervisor's recommended list for their own team.
// Mounted near the top of the file, ahead of the manager+ guard.

function requireTeamPinner(req: Request, res: Response, next: NextFunction): void {
  if (!canPinForTeam(authedUser(req).role)) {
    res.status(403).json({ error: "Only supervisors can recommend sources to a team." });
    return;
  }
  next();
}

/**
 * Replaces the acting supervisor's own list, like /featured replaces the
 * program's: other supervisors' rows are never touched, and the actor's rows
 * for sources they can't see right now are kept and count toward the cap.
 */
async function putTeamShortcuts(ctx: LibraryContext, res: Response): Promise<void> {
  const { documentIds } = parseBody(
    teamShortcutsSchema,
    ctx.req.body,
    "Send the list of sources to recommend to your team."
  );
  await db.transaction(async (tx) => {
    await lockLibrary(tx, ctx.programId);
    await requireVisibleDocuments(tx, ctx, documentIds);
    const ids = uuidArray(documentIds);
    await tx.execute(sql`
      DELETE FROM kb_team_shortcuts AS t
      WHERE t.supervisor_user_id = ${ctx.user.id}::uuid
        AND t.program_id = ${ctx.programId}::uuid
        AND t.document_id <> ALL(${ids})
        AND ${documentVisibleSql(sql.raw("t.document_id"), ctx.programId, ctx.clearance)}
    `);
    if (documentIds.length > 0) {
      await tx.execute(sql`
        INSERT INTO kb_team_shortcuts (supervisor_user_id, document_id, program_id, position)
        SELECT ${ctx.user.id}::uuid, t.id, ${ctx.programId}::uuid, (t.ord - 1)::int
        FROM unnest(${ids}) WITH ORDINALITY AS t(id, ord)
        ON CONFLICT (supervisor_user_id, document_id) DO UPDATE
        SET position = EXCLUDED.position
      `);
    }
    await tx.execute(sql`
      UPDATE kb_team_shortcuts AS t
      SET position = ${documentIds.length} + kept.rn
      FROM (
        SELECT document_id,
          (row_number() OVER (ORDER BY position, pinned_at, document_id) - 1)::int AS rn
        FROM kb_team_shortcuts
        WHERE supervisor_user_id = ${ctx.user.id}::uuid
          AND program_id = ${ctx.programId}::uuid
          AND document_id <> ALL(${ids})
      ) AS kept
      WHERE t.supervisor_user_id = ${ctx.user.id}::uuid
        AND t.document_id = kept.document_id
    `);
    const total = await tx.execute(sql`
      SELECT count(*)::int AS count
      FROM kb_team_shortcuts
      WHERE supervisor_user_id = ${ctx.user.id}::uuid
        AND program_id = ${ctx.programId}::uuid
    `);
    if (featuredOverCap(Number((total.rows[0] as { count?: unknown } | undefined)?.count ?? 0))) {
      throw new LibraryError(400, FEATURED_LIMIT_MESSAGE);
    }
    await audit(tx, ctx, res, "kb.library.team_shortcuts.set", "kb_team_shortcuts", null, {
      documentIds
    });
  });
  res.json({ ok: true });
}
