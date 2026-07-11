import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db-client.js";
import {
  evalQuestions,
  programs
} from "@workspace/db/schema";
import { retrieve, type RetrievalTraceEntry } from "../retrieval/query.js";
import {
  generateAnswer,
  type GenerateAnswerResult
} from "../generation/answer.js";
import type { ApprovedModelRoute } from "../generation/model-routing.js";
import { judgeFaithfulness } from "./faithfulness.js";

/**
 * Eval harness.
 *
 * Loads `eval_questions`, runs each through the full retrieval +
 * generation pipeline (the exact same lib functions /api/ask uses,
 * minus the HTTP/auth/queryLog layer), and scores the output against
 * the question's expected facts.
 *
 * Why not go through the HTTP route: the eval is a quality probe, not
 * an integration test. We're measuring retrieval + generation, not
 * Express + auth. Calling the lib functions directly is faster, runs
 * outside a server process, and avoids polluting query_log with eval
 * traffic.
 *
 * Scoring rules:
 *   - "In-KB" question = has expected_doc_id OR expected_answer_contains
 *     non-empty. Pass iff: not refused, AND if expected_doc_id is set
 *     it appears in the cited chunks' documents, AND every phrase in
 *     expected_answer_contains is present in the answer (case-insensitive,
 *     substring).
 *   - "Out-of-KB" question = both fields empty/null. Pass iff refused.
 *
 * Citation matching uses the doc_id, not the chunk_id — chunk ids
 * change with every re-ingest, doc ids don't, so authoring eval
 * questions against chunk ids would be brittle.
 *
 * Stage attribution: retrieval runs with withTrace, so for questions
 * with an expected_doc_id we know WHERE the pipeline lost the doc —
 * never a candidate (retrieval), a candidate but cut by the reranker
 * (rerank), reranked into top-K but below the confidence gate
 * (threshold), or delivered to the LLM and still failed (generation).
 * Industry consensus is that most RAG failures are retrieval failures;
 * this is how we check that claim against OUR system instead of
 * tuning the wrong stage.
 */

export type FailureStage = "retrieval" | "rerank" | "threshold" | "generation";

/**
 * Attribute an in-KB failure to a pipeline stage. Null when the question
 * has no expected_doc_id (hits are unknowable) — those failures land in
 * the "unattributed" bucket.
 */
export function attributeFailure(input: {
  retrievalHit: boolean | null;
  rerankHit: boolean | null;
  /** The retrieval-side confidence gate (topScore < threshold), NOT the LLM's refusal. */
  gateRefused: boolean;
}): FailureStage | null {
  if (input.retrievalHit === null || input.rerankHit === null) return null;
  if (!input.retrievalHit) return "retrieval";
  if (!input.rerankHit) return "rerank";
  if (input.gateRefused) return "threshold";
  return "generation";
}

/**
 * 1-based rank of the expected doc's best chunk in the post-rerank top-K.
 * Null when absent. Rank 7-of-8 on passes is an early warning the doc
 * barely survives reranking; candidate-pool order is merge order (not a
 * ranking), so no pre-rerank equivalent exists.
 */
export function expectedDocRank(
  ranked: RetrievalTraceEntry[],
  expectedDocId: string
): number | null {
  const idx = ranked.findIndex((e) => e.documentId === expectedDocId);
  return idx === -1 ? null : idx + 1;
}

export interface EvalRunOptions {
  /** Restrict to one program. Required when running across multiple programs would be ambiguous. */
  programId?: string;
  /** Run a single question by id. When programId is also set, both must match. */
  questionId?: string;
  /** Hard cap on questions to evaluate. Useful for fast smoke-tests. */
  limit?: number;
  /**
   * Run the claim-level faithfulness judge on every non-refused answer.
   * One extra gpt-4o call per judged question — opt-in to keep the default
   * run cheap.
   */
  judge?: boolean;
  /** Immutable definitions captured when an async run was queued. */
  questionSnapshot?: EvalQuestionDefinition[];
}

