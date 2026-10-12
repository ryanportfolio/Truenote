import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db-client.js";
import { teamUserFilterSql } from "./teams.js";
import { retrieve } from "./retrieval/query.js";
import { getActiveModelChain, type ApprovedModelRoute } from "./generation/model-routing.js";
import {
  runUtilityCompletionDetailed,
  type UtilityCompletionDeps,
  type UtilityCompletionResult
} from "./generation/utility-model.js";
import { recordAppError, safeErrorMessage } from "./observability/error-log.js";
import type { Classification } from "./security/classification.js";
import {
  MAX_GAP_GROUPS,
  assembleGapThemes,
  buildGapAnalysisPrompt,
  describeGapInput,
  describeGapReply,
  excerpt,
  parseModelThemes,
  promptChars,
  promptLooksReplaced,
  questionReadsAsInstructions,
  type GapProbe,
  type GapThemeTrace,
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
  /**
   * Distinct questions left out because they read as instructions to an AI
   * (content-scan prompt-injection rules), such as security-test asks.
   */
  heldOutQuestions: number;
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
  first_asked_at: Date | string;
  askers: number;
}

interface SummaryRow {
  refused: number;
  distinct_questions: number;
  latest: Date | string | null;
  /** Distinct people with a refusal in scope, for the error log. */
  askers: number;
}

async function readSummary(scope: GapAnalysisScope): Promise<SummaryRow> {
  const result = await db.execute(sql`
    SELECT
      count(*)::int                             AS refused,
      count(DISTINCT lower(btrim(question)))::int AS distinct_questions,
      max(created_at)                           AS latest,
      count(DISTINCT user_id)::int              AS askers
    FROM query_log
    WHERE program_id = ${scope.programId}::uuid
      AND refused = true
      AND created_at > now() - make_interval(days => ${scope.windowDays})
      ${teamUserFilterSql(scope.team, sql`query_log.user_id`)}
  `);
  return (result.rows[0] ?? { refused: 0, distinct_questions: 0, latest: null, askers: 0 }) as unknown as SummaryRow;
}

