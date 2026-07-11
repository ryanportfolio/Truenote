import type {
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

function sameConfiguration(
  left: EvalRunConfiguration | null,
  right: EvalRunConfiguration | null
): boolean {
  if (!left || !right) return false;
  return JSON.stringify({
    judge: left.judge,
    generation: left.generation,
    fallback: left.fallback,
    retrieval: left.retrieval
  }) === JSON.stringify({
    judge: right.judge,
    generation: right.generation,
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