export interface EvalQuestionResult {
  questionId: string;
  question: string;
  programId: string | null;
  programName: string | null;
  expectedDocId: string | null;
  expectedAnswerContains: string[];
  notes: string | null;
  // Outcome
  answer: string;
  refused: boolean;
  topScore: number | null;
  citedChunkIds: string[];
  citedDocIds: string[];
  latencyMs: number;
  generationPath: GenerateAnswerResult["generationPath"] | "not-run";
  // Scoring
  /** "in-kb" or "out-of-kb" — derived from expected fields. */
  kind: "in-kb" | "out-of-kb";
  /** Pass = the question's expected outcome was met. */
  pass: boolean;
  /** Null when expected_doc_id is unset (citation rule doesn't apply). */
  citationCorrect: boolean | null;
  phrasesPresent: { phrase: string; present: boolean }[];
  /** Null when expected_answer_contains is empty. */
  answerCorrect: boolean | null;
  // Stage-level retrieval metrics (null when expected_doc_id is unset)
  /** Expected doc appeared in the merged vector+BM25 candidates (pre-rerank). */
  retrievalHit: boolean | null;
  /** Expected doc survived the reranker into the top-K sent to the LLM. */
  rerankHit: boolean | null;
  /** 1-based rank of the expected doc in the post-rerank top-K. Null when absent or no expected_doc_id. */
  expectedDocRank: number | null;
  /** Which pipeline stage lost an in-KB question. Null for passes and unattributable failures. */
  failureStage: FailureStage | null;
  /** % of the answer's factual claims supported by the excerpts. Null unless judged (--judge). */
  faithfulnessPct: number | null;
  /** Claims the judge could not ground in the excerpts. Empty unless judged. */
  unsupportedClaims: string[];
  /** True when the optional judge call failed for this answer. */
  faithfulnessJudgeFailed: boolean;
  /** Set if the pipeline threw — pass is false, other fields default. */
  error: string | null;
}

export interface EvalSummary {
  totalQuestions: number;
  passed: number;
  failed: number;
  // By bucket
  inKbTotal: number;
  inKbPassed: number;
  outOfKbTotal: number;
  outOfKbPassed: number;
  /** False-negative rate: in-KB questions the system refused. */
  inKbRefusalRatePct: number | null;
  /** Safety rate: out-of-KB questions the system correctly refused. */
  outOfKbRefusalRatePct: number | null;
  // Sub-metrics (in-kb only; out-of-kb has no answer/citation to score)
  citationAccuracyPct: number | null;
  answerAccuracyPct: number | null;
  // Stage-level recall (in-kb questions WITH expected_doc_id)
  /** % where the expected doc entered the candidate pool (pre-rerank). */
  retrievalRecallPct: number | null;
  /** % where the expected doc survived reranking into the top-K. */
  rerankRecallPct: number | null;
  /** In-KB failures attributed to the stage that lost the doc. */
  inKbFailuresByStage: {
    retrieval: number;
    rerank: number;
    threshold: number;
    generation: number;
    /** In-KB failures with no expected_doc_id (or that errored) — unattributable. */
    unattributed: number;
  };
  /** Mean 1-based rank of the expected doc among questions where it reached top-K. */
  expectedDocRankMean: number | null;
  // Faithfulness (only when the run was judged)
  /** Questions whose answers were judged (non-refused, judge enabled). */
  judgedQuestions: number;
  /** Mean per-question faithfulness. Null when nothing was judged. */
  meanFaithfulnessPct: number | null;
  /** Judged questions with at least one unsupported claim — the hallucination count. */
  unfaithfulQuestions: number;
  /** Answers produced after the primary route failed. */
  fallbackGenerationCount: number;
  /** Questions where both the primary and fallback failed validation/call. */
  failedFallbackCount: number;
  /** Optional faithfulness judge calls that failed and were excluded. */
  judgeFailures: number;
  // Latency
  latencyP50Ms: number;
  latencyP95Ms: number;
}

