import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/db-client.js";
import { queryLog } from "@workspace/db/schema";
import {
  authedUser,
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove
} from "../../middleware/current-user.js";
import { resolveEffectiveProgramId } from "../../lib/auth/effective-program.js";

export const queriesRouter = Router();

queriesRouter.use(requireAuth, requireFreshPassword, requireManagerOrAbove);

/**
 * The content-gaps read side. CSRs write signals from chat (flag-missing,
 * feedback, refusals logged by the ask pipeline); this endpoint is where
 * admins finally get to SEE them — the refusal card's "admins will review
 * this gap" promise is honored here.
 */

const FILTER_VALUES = ["flagged", "refused", "negative", "all"] as const;
export type QueryLogFilter = (typeof FILTER_VALUES)[number];

const ListQuery = z.object({
  filter: z.enum(FILTER_VALUES).default("flagged"),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

export interface QueryLogItem {
  id: string;
  question: string;
  refused: boolean;
  flaggedMissing: boolean;
  feedback: number | null;
  latencyMs: number | null;
  programId: string | null;
  createdAt: string | null;
}

/**
 * GET /api/admin/queries — list query-log rows for gap review.
 *
 * Scope (same contract as GET /api/admin/users):
 *   super_user      → all programs, narrowed by X-Program-Id when present.
 *   senior_manager  → own program.
 *   manager         → own program.
 *   csr             → blocked at the router level.
 *
 * Filters:
 *   flagged  (default) → rows a CSR explicitly flagged as missing content
 *   refused            → every refusal, flagged or not
 *   negative           → thumbs-down answers
 *   all                → everything, newest first
 *
 * The answer text is intentionally NOT returned: refusal answers are a
 * canned string, and non-refused answers can be long — the reviewer's
 * unit of work is the question. Row cap 200.
 */
queriesRouter.get("/", async (req, res, next) => {
  try {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters" });
      return;
    }
    const { filter, limit } = parsed.data;
    const actor = authedUser(req);
    const scopeProgramId = await resolveEffectiveProgramId(actor, req);

    const scopeCondition =
      actor.role === "super_user"
        ? scopeProgramId === null
          ? undefined
          : eq(queryLog.programId, scopeProgramId)
        : // Non-super_user: programId is non-null by DB CHECK.
          eq(queryLog.programId, actor.programId as string);

    const filterCondition =
      filter === "flagged"
        ? eq(queryLog.flaggedMissing, true)
        : filter === "refused"
          ? eq(queryLog.refused, true)
          : filter === "negative"
            ? eq(queryLog.feedback, -1)
            : undefined;

    const rows = await db
      .select({
        id: queryLog.id,
        question: queryLog.question,
        refused: queryLog.refused,
        flaggedMissing: queryLog.flaggedMissing,
        feedback: queryLog.feedback,
        latencyMs: queryLog.latencyMs,
        programId: queryLog.programId,
        createdAt: queryLog.createdAt
      })
      .from(queryLog)
      .where(and(scopeCondition, filterCondition))
      .orderBy(desc(queryLog.createdAt))
      .limit(limit);

    const items: QueryLogItem[] = rows.map((row) => ({
      id: row.id,
      question: row.question,
      refused: row.refused === true,
      flaggedMissing: row.flaggedMissing === true,
      feedback: row.feedback,
      latencyMs: row.latencyMs,
      programId: row.programId,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null
    }));

    res.json({ items });
  } catch (err) {
    next(err);
  }
});
