import { Router } from "express";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../../lib/db-client.js";
import {
  authedUser,
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove
} from "../../middleware/current-user.js";
import { canAccessProgram, type UserRole } from "../../lib/auth/current-user.js";
import { resolveEffectiveProgramId } from "../../lib/auth/effective-program.js";
import {
  classificationRank,
  getUserMaxClassification,
  parseClassification,
  type Classification
} from "../../lib/security/classification.js";
import { isoOrNull } from "../../lib/kb-library.js";
import {
  documentIsLiveSql,
  documentTitleVisibleSql,
  documentVisibleSql,
  snapshotsArraySql
} from "../../lib/kb-library-sql.js";
import {
  MAX_MATRIX_SOURCES,
  MAX_SOURCE_SUGGESTIONS,
  MAX_TOP_SOURCES_PER_USER,
  MAX_USAGE_SOURCES,
  gatedTitle,
  normalizeFeedback,
  parseOptionalUuid,
  parseQuestionLimit,
  parseUsageWindowDays,
  selectSourceSuggestions,
  shapeUsageMatrix,
  takePage,
  type SourceUsageSuggestion,
  type UsageMatrix
} from "../../lib/source-usage.js";

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

/**
 * Source usage: which sources answers cite, which questions hit them, and
 * who asked. Feeds the manager-facing Source usage page (coaching and
 * training). Counts come from query_log.citation_snapshots, deduplicated per
 * answer, so one answer quoting three excerpts of a document counts once.
 *
 * Program-scoped like kb-gaps. Question text and asker names are visible to
 * manager+ by design; document titles follow the viewer's clearance and come
 * back as null ("Restricted source") when it is too low.
 */

export interface SourceUsageSource {
  documentId: string;
  title: string | null;
  isLive: boolean;
  citationCount: number;
  questionCount: number;
  userCount: number;
  viewCount: number;
  negativeCount: number;
  lastCitedAt: string | null;
}

export interface SourceUsageUser {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  questionCount: number;
  answeredCount: number;
  refusedCount: number;
  negativeCount: number;
  topSources: { documentId: string; title: string | null; count: number }[];
  lastAskedAt: string | null;
}

export interface SourceUsagePerson {
  userId: string;
  name: string;
  role: UserRole;
  questionCount: number;
}

export type SourceUsageMatrix = UsageMatrix;

export type { SourceUsageSuggestion };

export interface SourceUsageResponse {
  windowDays: number;
  /** Up to 3 suggestions for the selected person; empty when userId is null. */
  suggestions: SourceUsageSuggestion[];
  userId: string | null;
  person: { userId: string; name: string; email: string; role: UserRole } | null;
  people: SourceUsagePerson[];
  matrix: SourceUsageMatrix;
  totals: {
    questions: number;
    answered: number;
    refused: number;
    sourcesCited: number;
    sourcesNeverCited: number;
    activeUsers: number;
  };
  sources: SourceUsageSource[];
  users: SourceUsageUser[];
  noProgramSelected?: boolean;
}

export interface SourceUsageQuestion {
  queryLogId: string;
  question: string;
  askedAt: string;
  userId: string | null;
  userName: string | null;
  refused: boolean;
  feedback: number | null;
  sources: { documentId: string; title: string | null }[];
}

export interface SourceUsageQuestionsResponse {
  items: SourceUsageQuestion[];
  truncated: boolean;
  noProgramSelected?: boolean;
}

interface UsageFilter {
  programId: string;
  windowDays: number;
  userId: string | null;
}

/**
 * Window CTEs shared by the source-usage summary queries:
 *   q      query_log rows in the window (optionally one asker)
 *   cited  one row per (answer, cited document in this program)
 * Snapshots name documents by doc_id; ids that no longer resolve to a
 * document in this program (deleted documents) drop out here.
 */
