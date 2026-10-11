import { sql } from "drizzle-orm";
import { db } from "./db-client.js";
import { teamUserFilterSql } from "./teams.js";
import { retrieve } from "./retrieval/query.js";
import { getActiveModelChain } from "./generation/model-routing.js";
import { runUtilityCompletion } from "./generation/utility-model.js";
import { recordAppError } from "./observability/error-log.js";
import type { Classification } from "./security/classification.js";
import {
  MAX_GAP_GROUPS,
  assembleGapThemes,
  buildGapAnalysisPrompt,
  parseModelThemes,
  type GapProbe,
  type GapQuestionGroup,
  type GapTheme
} from "./gap-analysis.js";

/**
 * Runs and caches the Gaps page's analysis (pure parts in gap-analysis.ts).
 *
 * A run costs one retrieval per distinct refused question plus one model
 * call, so results are cached per program, team scope, clearance and window,
 * and reused until a new refusal lands in that scope (or a day passes, since
 * the knowledge base changes too). "Run again" bypasses the cache. Concurrent
 * requests for the same key share one run.
 */

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const PROBE_CONCURRENCY = 6;
const MODEL_TIMEOUT_MS = 60_000;

export interface GapAnalysisScope {
  programId: string;
  /** Supervisor team ids, or null for program-wide. */
  team: string[] | null;
  clearance: Classification;
  windowDays: number;
}

export interface GapAnalysisResult {
  status: "ready" | "empty";
  windowDays: number;
  analyzedAt: string;
  /** Refused asks in the window and scope. */
  refusedAsks: number;
  /** Distinct refused questions in the window and scope. */
  distinctQuestions: number;
  /** Distinct questions sent for analysis (most-asked first, capped). */
  analyzedQuestions: number;
  ungroupedQuestions: number;
  themes: GapTheme[];
  model: { label: string; providerLabel: string } | null;
  cached: boolean;
}

export class GapAnalysisUnavailableError extends Error {
  constructor() {
    super("Every gaps analysis model failed. Try again in a moment.");
    this.name = "GapAnalysisUnavailableError";
  }
}

interface CacheEntry {
  fingerprint: string;
  storedAt: number;
  result: GapAnalysisResult;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<GapAnalysisResult>>();

function cacheKey(scope: GapAnalysisScope): string {
  const team = scope.team === null ? "all" : [...scope.team].sort().join(",");
  return `${scope.programId}|${team}|${scope.clearance}|${scope.windowDays}`;
}

interface GroupRow {
  question: string;
  ask_count: number;
  flagged_count: number;
  last_asked_at: Date | string;
}

interface SummaryRow {
  refused: number;
  distinct_questions: number;
  latest: Date | string | null;
}

async function readSummary(scope: GapAnalysisScope): Promise<SummaryRow> {
  const result = await db.execute(sql`
    SELECT
      count(*)::int                             AS refused,
      count(DISTINCT lower(btrim(question)))::int AS distinct_questions,
      max(created_at)                           AS latest
    FROM query_log
    WHERE program_id = ${scope.programId}::uuid
      AND refused = true
      AND created_at > now() - make_interval(days => ${scope.windowDays})
      ${teamUserFilterSql(scope.team, sql`query_log.user_id`)}
  `);
  return (result.rows[0] ?? { refused: 0, distinct_questions: 0, latest: null }) as unknown as SummaryRow;
}

async function readGroups(scope: GapAnalysisScope): Promise<GapQuestionGroup[]> {
  const result = await db.execute(sql`
    SELECT
      min(question)                                AS question,
      count(*)::int                                AS ask_count,
      count(*) FILTER (WHERE flagged_missing)::int AS flagged_count,
      max(created_at)                              AS last_asked_at
    FROM query_log
    WHERE program_id = ${scope.programId}::uuid
      AND refused = true
      AND created_at > now() - make_interval(days => ${scope.windowDays})
      ${teamUserFilterSql(scope.team, sql`query_log.user_id`)}
    GROUP BY lower(btrim(question))
    ORDER BY count(*) DESC, max(created_at) DESC
    LIMIT ${MAX_GAP_GROUPS}
  `);
  return (result.rows as unknown as GroupRow[]).map((row, index) => ({
    id: `q${index + 1}`,
    question: row.question,
    count: row.ask_count,
    flagged: row.flagged_count,
    lastAskedAt: new Date(row.last_asked_at).toISOString()
  }));
}

/** Best hit per question against today's knowledge base, in the asker's program and clearance. */
async function probeGroups(
  groups: readonly GapQuestionGroup[],
  scope: GapAnalysisScope
): Promise<Map<string, GapProbe>> {
  const probes = new Map<string, GapProbe>();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < groups.length) {
      const group = groups[next++]!;
      try {
        const result = await retrieve({
          programId: scope.programId,
          question: group.question,
          maxClassification: scope.clearance
        });
        const top = result.chunks.find((chunk) => !chunk.neighbor && chunk.documentId);
        probes.set(group.id, {
          threshold: result.threshold,
          best:
            top && top.documentId
              ? {
                  documentId: top.documentId,
                  title: top.docTitle ?? "Untitled source",
                  score: top.relevanceScore
                }
              : null
        });
      } catch (error) {
        // One failed probe leaves that question without a near miss; the
        // theme still forms from its other questions.
        void recordAppError({
          severity: "warning",
          source: "retrieval",
          operation: "gap-analysis-probe",
          error,
          programId: scope.programId
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, groups.length) }, () => worker())
  );
  return probes;
}