export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: EvalSummary;
  results: EvalQuestionResult[];
}

/** Stable fingerprint of the exact scored definitions, not just their count. */
export function evalQuestionSetHash(results: EvalQuestionResult[]): string {
  const definitions = results.map((result) => ({
    questionId: result.questionId,
    question: result.question,
    programId: result.programId,
    kind: result.kind,
    expectedDocId: result.expectedDocId,
    expectedAnswerContains: result.expectedAnswerContains
  }));
  return createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
}

/** Stable document ids for model-cited chunks, derived from retrieval truth. */
export function citedDocumentIds(
  citedChunkIds: string[],
  retrieved: Array<{ id: string; documentId: string | null }>
): string[] {
  const cited = new Set(citedChunkIds);
  return Array.from(
    new Set(
      retrieved
        .filter((chunk) => cited.has(chunk.id))
        .map((chunk) => chunk.documentId)
        .filter((id): id is string => id !== null)
    )
  );
}

/** Score only verified sources actually referenced inline by the answer. */
export function inlineCitedChunkIds(
  answer: string,
  sources: Array<{ chunk_id: string }>
): string[] {
  return sources
    .filter((source) => answer.includes(`[${source.chunk_id}]`))
    .map((source) => source.chunk_id);
}

export interface EvalRunCallbacks {
  /** Called after each sequential question finishes. Useful for persisted UI progress. */
  onProgress?: (completed: number, total: number) => void | Promise<void>;
  /** Pin the ordered approved-route chain so configuration cannot drift mid-suite. */
  routeChain?: ApprovedModelRoute[];
}

function classify(q: {
  expectedDocId: string | null;
  expectedAnswerContains: string[] | null;
}): "in-kb" | "out-of-kb" {
  const hasDoc = q.expectedDocId !== null;
  const hasPhrases =
    Array.isArray(q.expectedAnswerContains) &&
    q.expectedAnswerContains.length > 0;
  return hasDoc || hasPhrases ? "in-kb" : "out-of-kb";
}

export function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.max(
    0,
    Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1)
  );
  return sortedMs[idx] ?? 0;
}

export interface EvalQuestionDefinition {
  id: string;
  question: string;
  programId: string | null;
  programName: string | null;
  expectedDocId: string | null;
  expectedAnswerContains: string[] | null;
  notes: string | null;
}

/**
 * Load the eval questions matching the run filters. Joins to programs
 * for the human-readable name on the report — programs have a stable
 * id but the name is what an operator scans the output by.
 */
export async function loadEvalQuestions(
  opts: Pick<EvalRunOptions, "programId" | "questionId" | "limit">
): Promise<EvalQuestionDefinition[]> {
  const condition =
    opts.questionId && opts.programId
      ? and(
          eq(evalQuestions.id, opts.questionId),
          eq(evalQuestions.programId, opts.programId)
        )
      : opts.questionId
        ? eq(evalQuestions.id, opts.questionId)
        : opts.programId
          ? eq(evalQuestions.programId, opts.programId)
          : undefined;
  let rows = await db
    .select({
      id: evalQuestions.id,
      question: evalQuestions.question,
      programId: evalQuestions.programId,
      programName: programs.name,
      expectedDocId: evalQuestions.expectedDocId,
      expectedAnswerContains: evalQuestions.expectedAnswerContains,
      notes: evalQuestions.notes
    })
    .from(evalQuestions)
    .leftJoin(programs, eq(programs.id, evalQuestions.programId))
    .where(condition)
    .orderBy(asc(evalQuestions.createdAt), asc(evalQuestions.id));
  if (opts.limit !== undefined && opts.limit > 0) {
    rows = rows.slice(0, opts.limit);
  }
  return rows;
}

/**
 * Run one question through the pipeline and score it. Catches errors
 * so a single bad question doesn't abort the whole run — the report
 * carries the error per row so operators can see which questions are
 * broken (e.g., expected_doc_id pointing at a deleted document).
 */