function usageCtes(filter: UsageFilter): SQL {
  return sql`
    q AS (
      SELECT
        ql.id,
        ql.user_id,
        ql.question,
        -- Case, repeated spaces and trailing ?.! do not make a different
        -- question (used to match a refused question to teammates' answers).
        regexp_replace(
          regexp_replace(lower(btrim(ql.question)), '\\s+', ' ', 'g'),
          '[?.!\\s]+$',
          ''
        ) AS norm_question,
        COALESCE(ql.refused, false) AS refused,
        ql.feedback,
        ql.created_at,
        ${snapshotsArraySql(sql.raw("ql.citation_snapshots"))} AS snaps
      FROM query_log AS ql
      WHERE ql.program_id = ${filter.programId}::uuid
        AND ql.created_at > now() - make_interval(days => ${filter.windowDays})
        ${filter.userId ? sql`AND ql.user_id = ${filter.userId}` : sql``}
    ),
    cited AS (
      SELECT DISTINCT q.id AS query_id, d.id AS document_id
      FROM q
      CROSS JOIN LATERAL jsonb_array_elements(q.snaps) AS e(elem)
      INNER JOIN documents AS d
        ON d.id::text = lower(e.elem ->> 'doc_id')
       AND d.program_id = ${filter.programId}::uuid
    )
  `;
}

const ANSWERED = sql.raw("NOT refused AND jsonb_array_length(snaps) > 0");

/**
 * Resolve the optional ?userId= filter to the person's identity. The user
 * must belong to the effective program or have asked questions in it
 * (super users); anything else is a 404 so ids from other programs reveal
 * nothing. Membership does not depend on the window.
 */
async function resolveUsageUser(
  raw: unknown,
  programId: string
): Promise<SourceUsageResponse["person"] | "not_found"> {
  const parsed = parseOptionalUuid(raw);
  if (parsed === "invalid") return "not_found";
  if (parsed === null) return null;
  const result = await db.execute(sql`
    SELECT u.id::text AS user_id, u.name, u.email, u.role::text AS role
    FROM users AS u
    WHERE u.id = ${parsed}::uuid
      AND (
        u.program_id = ${programId}::uuid
        OR EXISTS (
          SELECT 1 FROM query_log AS ql
          WHERE ql.program_id = ${programId}::uuid
            AND ql.user_id = ${parsed}
        )
      )
    LIMIT 1
  `);
  const row = result.rows[0] as unknown as UsagePersonRow | undefined;
  if (!row) return "not_found";
  return { userId: row.user_id, name: row.name, email: row.email, role: row.role };
}

interface UsagePersonRow {
  user_id: string;
  name: string;
  email: string;
  role: UserRole;
}

interface UsagePeopleRow {
  user_id: string;
  name: string;
  role: UserRole;
  question_count: number;
}

interface UsageMatrixRow {
  document_ids: unknown;
  matrix_rows: unknown;
}

interface UsageTotalsRow {
  questions: number;
  answered: number;
  refused: number;
  active_users: number;
  sources_cited: number;
  sources_never_cited: number;
}

interface UsageSourceRow {
  document_id: string;
  title: string;
  title_visible: boolean;
  is_live: boolean;
  citation_count: number;
  question_count: number;
  user_count: number;
  view_count: number;
  negative_count: number;
  last_cited_at: Date | string | null;
}

interface UsageUserRow {
  user_id: string;
  name: string;
  email: string;
  role: UserRole;
  question_count: number;
  answered_count: number;
  refused_count: number;
  negative_count: number;
  last_asked_at: Date | string | null;
}

interface UsageTopSourceRow {
  user_id: string;
  document_id: string;
  title: string;
  title_visible: boolean;
  count: number;
}

/**
 * The selected person's clearance for suggestions. Unlike
 * getUserMaxClassification this accepts inactive accounts, and a missing or
 * invalid value falls back to the lowest level so nothing above it is named.
 */
async function personClearance(userId: string): Promise<Classification> {
  const result = await db.execute(sql`
    SELECT max_classification FROM users WHERE id = ${userId}::uuid LIMIT 1
  `);
  return parseClassification(result.rows[0]?.["max_classification"]) ?? "public";
}

