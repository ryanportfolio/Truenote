import type {
  EvalQuestionResult,
  EvalRunConfiguration,
  EvalRunListItem,
  EvalSummary
} from "@/types/api";

export type MetricTone = "better" | "worse" | "same";

export interface MetricDelta {
  value: number;
  tone: MetricTone;
}

export function evalPassRate(summary: EvalSummary | null): number | null {
  if (!summary || summary.totalQuestions === 0) return null;
  return (summary.passed / summary.totalQuestions) * 100;
}

export function compareMetric(
  current: number | null,
  baseline: number | null,
  higherIsBetter = true
): MetricDelta | null {
  if (current === null || baseline === null) return null;
  const value = current - baseline;
  if (Math.abs(value) < 0.05) return { value: 0, tone: "same" };
  const improved = higherIsBetter ? value > 0 : value < 0;
  return { value, tone: improved ? "better" : "worse" };
}

/**
 * True when two runs used the same pipeline setup (judge, routes, retrieval).
 * Runs without a stored configuration never match.
 */
export function sameConfiguration(
  left: EvalRunConfiguration | null,
  right: EvalRunConfiguration | null
): boolean {
  if (!left || !right) return false;
  return JSON.stringify({
    judge: left.judge,
    generation: left.generation,
    routeChain: left.routeChain ?? [left.generation],
    fallback: left.fallback,
    retrieval: left.retrieval
  }) === JSON.stringify({
    judge: right.judge,
    generation: right.generation,
    routeChain: right.routeChain ?? [right.generation],
    fallback: right.fallback,
    retrieval: right.retrieval
  });
}

/**
 * A delta is directional evidence only when the run shape stayed stable.
 * New runs persist an exact question-set hash. Older runs without one remain
 * intentionally incomparable instead of presenting a misleading delta.
 */
export function comparableToBaseline(
  run: EvalRunListItem,
  baseline: EvalRunListItem
): boolean {
  return (
    run.questionId === baseline.questionId &&
    run.questionCount === baseline.questionCount &&
    run.configuration?.questionSetHash !== null &&
    run.configuration?.questionSetHash !== undefined &&
    run.configuration.questionSetHash === baseline.configuration?.questionSetHash &&
    sameConfiguration(run.configuration, baseline.configuration)
  );
}

export interface ResultDiff {
  /** Passed in the baseline, failed in this run. */
  newlyFailing: EvalQuestionResult[];
  /** Failed in the baseline, passed in this run. */
  newlyPassing: EvalQuestionResult[];
  /** In both runs with the same pass or fail outcome. */
  unchanged: number;
  onlyInCurrent: EvalQuestionResult[];
  onlyInBaseline: EvalQuestionResult[];
}

/** Compare two runs question by question (matched on questionId). */
export function diffResults(
  current: EvalQuestionResult[],
  baseline: EvalQuestionResult[]
): ResultDiff {
  const baselineById = new Map(baseline.map((result) => [result.questionId, result]));
  const currentIds = new Set(current.map((result) => result.questionId));
  const diff: ResultDiff = {
    newlyFailing: [],
    newlyPassing: [],
    unchanged: 0,
    onlyInCurrent: [],
    onlyInBaseline: baseline.filter((result) => !currentIds.has(result.questionId))
  };
  for (const result of current) {
    const before = baselineById.get(result.questionId);
    if (!before) diff.onlyInCurrent.push(result);
    else if (before.pass && !result.pass) diff.newlyFailing.push(result);
    else if (!before.pass && result.pass) diff.newlyPassing.push(result);
    else diff.unchanged += 1;
  }
  return diff;
}

export interface NoiseThreshold {
  /** Points one question moves the overall pass rate, to 1 decimal. */
  perQuestion: number;
  /** Changes smaller than this are within noise (two questions). */
  noise: number;
}

/** Below 30 scored questions a single question moves the score visibly. */
export function noiseThreshold(total: number): NoiseThreshold | null {
  if (total <= 0 || total >= 30) return null;
  const perQuestion = Math.round((100 / total) * 10) / 10;
  return { perQuestion, noise: Math.round(perQuestion * 2 * 10) / 10 };
}

export interface RunEstimate {
  questions: number;
  answerCalls: number;
  /** Upper bound: refused answers skip the faithfulness judge. */
  judgeCalls: number;
  /** Questions with an expected answer, each graded by one AI call. */
  gradedAnswers: number;
  /** Null when no completed run gives a latency to estimate from. */
  minutes: number | null;
}

/** Questions answered at once by the eval worker. */
export const EVAL_CONCURRENCY = 3;

export function estimate({
  questions,
  judge,
  expectedAnswers,
  latencyP50Ms
}: {
  questions: number;
  judge: boolean;
  expectedAnswers: number;
  latencyP50Ms: number | null;
}): RunEstimate {
  return {
    questions,
    answerCalls: questions,
    judgeCalls: judge ? questions : 0,
    gradedAnswers: expectedAnswers,
    minutes:
      latencyP50Ms === null || latencyP50Ms <= 0
        ? null
        : Math.max(1, Math.round((latencyP50Ms * questions) / EVAL_CONCURRENCY / 60_000))
  };
}

export interface CountedMetric {
  passed: number;
  total: number;
}

/** Numerators and denominators behind the percentage metrics, from a report. */
export function metricCounts(results: EvalQuestionResult[]): {
  overall: CountedMetric;
  answer: CountedMetric;
  citation: CountedMetric;
  outOfKbRefused: CountedMetric;
  retrieval: CountedMetric;
  rerank: CountedMetric;
} {
  const count = (
    rows: EvalQuestionResult[],
    value: (row: EvalQuestionResult) => boolean | null
  ): CountedMetric => {
    const applicable = rows.filter((row) => value(row) !== null);
    return {
      passed: applicable.filter((row) => value(row) === true).length,
      total: applicable.length
    };
  };
  const inKb = results.filter((row) => row.kind === "in-kb");
  const outOfKb = results.filter((row) => row.kind === "out-of-kb");
  return {
    overall: count(results, (row) => row.pass),
    answer: count(inKb, (row) => row.answerCorrect),
    citation: count(inKb, (row) => row.citationCorrect),
    outOfKbRefused: count(outOfKb, (row) => row.refused),
    retrieval: count(inKb, (row) => row.retrievalHit),
    rerank: count(inKb, (row) => row.rerankHit)
  };
}