async function evaluateOne(
  q: EvalQuestionDefinition,
  judge: boolean,
  routeChain?: ApprovedModelRoute[]
): Promise<EvalQuestionResult> {
  const expectedPhrases = q.expectedAnswerContains ?? [];
  const kind = classify(q);
  const startedAt = Date.now();

  if (!q.programId) {
    return {
      questionId: q.id,
      question: q.question,
      programId: null,
      programName: null,
      expectedDocId: q.expectedDocId,
      expectedAnswerContains: expectedPhrases,
      notes: q.notes,
      answer: "",
      refused: false,
      topScore: null,
      citedChunkIds: [],
      citedDocIds: [],
      latencyMs: 0,
      generationPath: "not-run",
      kind,
      pass: false,
      citationCorrect: q.expectedDocId === null ? null : false,
      phrasesPresent: expectedPhrases.map((p) => ({ phrase: p, present: false })),
      answerCorrect: expectedPhrases.length === 0 ? null : false,
      retrievalHit: null,
      rerankHit: null,
      expectedDocRank: null,
      failureStage: null,
      faithfulnessPct: null,
      unsupportedClaims: [],
      faithfulnessJudgeFailed: false,
      error: "eval_question has no program_id — cannot run retrieval"
    };
  }

  try {
    const retrieval = await retrieve({
      programId: q.programId,
      question: q.question,
      withTrace: true
    });
    const generation = await generateAnswer(
      {
        programName: q.programName ?? "the program",
        question: q.question,
        chunks: retrieval.chunks,
        refusedByRetrieval: retrieval.refused
      },
      routeChain ? { routeChain } : {}
    );
    const latencyMs = Date.now() - startedAt;

    const citedChunkIds = inlineCitedChunkIds(
      generation.payload.answer,
      generation.payload.sources
    );
    // Generation sources have already been validated against the retrieved
    // chunk ids. Resolve their stable document ids from those same authorized
    // rows instead of performing a second lookup that can race a re-ingest.
    const citedDocIds = citedDocumentIds(citedChunkIds, retrieval.chunks);

    const refused = generation.payload.refused;
    const answer = generation.payload.answer;
    const answerLower = answer.toLowerCase();

    const phrasesPresent = expectedPhrases.map((phrase) => ({
      phrase,
      present: answerLower.includes(phrase.toLowerCase())
    }));
    const answerCorrect: boolean | null =
      expectedPhrases.length === 0
        ? null
        : phrasesPresent.every((p) => p.present);

    const citationCorrect: boolean | null =
      q.expectedDocId === null ? null : citedDocIds.includes(q.expectedDocId);

    // Stage hits from the retrieval trace. Doc-id based for the same
    // reason citation matching is — chunk ids churn on re-ingest.
    const candidateDocIds = new Set(
      (retrieval.trace?.candidates ?? [])
        .map((e) => e.documentId)
        .filter((d): d is string => d !== null)
    );
    const rankedDocIds = new Set(
      (retrieval.trace?.ranked ?? [])
        .map((e) => e.documentId)
        .filter((d): d is string => d !== null)
    );
    const retrievalHit: boolean | null =
      q.expectedDocId === null ? null : candidateDocIds.has(q.expectedDocId);
    const rerankHit: boolean | null =
      q.expectedDocId === null ? null : rankedDocIds.has(q.expectedDocId);
    const docRank: number | null =
      q.expectedDocId === null
        ? null
        : expectedDocRank(retrieval.trace?.ranked ?? [], q.expectedDocId);

    let pass: boolean;
    if (kind === "out-of-kb") {
      // Out-of-KB question passes iff the system correctly refused.
      pass = refused;
    } else {
      // In-KB question: not refused, and every applicable check passes.
      pass =
        !refused &&
        (citationCorrect === null || citationCorrect) &&
        (answerCorrect === null || answerCorrect);
    }

    const failureStage =
      kind === "in-kb" && !pass
        ? attributeFailure({ retrievalHit, rerankHit, gateRefused: retrieval.refused })
        : null;

    // Faithfulness judge — every non-refused answer, in-KB or not (an
    // out-of-KB question that wrongly got an answer is a prime hallucination
    // candidate). Runs AFTER latencyMs is captured: judge time is eval
    // overhead, not pipeline latency. A judge failure degrades to unjudged
    // rather than failing the question — the judge is instrumentation.
    let faithfulnessPct: number | null = null;
    let unsupportedClaims: string[] = [];
    let faithfulnessJudgeFailed = false;
    if (judge && !refused && retrieval.chunks.length > 0) {
      try {
        const judgment = await judgeFaithfulness({ answer, chunks: retrieval.chunks });
        faithfulnessPct = judgment.faithfulnessPct;
        unsupportedClaims = judgment.unsupportedClaims;
      } catch (err) {
        faithfulnessJudgeFailed = true;
        console.warn(
          `[eval] faithfulness judge failed for question ${q.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return {
      questionId: q.id,
      question: q.question,
      programId: q.programId,
      programName: q.programName,
      expectedDocId: q.expectedDocId,
      expectedAnswerContains: expectedPhrases,
      notes: q.notes,
      answer,
      refused,
      topScore: retrieval.topScore,
      citedChunkIds,
      citedDocIds,
      latencyMs,
      generationPath: generation.generationPath,
      kind,
      pass,
      citationCorrect,
      phrasesPresent,
      answerCorrect,
      retrievalHit,
      rerankHit,
      expectedDocRank: docRank,
      failureStage,
      faithfulnessPct,
      unsupportedClaims,
      faithfulnessJudgeFailed,
      error: null
    };
  } catch (err) {
    return {
      questionId: q.id,
      question: q.question,
      programId: q.programId,
      programName: q.programName,
      expectedDocId: q.expectedDocId,
      expectedAnswerContains: expectedPhrases,
      notes: q.notes,
      answer: "",
      refused: false,
      topScore: null,
      citedChunkIds: [],
      citedDocIds: [],
      latencyMs: Date.now() - startedAt,
      generationPath: "not-run",
      kind,
      pass: false,
      citationCorrect: q.expectedDocId === null ? null : false,
      phrasesPresent: expectedPhrases.map((p) => ({ phrase: p, present: false })),
      answerCorrect: expectedPhrases.length === 0 ? null : false,
      retrievalHit: null,
      rerankHit: null,
      expectedDocRank: null,
      failureStage: null,
      faithfulnessPct: null,
      unsupportedClaims: [],
      faithfulnessJudgeFailed: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export function summarizeEvalResults(results: EvalQuestionResult[]): EvalSummary {
  const passed = results.filter((r) => r.pass).length;
  const inKb = results.filter((r) => r.kind === "in-kb");
  const outOfKb = results.filter((r) => r.kind === "out-of-kb");

  // Citation accuracy: among in-KB questions WITH an expected_doc_id,
  // what fraction got it right? Questions without expected_doc_id are
  // excluded from the denominator — they don't claim a citation rule.
  const citationApplicable = inKb.filter((r) => r.citationCorrect !== null);
  const citationCorrect = citationApplicable.filter(
    (r) => r.citationCorrect === true
  ).length;

  // Same shape for answer accuracy.
  const answerApplicable = inKb.filter((r) => r.answerCorrect !== null);
  const answerCorrect = answerApplicable.filter(
    (r) => r.answerCorrect === true
  ).length;

  // Stage recall: same denominator as citation accuracy (in-KB questions
  // that name an expected_doc_id) — hits are unknowable without one.
  const stageApplicable = inKb.filter((r) => r.retrievalHit !== null);
  const retrievalHits = stageApplicable.filter((r) => r.retrievalHit === true).length;
  const rerankHits = stageApplicable.filter((r) => r.rerankHit === true).length;

  const inKbFailures = inKb.filter((r) => !r.pass);
  const stageCount = (stage: FailureStage): number =>
    inKbFailures.filter((r) => r.failureStage === stage).length;
  const inKbFailuresByStage = {
    retrieval: stageCount("retrieval"),
    rerank: stageCount("rerank"),
    threshold: stageCount("threshold"),
    generation: stageCount("generation"),
    unattributed: inKbFailures.filter((r) => r.failureStage === null).length
  };

  const rankedResults = results.filter((r) => r.expectedDocRank !== null);
  const expectedDocRankMean =
    rankedResults.length === 0
      ? null
      : rankedResults.reduce((sum, r) => sum + (r.expectedDocRank ?? 0), 0) /
        rankedResults.length;

  const judged = results.filter((r) => r.faithfulnessPct !== null);
  const meanFaithfulnessPct =
    judged.length === 0
      ? null
      : judged.reduce((sum, r) => sum + (r.faithfulnessPct ?? 0), 0) / judged.length;
  const unfaithfulQuestions = judged.filter((r) => r.unsupportedClaims.length > 0).length;
  const fallbackGenerationCount = results.filter(
    (r) => r.generationPath === "fallback"
  ).length;
  const failedFallbackCount = results.filter(
    (r) => r.generationPath === "fallback-failed"
  ).length;
  const judgeFailures = results.filter((r) => r.faithfulnessJudgeFailed).length;

  const sortedLatency = results
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);

  return {
    totalQuestions: results.length,
    passed,
    failed: results.length - passed,
    inKbTotal: inKb.length,
    inKbPassed: inKb.filter((r) => r.pass).length,
    outOfKbTotal: outOfKb.length,
    outOfKbPassed: outOfKb.filter((r) => r.pass).length,
    inKbRefusalRatePct:
      inKb.length === 0
        ? null
        : (inKb.filter((r) => r.refused).length / inKb.length) * 100,
    outOfKbRefusalRatePct:
      outOfKb.length === 0
        ? null
        : (outOfKb.filter((r) => r.refused).length / outOfKb.length) * 100,
    citationAccuracyPct:
      citationApplicable.length === 0
        ? null
        : (citationCorrect / citationApplicable.length) * 100,
    answerAccuracyPct:
      answerApplicable.length === 0
        ? null
        : (answerCorrect / answerApplicable.length) * 100,
    retrievalRecallPct:
      stageApplicable.length === 0
        ? null
        : (retrievalHits / stageApplicable.length) * 100,
    rerankRecallPct:
      stageApplicable.length === 0
        ? null
        : (rerankHits / stageApplicable.length) * 100,
    inKbFailuresByStage,
    expectedDocRankMean,
    judgedQuestions: judged.length,
    meanFaithfulnessPct,
    unfaithfulQuestions,
    fallbackGenerationCount,
    failedFallbackCount,
    judgeFailures,
    latencyP50Ms: percentile(sortedLatency, 50),
    latencyP95Ms: percentile(sortedLatency, 95)
  };
}

export async function runEval(
  opts: EvalRunOptions = {},
  callbacks: EvalRunCallbacks = {}
): Promise<EvalReport> {
  const startedAt = new Date();
  const questions = opts.questionSnapshot ?? (await loadEvalQuestions(opts));
  const results: EvalQuestionResult[] = [];
  // Sequential, not parallel. Concurrency would muddle the latency
  // numbers (each question would queue behind the others on the
  // shared OpenAI/Cohere pools) and could trip rate limits. Eval
  // runs are infrequent — the simple loop is the right default.
  for (const q of questions) {
    results.push(
      await evaluateOne(q, opts.judge ?? false, callbacks.routeChain)
    );
    await callbacks.onProgress?.(results.length, questions.length);
  }
  const finishedAt = new Date();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    summary: summarizeEvalResults(results),
    results
  };
}