interface UsageSuggestionRow {
  document_id: string;
  title: string;
  team_citations: number;
  last_cited_at: Date | string | null;
  related: boolean;
}

/**
 * Candidates for the selected person's "Suggest these sources" card, at most
 * MAX_SOURCE_SUGGESTIONS rows. A candidate is a document other people's
 * answers cited in the window that this person's answers never cited, and
 * that can be opened now (program, live version, and `clearance`, which the
 * caller sets to the lower of the viewer's and the person's). `related`
 * marks candidates sharing a top-level category with any source cited by
 * the person's thumbs-down answers, or by teammates' answers to the same
 * question as one of the person's refused answers. Related rows sort first, so
 * the LIMIT keeps them whenever any exist; selectSourceSuggestions then
 * applies the related-or-fallback rule.
 */
function suggestionsQuery(input: {
  programId: string;
  windowDays: number;
  userId: string;
  clearance: Classification;
}): SQL {
  const { programId, windowDays, userId, clearance } = input;
  return sql`
    WITH RECURSIVE ${usageCtes({ programId, windowDays, userId: null })},
    cat_root AS (
      SELECT c.id, c.id AS root_id
      FROM kb_categories AS c
      WHERE c.program_id = ${programId}::uuid
        AND c.parent_id IS NULL
      UNION ALL
      SELECT c.id, cr.root_id
      FROM kb_categories AS c
      INNER JOIN cat_root AS cr ON c.parent_id = cr.id
      WHERE c.program_id = ${programId}::uuid
    ),
    doc_root AS (
      SELECT DISTINCT cd.document_id, cr.root_id
      FROM kb_category_documents AS cd
      INNER JOIN cat_root AS cr ON cr.id = cd.category_id
    ),
    mine AS (
      SELECT DISTINCT cited.document_id
      FROM cited
      INNER JOIN q ON q.id = cited.query_id
      WHERE q.user_id = ${userId}
    ),
    trouble_root AS (
      SELECT DISTINCT dr.root_id
      FROM cited
      INNER JOIN q ON q.id = cited.query_id
      INNER JOIN doc_root AS dr ON dr.document_id = cited.document_id
      WHERE q.user_id = ${userId}
        AND (q.refused OR q.feedback = -1)
      UNION
      -- A refused answer cites nothing, so its topic comes from the sources
      -- behind teammates' answers to the same question.
      SELECT DISTINCT dr.root_id
      FROM q AS own
      INNER JOIN q AS other
        ON other.norm_question = own.norm_question
       AND other.user_id IS DISTINCT FROM own.user_id
       AND NOT other.refused
      INNER JOIN cited ON cited.query_id = other.id
      INNER JOIN doc_root AS dr ON dr.document_id = cited.document_id
      WHERE own.user_id = ${userId}
        AND own.refused
    ),
    team AS (
      SELECT
        cited.document_id,
        count(*)::int AS team_citations,
        max(q.created_at) AS last_cited_at
      FROM cited
      INNER JOIN q ON q.id = cited.query_id
      WHERE q.user_id IS NOT NULL
        AND q.user_id <> ${userId}
      GROUP BY cited.document_id
    ),
    candidates AS (
      SELECT
        t.document_id,
        t.team_citations,
        t.last_cited_at,
        EXISTS (
          SELECT 1
          FROM doc_root AS dr
          INNER JOIN trouble_root AS tr ON tr.root_id = dr.root_id
          WHERE dr.document_id = t.document_id
        ) AS related
      FROM team AS t
      WHERE NOT EXISTS (SELECT 1 FROM mine WHERE mine.document_id = t.document_id)
    )
    SELECT
      d.id::text AS document_id,
      d.title,
      c.team_citations,
      c.last_cited_at,
      c.related
    FROM candidates AS c
    INNER JOIN documents AS d ON d.id = c.document_id
    WHERE ${documentIsLiveSql()}
      AND ${documentVisibleSql(sql.raw("d.id"), programId, clearance)}
    ORDER BY c.related DESC, c.team_citations DESC, c.last_cited_at DESC, d.id
    LIMIT ${MAX_SOURCE_SUGGESTIONS}
  `;
}