async function readGroups(scope: GapAnalysisScope): Promise<GapQuestionGroup[]> {
  const result = await db.execute(sql`
    SELECT
      min(question)                                AS question,
      count(*)::int                                AS ask_count,
      count(*) FILTER (WHERE flagged_missing)::int AS flagged_count,
      max(created_at)                              AS last_asked_at,
      min(created_at)                              AS first_asked_at,
      count(DISTINCT user_id)::int                 AS askers
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
    lastAskedAt: new Date(row.last_asked_at).toISOString(),
    firstAskedAt: new Date(row.first_asked_at).toISOString(),
    askers: row.askers
  }));
}

/** Best hit per question against today's knowledge base, in the asker's program and clearance. */
async function probeGroups(
  groups: readonly GapQuestionGroup[],
  scope: GapAnalysisScope,
  runId: string,
  probeErrors: Map<string, string>
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
        probeErrors.set(group.id, safeErrorMessage(error));
        void recordAppError({
          severity: "warning",
          source: "retrieval",
          operation: "gap-analysis-probe",
          error,
          correlationId: runId,
          programId: scope.programId,
          context: { questionId: group.id }
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
  summary: SummaryRow,
  refresh: boolean,
  requestedBy: string | null
): Promise<GapAnalysisResult> {
  const startedAt = Date.now();
  // Ties a run's error-log rows together (correlation id).
  const runId = randomUUID();
  const base = {
    windowDays: scope.windowDays,
    analyzedAt: new Date(startedAt).toISOString(),
    refusedAsks: summary.refused,
    distinctQuestions: summary.distinct_questions,
    cached: false
  };
  const groups = await readGroups(scope);
  const groupsMs = Date.now() - startedAt;
  if (groups.length === 0) {
    return {
      ...base,
      status: "empty",
      analyzedQuestions: 0,
      heldOutQuestions: 0,
      ungroupedQuestions: 0,
      themes: [],
      model: null
    };
  }
  // Attacks are not content gaps, and one in the prompt gets the message
  // holding it replaced by OpenRouter's prompt-injection guardrail.
  const heldOut = new Set(
    groups.filter((group) => questionReadsAsInstructions(group.question)).map((group) => group.id)
  );
  const sent = groups.filter((group) => !heldOut.has(group.id));
  if (sent.length === 0) {
    return {
      ...base,
      status: "ready",
      analyzedQuestions: 0,
      heldOutQuestions: heldOut.size,
      ungroupedQuestions: 0,
      themes: [],
      model: null
    };
  }

  const probeErrors = new Map<string, string>();
  const probesStartedAt = Date.now();
  const probes = await probeGroups(sent, scope, runId, probeErrors);
  const probesMs = Date.now() - probesStartedAt;
  const prompt = buildGapAnalysisPrompt(sent, probes);
  const charsSent = promptChars(prompt);
  const chain = await getActiveModelChain("gaps");
  const attempts: Record<string, unknown>[] = [];
  let sentMessages: unknown = null;

  // Walk the gaps chain: a request error or a reply with no usable themes
  // advances to the next route, like answer generation.
  for (const route of chain) {
    const requests: Readonly<Record<string, unknown>>[] = [];
    const onRequest: UtilityCompletionDeps["onRequest"] = (body) => {
      requests.push(body);
      sentMessages ??= body.messages;
    };
    const callStartedAt = Date.now();
    let reply: UtilityCompletionResult | null = null;
    let parse: Record<string, unknown> | null = null;
    try {
      reply = await completeAsJson(route, prompt, runId, onRequest);
      const text = reply.text;
      const modelThemes = text ? parseModelThemes(text) : null;
      const trace: GapThemeTrace[] = [];
      const { themes, ungroupedQuestions } = modelThemes
        ? assembleGapThemes(modelThemes, sent, probes, trace)
        : { themes: [], ungroupedQuestions: sent.length };
      if (themes.length === 0) {
        parse = describeGapReply(text, modelThemes, trace);
        const reason = modelThemes ? "reply held no usable themes" : "reply held no themes JSON";
        throw new Error(
          promptLooksReplaced(charsSent, reply.promptTokens)
            ? `${reason}; the provider counted ${reply.promptTokens} prompt tokens for ${charsSent} characters sent, so a filter likely replaced the questions`
            : reason
        );
      }
      return {
        ...base,
        status: "ready",
        analyzedQuestions: sent.length,
        heldOutQuestions: heldOut.size,
        ungroupedQuestions,
        themes,
        model: { label: route.label, providerLabel: route.providerLabel }
      };
    } catch (error) {
      const latencyMs = Date.now() - callStartedAt;
      attempts.push({
        routeId: route.id,
        outcome: safeErrorMessage(error),
        latencyMs,
        jsonModeRejected: requests.length > 1,
        promptTokens: reply?.promptTokens ?? null,
        finishReason: reply?.finishReason ?? null,
        generationId: reply?.generationId ?? null,
        replyChars: reply?.text?.length ?? 0,
        reply: reply?.text ? excerpt(reply.text, ATTEMPT_EXCERPT_CHARS) : null,
        reasoning: reply?.reasoning ? excerpt(reply.reasoning, ATTEMPT_EXCERPT_CHARS) : null
      });
      void recordAppError({
        severity: "warning",
        source: "generation",
        operation: "gap-analysis",
        error,
        provider: route.provider,
        model: route.model,
        routeId: route.id,
        correlationId: runId,
        userId: requestedBy,
        programId: scope.programId,
        context: {
          route: routeSettings(route),
          // Bodies as sent, the prompt text left to the run's
          // gap-analysis-exhausted row; two bodies mean JSON mode got a 400.
          requests: requests.map(withoutMessages),
          jsonModeRejected: requests.length > 1,
          latencyMs,
          promptCheck: {
            charsSent,
            promptTokens: reply?.promptTokens ?? null,
            likelyReplaced: promptLooksReplaced(charsSent, reply?.promptTokens ?? null)
          },
          reasoning: reply?.reasoning ?? null,
          response: reply?.raw ?? null,
          parse
        }
      });
    }
  }
  // One row per failed run with everything the run used and how each route
  // ended, so the error log alone explains the 503.
  void recordAppError({
    severity: "error",
    source: "generation",
    operation: "gap-analysis-exhausted",
    error: new GapAnalysisUnavailableError(),
    correlationId: runId,
    userId: requestedBy,
    programId: scope.programId,
    context: {
      app: {
        commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
        deploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
        service: process.env.RAILWAY_SERVICE_NAME ?? null
      },
      run: {
        startedAt: base.analyzedAt,
        refresh,
        totalMs: Date.now() - startedAt,
        groupsMs,
        probesMs
      },
      scope: {
        windowDays: scope.windowDays,
        team: scope.team ?? "program-wide",
        clearance: scope.clearance
      },
      window: {
        refusedAsks: summary.refused,
        distinctQuestions: summary.distinct_questions,
        askers: summary.askers,
        latestRefusal: summary.latest ? new Date(summary.latest).toISOString() : null,
        questionLimit: MAX_GAP_GROUPS
      },
      chain: chain.map(routeSettings),
      input: describeGapInput(groups, heldOut, probes, probeErrors, prompt),
      prompt: sentMessages === null ? "not sent: no request left the server" : messageLines(sentMessages),
      attempts
    }
  });
  throw new GapAnalysisUnavailableError();
}

/** Characters of each reply and reasoning kept in the run summary. */
const ATTEMPT_EXCERPT_CHARS = 300;

/** A route's settings as this run used them. */
function routeSettings(route: ApprovedModelRoute): Record<string, unknown> {
  return {
    id: route.id,
    model: route.model,
    provider: route.provider,
    reasoningControl: route.reasoningControl,
    reasoningEffort: route.reasoningEffort,
    defaultReasoningEffort: route.defaultReasoningEffort,
    jsonMode: route.jsonMode
  };
}

/** A request body with each message's text replaced by its length. */
function withoutMessages(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: unknown; content?: unknown }>) : [];
  return {
    ...body,
    messages: messages.map((message) => ({
      role: message.role,
      chars: typeof message.content === "string" ? message.content.length : null
    }))
  };
}

/** Messages as sent, each split into lines so the error log page reads them. */
function messageLines(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return (messages as Array<{ role?: unknown; content?: unknown }>).map((message) => ({
    role: message.role,
    lines: typeof message.content === "string" ? message.content.split("\n") : message.content
  }));
}

/**
 * Ask for the themes in JSON mode where the endpoint supports it. A provider
 * that rejects JSON mode (HTTP 400) gets one retry on the same route
 * without it; the tolerant parser still reads a plain-text reply.
 */
async function completeAsJson(
  route: ApprovedModelRoute,
  prompt: { system: string; user: readonly string[] },
  runId: string,
  onRequest: UtilityCompletionDeps["onRequest"]
): Promise<UtilityCompletionResult> {
  const input = { ...prompt, timeoutMs: MODEL_TIMEOUT_MS, maxRetries: 0 };
  if (!route.jsonMode) return runUtilityCompletionDetailed(input, { route, onRequest });
  try {
    return await runUtilityCompletionDetailed({ ...input, json: true }, { route, onRequest });
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status !== 400) throw error;
    void recordAppError({
      severity: "warning",
      source: "generation",
      operation: "gap-analysis-json-mode",
      error,
      provider: route.provider,
      model: route.model,
      routeId: route.id,
      correlationId: runId
    });
    return runUtilityCompletionDetailed(input, { route, onRequest });
  }
}

/**
 * Cached analysis for a scope. `refresh` forces a new run. The cache entry is
 * reused while the newest refusal and the refusal count in scope are
 * unchanged and the entry is under a day old.
 */
export async function getGapAnalysis(
  scope: GapAnalysisScope,
  refresh: boolean,
  requestedBy: string | null = null
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

  const run = runAnalysis(scope, summary, refresh, requestedBy)
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
