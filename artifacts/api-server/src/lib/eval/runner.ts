import { eq } from "drizzle-orm";
import { db } from "../db-client.js";
import {
  documents,
  documentVersions,
  evalQuestions,
  programs
} from "@workspace/db/schema";
import { retrieve } from "../retrieval/query.js";
import { generateAnswer } from "../generation/answer.js";

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
 */

export interface EvalRunOptions {
  /** Restrict to one program. Required when running across multiple programs would be ambiguous. */
  programId?: string;
  /** Run a single question by id. Overrides programId filter. */
  questionId?: string;
  /** Hard cap on questions to evaluate. Useful for fast smoke-tests. */
  limit?: number;
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
  // Sub-metrics (in-kb only; out-of-kb has no answer/citation to score)
  citationAccuracyPct: number | null;
  answerAccuracyPct: number | null;
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

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(
    sortedMs.length - 1,
    Math.floor((p / 100) * sortedMs.length)
  );
  return sortedMs[idx] ?? 0;
}

/**
 * Load the eval questions matching the run filters. Joins to programs
 * for the human-readable name on the report — programs have a stable
 * id but the name is what an operator scans the output by.
 */
async function loadQuestions(opts: EvalRunOptions): Promise<
  Array<{
    id: string;
    question: string;
    programId: string | null;
    programName: string | null;
    expectedDocId: string | null;
    expectedAnswerContains: string[] | null;
    notes: string | null;
  }>
> {
  const baseRows = await db
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
    .leftJoin(programs, eq(programs.id, evalQuestions.programId));
  let rows = baseRows;
  if (opts.questionId) {
    rows = rows.filter((r) => r.id === opts.questionId);
  } else if (opts.programId) {
    rows = rows.filter((r) => r.programId === opts.programId);
  }
  if (opts.limit !== undefined && opts.limit > 0) {
    rows = rows.slice(0, opts.limit);
  }
  return rows;
}

/**
 * Resolve a list of chunk_ids to the distinct document_ids they belong
 * to. The eval question's expected_doc_id is a documents.id; the
 * generation step gives us chunk_ids; the join is documents →
 * document_versions → chunks. Done in one query.
 */
async function chunkIdsToDocIds(chunkIds: string[]): Promise<string[]> {
  if (chunkIds.length === 0) return [];
  // Drizzle's `.where(inArray(...))` works for this, but we keep the
  // join explicit so a future reader can see how chunk → doc resolves.
  const rows = await db
    .select({
      chunkId: documentVersions.id,
      documentId: documents.id
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId));
  // Filter client-side to avoid building an inArray expression — the
  // eval set is small enough that the full table scan is cheaper than
  // the SQL machinery. If this script ever runs against a 100k-chunk
  // DB, swap to inArray.
  const allowed = new Set(chunkIds);
  const docs = new Set<string>();
  for (const r of rows) {
    if (allowed.has(r.chunkId)) docs.add(r.documentId);
  }
  return Array.from(docs);
}

/**
 * Run one question through the pipeline and score it. Catches errors
 * so a single bad question doesn't abort the whole run — the report
 * carries the error per row so operators can see which questions are
 * broken (e.g., expected_doc_id pointing at a deleted document).
 */
async function evaluateOne(q: {
  id: string;
  question: string;
  programId: string | null;
  programName: string | null;
  expectedDocId: string | null;
  expectedAnswerContains: string[] | null;
  notes: string | null;
}): Promise<EvalQuestionResult> {
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
      kind,
      pass: false,
      citationCorrect: q.expectedDocId === null ? null : false,
      phrasesPresent: expectedPhrases.map((p) => ({ phrase: p, present: false })),
      answerCorrect: expectedPhrases.length === 0 ? null : false,
      error: "eval_question has no program_id — cannot run retrieval"
    };
  }

  try {
    const retrieval = await retrieve({
      programId: q.programId,
      question: q.question
    });
    const generation = await generateAnswer({
      programName: q.programName ?? "the program",
      question: q.question,
      chunks: retrieval.chunks,
      refusedByRetrieval: retrieval.refused
    });
    const latencyMs = Date.now() - startedAt;

    const citedChunkIds = generation.payload.sources.map((s) => s.chunk_id);
    const citedDocIds = await chunkIdsToDocIds(citedChunkIds);

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
      kind,
      pass,
      citationCorrect,
      phrasesPresent,
      answerCorrect,
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
      kind,
      pass: false,
      citationCorrect: q.expectedDocId === null ? null : false,
      phrasesPresent: expectedPhrases.map((p) => ({ phrase: p, present: false })),
      answerCorrect: expectedPhrases.length === 0 ? null : false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function summarize(results: EvalQuestionResult[]): EvalSummary {
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
    citationAccuracyPct:
      citationApplicable.length === 0
        ? null
        : (citationCorrect / citationApplicable.length) * 100,
    answerAccuracyPct:
      answerApplicable.length === 0
        ? null
        : (answerCorrect / answerApplicable.length) * 100,
    latencyP50Ms: percentile(sortedLatency, 50),
    latencyP95Ms: percentile(sortedLatency, 95)
  };
}

export async function runEval(opts: EvalRunOptions = {}): Promise<EvalReport> {
  const startedAt = new Date();
  const questions = await loadQuestions(opts);
  const results: EvalQuestionResult[] = [];
  // Sequential, not parallel. Concurrency would muddle the latency
  // numbers (each question would queue behind the others on the
  // shared OpenAI/Cohere pools) and could trip rate limits. Eval
  // runs are infrequent — the simple loop is the right default.
  for (const q of questions) {
    results.push(await evaluateOne(q));
  }
  const finishedAt = new Date();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    summary: summarize(results),
    results
  };
}