insightsRouter.get("/source-usage", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const windowDays = parseUsageWindowDays(req.query["days"]);
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      const empty: SourceUsageResponse = {
        windowDays,
        suggestions: [],
        userId: null,
        person: null,
        people: [],
        matrix: { documentIds: [], rows: [] },
        totals: {
          questions: 0,
          answered: 0,
          refused: 0,
          sourcesCited: 0,
          sourcesNeverCited: 0,
          activeUsers: 0
        },
        sources: [],
        users: [],
        noProgramSelected: true
      };
      res.json(empty);
      return;
    }
    if (!canAccessProgram(user, programId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const person = await resolveUsageUser(req.query["userId"], programId);
    if (person === "not_found") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const userId = person?.userId ?? null;
    const clearance = await getUserMaxClassification(user.id);
    const ctes = usageCtes({ programId, windowDays, userId });
    // The matrix always covers everyone, whatever the person filter.
    const everyoneCtes = usageCtes({ programId, windowDays, userId: null });

    const totalsQuery = db.execute(sql`
      WITH ${ctes}
      SELECT
        (SELECT count(*)::int FROM q) AS questions,
        (SELECT count(*)::int FROM q WHERE ${ANSWERED}) AS answered,
        (SELECT count(*)::int FROM q WHERE refused) AS refused,
        (SELECT count(DISTINCT user_id)::int FROM q WHERE user_id IS NOT NULL) AS active_users,
        (SELECT count(DISTINCT document_id)::int FROM cited) AS sources_cited,
        (
          SELECT count(*)::int
          FROM documents AS nd
          WHERE nd.program_id = ${programId}::uuid
            AND ${documentVisibleSql(sql.raw("nd.id"), programId, clearance)}
            AND NOT EXISTS (SELECT 1 FROM cited WHERE cited.document_id = nd.id)
        ) AS sources_never_cited
    `);
    const sourcesQuery = db.execute(sql`
      WITH ${ctes},
      src AS (
        SELECT
          cited.document_id,
          count(*)::int AS citation_count,
          count(DISTINCT lower(btrim(q.question)))::int AS question_count,
          count(DISTINCT q.user_id)::int AS user_count,
          count(*) FILTER (WHERE q.feedback = -1)::int AS negative_count,
          max(q.created_at) AS last_cited_at
        FROM cited
        INNER JOIN q ON q.id = cited.query_id
        GROUP BY cited.document_id
      ),
      vw AS (
        SELECT document_id, count(*)::int AS view_count
        FROM kb_document_views
        WHERE program_id = ${programId}::uuid
          AND viewed_at > now() - make_interval(days => ${windowDays})
          ${userId ? sql`AND user_id = ${userId}::uuid` : sql``}
        GROUP BY document_id
      )
      SELECT
        d.id::text AS document_id,
        d.title,
        ${documentTitleVisibleSql(clearance)} AS title_visible,
        ${documentIsLiveSql()} AS is_live,
        src.citation_count,
        src.question_count,
        src.user_count,
        COALESCE(vw.view_count, 0) AS view_count,
        src.negative_count,
        src.last_cited_at
      FROM src
      INNER JOIN documents AS d ON d.id = src.document_id
      LEFT JOIN vw ON vw.document_id = d.id
      ORDER BY src.citation_count DESC, src.last_cited_at DESC, d.id
      LIMIT ${MAX_USAGE_SOURCES}
    `);
    const usersQuery = db.execute(sql`
      WITH ${ctes},
      per_user AS (
        SELECT
          user_id,
          count(*)::int AS question_count,
          count(*) FILTER (WHERE ${ANSWERED})::int AS answered_count,
          count(*) FILTER (WHERE refused)::int AS refused_count,
          count(*) FILTER (WHERE feedback = -1)::int AS negative_count,
          max(created_at) AS last_asked_at
        FROM q
        WHERE user_id IS NOT NULL
        GROUP BY user_id
      )
      SELECT
        u.id::text AS user_id,
        u.name,
        u.email,
        u.role::text AS role,
        pu.question_count,
        pu.answered_count,
        pu.refused_count,
        pu.negative_count,
        pu.last_asked_at
      FROM per_user AS pu
      INNER JOIN users AS u ON u.id::text = pu.user_id
      ORDER BY pu.question_count DESC, pu.last_asked_at DESC, u.id
    `);
    const topSourcesQuery = db.execute(sql`
      WITH ${ctes},
      ranked AS (
        SELECT
          q.user_id,
          cited.document_id,
          count(*)::int AS cnt,
          row_number() OVER (
            PARTITION BY q.user_id
            ORDER BY count(*) DESC, max(q.created_at) DESC, cited.document_id
          ) AS rn
        FROM cited
        INNER JOIN q ON q.id = cited.query_id
        WHERE q.user_id IS NOT NULL
        GROUP BY q.user_id, cited.document_id
      )
      SELECT
        r.user_id,
        d.id::text AS document_id,
        d.title,
        ${documentTitleVisibleSql(clearance)} AS title_visible,
        r.cnt AS count
      FROM ranked AS r
      INNER JOIN documents AS d ON d.id = r.document_id
      WHERE r.rn <= ${MAX_TOP_SOURCES_PER_USER}
      ORDER BY r.user_id, r.rn
    `);
    // Person picker: every active program member at csr level or above,
    // including people who asked nothing in the window. Super users have no
    // program_id, so they never appear here.
    const peopleQuery = db.execute(sql`
      SELECT
        u.id::text AS user_id,
        u.name,
        u.role::text AS role,
        COALESCE(qc.question_count, 0)::int AS question_count
      FROM users AS u
      LEFT JOIN (
        SELECT ql.user_id, count(*)::int AS question_count
        FROM query_log AS ql
        WHERE ql.program_id = ${programId}::uuid
          AND ql.created_at > now() - make_interval(days => ${windowDays})
          AND ql.user_id IS NOT NULL
        GROUP BY ql.user_id
      ) AS qc ON qc.user_id = u.id::text
      WHERE u.program_id = ${programId}::uuid
        AND u.is_active
        AND u.role IN ('csr', 'manager', 'senior_manager')
      ORDER BY lower(u.name), u.id
    `);
    // People x sources. Columns rank like `sources` with no person filter
    // (citations desc, last cited desc, id); rows order like the unfiltered
    // `users` list. One row with two JSON arrays, so an empty window still
    // returns well-formed columns.
    const matrixQuery = db.execute(sql`
      WITH ${everyoneCtes},
      top_docs AS (
        SELECT
          cited.document_id,
          row_number() OVER (
            ORDER BY count(*) DESC, max(q.created_at) DESC, cited.document_id
          ) AS ord
        FROM cited
        INNER JOIN q ON q.id = cited.query_id
        GROUP BY cited.document_id
        ORDER BY ord
        LIMIT ${MAX_MATRIX_SOURCES}
      ),
      cells AS (
        SELECT q.user_id, cited.document_id, count(*)::int AS cnt
        FROM cited
        INNER JOIN q ON q.id = cited.query_id
        INNER JOIN top_docs ON top_docs.document_id = cited.document_id
        WHERE q.user_id IS NOT NULL
        GROUP BY q.user_id, cited.document_id
      ),
      per_user AS (
        SELECT user_id, count(*)::int AS question_count, max(created_at) AS last_asked_at
        FROM q
        WHERE user_id IS NOT NULL
        GROUP BY user_id
      )
      SELECT
        COALESCE(
          (SELECT json_agg(t.document_id::text ORDER BY t.ord) FROM top_docs AS t),
          '[]'::json
        ) AS document_ids,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'userId', u.id::text,
                'counts', (
                  SELECT COALESCE(json_agg(COALESCE(c.cnt, 0) ORDER BY t.ord), '[]'::json)
                  FROM top_docs AS t
                  LEFT JOIN cells AS c
                    ON c.document_id = t.document_id AND c.user_id = pu.user_id
                )
              )
              ORDER BY pu.question_count DESC, pu.last_asked_at DESC, u.id
            )
            FROM per_user AS pu
            INNER JOIN users AS u ON u.id::text = pu.user_id
          ),
          '[]'::json
        ) AS matrix_rows
    `);
    // Coaching suggestions exist only for one selected person, and only name
    // sources both the viewer and that person can open.
    const suggestionsPromise = userId
      ? personClearance(userId).then((personMax) =>
          db.execute(
            suggestionsQuery({
              programId,
              windowDays,
              userId,
              clearance:
                classificationRank(personMax) < classificationRank(clearance)
                  ? personMax
                  : clearance
            })
          )
        )
      : Promise.resolve(null);
    const [
      totalsResult,
      sourcesResult,
      usersResult,
      topSourcesResult,
      peopleResult,
      matrixResult,
      suggestionsResult
    ] = await Promise.all([
      totalsQuery,
      sourcesQuery,
      usersQuery,
      topSourcesQuery,
      peopleQuery,
      matrixQuery,
      suggestionsPromise
    ]);
    const suggestions = selectSourceSuggestions(
      ((suggestionsResult?.rows ?? []) as unknown as UsageSuggestionRow[]).map((r) => ({
        documentId: r.document_id,
        title: r.title,
        teamCitations: Number(r.team_citations),
        lastCitedAt: isoOrNull(r.last_cited_at),
        related: r.related === true
      }))
    );
    const matrixRow = matrixResult.rows[0] as unknown as UsageMatrixRow | undefined;

    const totals = totalsResult.rows[0] as unknown as UsageTotalsRow | undefined;
    const topByUser = new Map<string, SourceUsageUser["topSources"]>();
    for (const r of topSourcesResult.rows as unknown as UsageTopSourceRow[]) {
      const list = topByUser.get(r.user_id) ?? [];
      list.push({
        documentId: r.document_id,
        title: gatedTitle(r.title, r.title_visible === true),
        count: Number(r.count)
      });
      topByUser.set(r.user_id, list);
    }

    const payload: SourceUsageResponse = {
      windowDays,
      suggestions,
      userId,
      person,
      people: (peopleResult.rows as unknown as UsagePeopleRow[]).map((r) => ({
        userId: r.user_id,
        name: r.name,
        role: r.role,
        questionCount: Number(r.question_count)
      })),
      matrix: shapeUsageMatrix(matrixRow?.document_ids, matrixRow?.matrix_rows),
      totals: {
        questions: Number(totals?.questions ?? 0),
        answered: Number(totals?.answered ?? 0),
        refused: Number(totals?.refused ?? 0),
        sourcesCited: Number(totals?.sources_cited ?? 0),
        sourcesNeverCited: Number(totals?.sources_never_cited ?? 0),
        activeUsers: Number(totals?.active_users ?? 0)
      },
      sources: (sourcesResult.rows as unknown as UsageSourceRow[]).map((r) => ({
        documentId: r.document_id,
        title: gatedTitle(r.title, r.title_visible === true),
        isLive: r.is_live === true,
        citationCount: Number(r.citation_count),
        questionCount: Number(r.question_count),
        userCount: Number(r.user_count),
        viewCount: Number(r.view_count),
        negativeCount: Number(r.negative_count),
        lastCitedAt: isoOrNull(r.last_cited_at)
      })),
      users: (usersResult.rows as unknown as UsageUserRow[]).map((r) => ({
        userId: r.user_id,
        name: r.name,
        email: r.email,
        role: r.role,
        questionCount: Number(r.question_count),
        answeredCount: Number(r.answered_count),
        refusedCount: Number(r.refused_count),
        negativeCount: Number(r.negative_count),
        topSources: topByUser.get(r.user_id) ?? [],
        lastAskedAt: isoOrNull(r.last_asked_at)
      }))
    };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

interface UsageQuestionRow {
  query_log_id: string;
  question: string;
  asked_at: Date | string;
  user_id: string | null;
  user_name: string | null;
  refused: boolean;
  feedback: number | null;
  sources: Array<{ documentId: string; title: string | null }> | null;
}

insightsRouter.get("/source-usage/questions", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const windowDays = parseUsageWindowDays(req.query["days"]);
    const limit = parseQuestionLimit(req.query["limit"]);
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      const empty: SourceUsageQuestionsResponse = {
        items: [],
        truncated: false,
        noProgramSelected: true
      };
      res.json(empty);
      return;
    }
    if (!canAccessProgram(user, programId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const person = await resolveUsageUser(req.query["userId"], programId);
    const documentId = parseOptionalUuid(req.query["documentId"]);
    if (person === "not_found" || documentId === "invalid") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const clearance = await getUserMaxClassification(user.id);
    if (documentId !== null) {
      // Same gate that nulls titles in the summaries: a source whose title
      // this viewer can't see doesn't reveal its questions either.
      const doc = await db.execute(sql`
        SELECT 1
        FROM documents AS d
        WHERE d.id = ${documentId}::uuid
          AND d.program_id = ${programId}::uuid
          AND ${documentTitleVisibleSql(clearance)}
        LIMIT 1
      `);
      if (doc.rows.length === 0) {
        res.status(404).json({ error: "Not found" });
        return;
      }
    }

    // limit + 1 rows tell us whether the page was truncated.
    const result = await db.execute(sql`
      WITH q AS (
        SELECT
          ql.id,
          ql.user_id,
          ql.question,
          COALESCE(ql.refused, false) AS refused,
          ql.feedback,
          ql.created_at,
          ${snapshotsArraySql(sql.raw("ql.citation_snapshots"))} AS snaps
        FROM query_log AS ql
        WHERE ql.program_id = ${programId}::uuid
          AND ql.created_at > now() - make_interval(days => ${windowDays})
          ${person ? sql`AND ql.user_id = ${person.userId}` : sql``}
          ${
            documentId
              ? sql`AND EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(${snapshotsArraySql(sql.raw("ql.citation_snapshots"))}) AS e(elem)
                  WHERE lower(e.elem ->> 'doc_id') = ${documentId}
                )`
              : sql``
          }
        ORDER BY ql.created_at DESC, ql.id DESC
        LIMIT ${limit + 1}
      )
      SELECT
        q.id::text AS query_log_id,
        q.question,
        q.created_at AS asked_at,
        q.user_id,
        u.name AS user_name,
        q.refused,
        q.feedback,
        srcs.sources
      FROM q
      LEFT JOIN users AS u ON u.id::text = q.user_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object('documentId', s.document_id, 'title', s.title)
          ORDER BY s.ord
        ) AS sources
        FROM (
          SELECT DISTINCT ON (d.id)
            d.id::text AS document_id,
            CASE WHEN ${documentTitleVisibleSql(clearance)} THEN d.title END AS title,
            e.ord
          FROM jsonb_array_elements(q.snaps) WITH ORDINALITY AS e(elem, ord)
          INNER JOIN documents AS d
            ON d.id::text = lower(e.elem ->> 'doc_id')
           AND d.program_id = ${programId}::uuid
          ORDER BY d.id, e.ord
        ) AS s
      ) AS srcs ON true
      ORDER BY q.created_at DESC, q.id DESC
    `);
    const page = takePage(result.rows as unknown as UsageQuestionRow[], limit);
    const payload: SourceUsageQuestionsResponse = {
      items: page.items.map((r) => ({
        queryLogId: r.query_log_id,
        question: r.question,
        askedAt: isoOrNull(r.asked_at) ?? new Date(0).toISOString(),
        userId: r.user_id,
        userName: r.user_name,
        refused: r.refused === true,
        feedback: normalizeFeedback(r.feedback),
        sources: Array.isArray(r.sources) ? r.sources : []
      })),
      truncated: page.truncated
    };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});
