import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../lib/db-client.js";
import {
  authedUser,
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove
} from "../../middleware/current-user.js";
import { canAccessProgram } from "../../lib/auth/current-user.js";
import { resolveEffectiveProgramId } from "../../lib/auth/effective-program.js";

export const insightsRouter = Router();

/**
 * KB-gap mining: the AGGREGATED read side of the query_log feedback loop.
 *
 * Every refusal, thumbs-down, and CSR "the KB should have had this" flag is
 * a data point telling admins which SOP to write next. This endpoint groups
 * those signals per normalized question over a trailing window so the
 * Content-gaps page's "Top gaps" section can rank gaps by evidence, not
 * anecdote. Its row-level sibling is /api/admin/queries (routes/admin/
 * queries.ts), which feeds the same page's "Review queue" section — two
 * shapes, one surface.
 */
insightsRouter.use(requireAuth, requireFreshPassword, requireManagerOrAbove);

export interface KbGapItem {
  question: string;
  askCount: number;
  refusedCount: number;
  flaggedCount: number;
  negativeCount: number;
  lastAskedAt: string;
}

export interface KbGapsResponse {
  items: KbGapItem[];
  windowDays: number;
  /** Window-wide context so gap counts read against total traffic. */
  totals: {
    queries: number;
    refused: number;
    flaggedMissing: number;
    negativeFeedback: number;
  };
  noProgramSelected?: boolean;
}

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const MAX_ITEMS = 50;

interface GapRow {
  question: string;
  ask_count: number;
  refused_count: number;
  flagged_count: number;
  negative_count: number;
  last_asked_at: Date | string;
}

interface TotalsRow {
  queries: number;
  refused: number;
  flagged_missing: number;
  negative_feedback: number;
}

insightsRouter.get("/kb-gaps", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      // Same sentinel contract as /api/documents: super_user without a
      // picker selection gets an empty payload the UI can prompt on.
      const empty: KbGapsResponse = {
        items: [],
        windowDays: DEFAULT_WINDOW_DAYS,
        totals: { queries: 0, refused: 0, flaggedMissing: 0, negativeFeedback: 0 },
        noProgramSelected: true
      };
      res.json(empty);
      return;
    }
    if (!canAccessProgram(user, programId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const rawDays = Number.parseInt(String(req.query["days"] ?? ""), 10);
    const windowDays = Number.isFinite(rawDays)
      ? Math.min(Math.max(rawDays, 1), MAX_WINDOW_DAYS)
      : DEFAULT_WINDOW_DAYS;

    // Group by normalized question text: CSRs retype the same question with
    // different casing/whitespace mid-call; each variant is the same gap.
    const gapResult = await db.execute(sql`
      SELECT
        min(question)                                    AS question,
        count(*)::int                                    AS ask_count,
        count(*) FILTER (WHERE refused)::int             AS refused_count,
        count(*) FILTER (WHERE flagged_missing)::int     AS flagged_count,
        count(*) FILTER (WHERE feedback = -1)::int       AS negative_count,
        max(created_at)                                  AS last_asked_at
      FROM query_log
      WHERE program_id = ${programId}::uuid
        AND created_at > now() - make_interval(days => ${windowDays})
        AND (refused = true OR flagged_missing = true OR feedback = -1)
      GROUP BY lower(btrim(question))
      ORDER BY
        count(*) FILTER (WHERE flagged_missing) DESC,
        count(*) DESC,
        max(created_at) DESC
      LIMIT ${MAX_ITEMS}
    `);
    const gapRows = gapResult.rows as unknown as GapRow[];

    const totalsResult = await db.execute(sql`
      SELECT
        count(*)::int                                    AS queries,
        count(*) FILTER (WHERE refused)::int             AS refused,
        count(*) FILTER (WHERE flagged_missing)::int     AS flagged_missing,
        count(*) FILTER (WHERE feedback = -1)::int       AS negative_feedback
      FROM query_log
      WHERE program_id = ${programId}::uuid
        AND created_at > now() - make_interval(days => ${windowDays})
    `);
    const totals = (totalsResult.rows[0] ?? {
      queries: 0,
      refused: 0,
      flagged_missing: 0,
      negative_feedback: 0
    }) as unknown as TotalsRow;

    const payload: KbGapsResponse = {
      items: gapRows.map((r) => ({
        question: r.question,
        askCount: r.ask_count,
        refusedCount: r.refused_count,
        flaggedCount: r.flagged_count,
        negativeCount: r.negative_count,
        lastAskedAt: new Date(r.last_asked_at).toISOString()
      })),
      windowDays,
      totals: {
        queries: totals.queries,
        refused: totals.refused,
        flaggedMissing: totals.flagged_missing,
        negativeFeedback: totals.negative_feedback
      }
    };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});