async function runAnalysis(
  scope: GapAnalysisScope,
  summary: SummaryRow
): Promise<GapAnalysisResult> {
  const base = {
    windowDays: scope.windowDays,
    analyzedAt: new Date().toISOString(),
    refusedAsks: summary.refused,
    distinctQuestions: summary.distinct_questions,
    cached: false
  };
  const groups = await readGroups(scope);
  if (groups.length === 0) {
    return {
      ...base,
      status: "empty",
      analyzedQuestions: 0,
      ungroupedQuestions: 0,
      themes: [],
      model: null
    };
  }

  const probes = await probeGroups(groups, scope);
  const prompt = buildGapAnalysisPrompt(groups, probes);

  // Walk the gaps chain: a request error or a reply with no usable themes
  // advances to the next route, like answer generation.
  for (const route of await getActiveModelChain("gaps")) {
    try {
      const text = await runUtilityCompletion(
        { ...prompt, timeoutMs: MODEL_TIMEOUT_MS, maxRetries: 0 },
        { route }
      );
      const modelThemes = text ? parseModelThemes(text) : null;
      if (!modelThemes) throw new Error("reply held no themes JSON");
      const { themes, ungroupedQuestions } = assembleGapThemes(modelThemes, groups, probes);
      if (themes.length === 0) throw new Error("reply held no usable themes");
      return {
        ...base,
        status: "ready",
        analyzedQuestions: groups.length,
        ungroupedQuestions,
        themes,
        model: { label: route.label, providerLabel: route.providerLabel }
      };
    } catch (error) {
      void recordAppError({
        severity: "warning",
        source: "generation",
        operation: "gap-analysis",
        error,
        provider: route.provider,
        model: route.model,
        routeId: route.id,
        programId: scope.programId
      });
    }
  }
  throw new GapAnalysisUnavailableError();
}

/**
 * Cached analysis for a scope. `refresh` forces a new run. The cache entry is
 * reused while the newest refusal and the refusal count in scope are
 * unchanged and the entry is under a day old.
 */
export async function getGapAnalysis(
  scope: GapAnalysisScope,
  refresh: boolean
): Promise<GapAnalysisResult> {
  const key = cacheKey(scope);
  const summary = await readSummary(scope);
  const latest = summary.latest ? new Date(summary.latest).toISOString() : "none";
  const fingerprint = `${summary.refused}|${latest}`;

  const hit = cache.get(key);
  if (
    !refresh &&
    hit &&
    hit.fingerprint === fingerprint &&
    Date.now() - hit.storedAt < CACHE_MAX_AGE_MS
  ) {
    return { ...hit.result, cached: true };
  }

  const running = inflight.get(key);
  if (running) return running;

  const run = runAnalysis(scope, summary)
    .then((result) => {
      cache.delete(key);
      cache.set(key, { fingerprint, storedAt: Date.now(), result });
      while (cache.size > CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return result;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
}
