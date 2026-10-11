import type { ReactNode } from "react";
import {
  compareMetric,
  evalPassRate,
  metricCounts,
  noiseThreshold,
  type CountedMetric,
  type MetricDelta,
  type ResultDiff
} from "@/lib/evaluationMetrics";
import { cn } from "@/lib/utils";
import type {
  EvalQuestionResult,
  EvalRunListItem,
  EvalSummary,
  ModelRoutingOption
} from "@/types/api";
import { formatPct, liveSetupLine, trialSetupLine } from "./format";
import { useMetricHelp, type MetricName } from "./MetricHelp";

export function RunSummary({
  run,
  results,
  baselineSummary,
  diff,
  routes
}: {
  run: EvalRunListItem;
  /** The run's per-question results once its detail has loaded. */
  results: EvalQuestionResult[] | null;
  /** Baseline summary for numeric deltas; null when the runs are not comparable. */
  baselineSummary: EvalSummary | null;
  /** Question-level comparison with the baseline; null when there is none. */
  diff: ResultDiff | null;
  routes: ModelRoutingOption[];
}): JSX.Element {
  const summary = run.summary;
  const trial = run.configuration?.trial === true;
  const noise = summary ? noiseThreshold(summary.totalQuestions) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2 text-base font-medium">
          {trial ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              Trial
            </span>
          ) : null}
          <span>{leadSentence(run, diff)}</span>
        </p>
        {run.configuration ? (
          <p className="text-xs text-muted-foreground">
            {trial
              ? `${trialSetupLine(run.configuration, routes)}${run.judge ? ", faithfulness judge on" : ""}`
              : liveSetupLine(run.configuration, run.judge)}
          </p>
        ) : null}
      </div>

      {noise ? (
        <p className="rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          Small test set: each question moves the score by {noise.perQuestion} points, so treat
          changes under {noise.noise} points as noise.
        </p>
      ) : null}

      <SummaryMetrics summary={summary} results={results} baseline={baselineSummary} />
    </div>
  );
}

function leadSentence(run: EvalRunListItem, diff: ResultDiff | null): string {
  if (run.status === "queued") return "Queued: waiting for the worker to start.";
  if (run.status === "running") {
    return `Running: ${run.completedQuestions} of ${run.questionCount} questions answered so far.`;
  }
  if (run.status === "failed" || !run.summary) return "This run did not finish, so it has no score.";
  const { passed, totalQuestions } = run.summary;
  const lead = `${passed} of ${totalQuestions} passed (${formatPct(evalPassRate(run.summary))}).`;
  if (!diff) return lead;
  return `${lead} ${diff.newlyFailing.length} newly failing, ${diff.newlyPassing.length} newly passing since the baseline.`;
}

function SummaryMetrics({
  summary,
  results,
  baseline
}: {
  summary: EvalSummary | null;
  results: EvalQuestionResult[] | null;
  baseline: EvalSummary | null;
}): JSX.Element {
  const counts = results && results.length > 0 ? metricCounts(results) : null;
  const metrics: Array<{
    label: MetricName;
    value: number | null;
    baseline: number | null;
    count: CountedMetric | null;
  }> = [
    {
      label: "Overall pass",
      value: evalPassRate(summary),
      baseline: evalPassRate(baseline),
      count: counts?.overall ?? (summary ? { passed: summary.passed, total: summary.totalQuestions } : null)
    },
    {
      label: "Answer accuracy",
      value: summary?.answerAccuracyPct ?? null,
      baseline: baseline?.answerAccuracyPct ?? null,
      count: counts?.answer ?? null
    },
    {
      label: "Citation accuracy",
      value: summary?.citationAccuracyPct ?? null,
      baseline: baseline?.citationAccuracyPct ?? null,
      count: counts?.citation ?? null
    },
    {
      label: "Out-of-KB refused",
      value: summary?.outOfKbRefusalRatePct ?? null,
      baseline: baseline?.outOfKbRefusalRatePct ?? null,
      count: counts?.outOfKbRefused ?? null
    },
    {
      label: "Retrieval recall",
      value: summary?.retrievalRecallPct ?? null,
      baseline: baseline?.retrievalRecallPct ?? null,
      count: counts?.retrieval ?? null
    },
    {
      label: "Rerank recall",
      value: summary?.rerankRecallPct ?? null,
      baseline: baseline?.rerankRecallPct ?? null,
      count: counts?.rerank ?? null
    }
  ];

  return (
    <>
      <dl className="grid overflow-hidden rounded-lg border border-border bg-card shadow-card sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map((metric) => (
          <Metric
            key={metric.label}
            label={metric.label}
            value={formatPct(metric.value)}
            count={metric.value === null ? null : metric.count}
            delta={compareMetric(metric.value, metric.baseline, true)}
          />
        ))}
      </dl>
      {summary ? <SecondaryStats summary={summary} results={results} /> : null}
    </>
  );
}

function Metric({
  label,
  value,
  count,
  delta
}: {
  label: MetricName;
  value: string;
  count: CountedMetric | null;
  delta: MetricDelta | null;
}): JSX.Element {
  const help = useMetricHelp(label);
  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 lg:border-b lg:border-r lg:[&:nth-child(3n)]:border-r-0 lg:[&:nth-last-child(-n+3)]:border-b-0">
      <dt className="flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
        {help.button}
      </dt>
      <dd className="mt-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xl font-semibold tabular-nums">{value}</span>
          {delta ? (
            <span
              className={cn(
                "whitespace-nowrap text-xs tabular-nums",
                delta.tone === "better"
                  ? "text-success"
                  : delta.tone === "worse"
                    ? "text-destructive"
                    : "text-muted-foreground"
              )}
            >
              {delta.value > 0 ? "+" : ""}
              {delta.value.toFixed(1)} pts vs baseline
            </span>
          ) : null}
        </span>
        {count ? (
          <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
            {count.passed}/{count.total}
          </span>
        ) : null}
        {help.text}
      </dd>
    </div>
  );
}

function SecondaryStats({
  summary,
  results
}: {
  summary: EvalSummary;
  results: EvalQuestionResult[] | null;
}): JSX.Element {
  const judgeFailures = summary.judgeFailures ?? 0;
  const gradingFailures = summary.correctnessJudgeFailures ?? 0;
  const fallbackGenerationCount = summary.fallbackGenerationCount ?? 0;
  const failedFallbackCount = summary.failedFallbackCount ?? 0;
  const inKbRefused = results
    ? results.filter((result) => result.kind === "in-kb" && result.refused).length
    : null;
  const stages = summary.inKbFailuresByStage;
  const judged = summary.judgedQuestions > 0 || judgeFailures > 0;

  return (
    <dl className="grid gap-x-6 gap-y-3 text-xs text-muted-foreground sm:grid-cols-2">
      <Stat label="Latency">
        p50 {summary.latencyP50Ms} ms · p95 {summary.latencyP95Ms} ms
      </Stat>
      <Stat label="In-KB refusal" help="In-KB refusal">
        {formatPct(summary.inKbRefusalRatePct)}
        {inKbRefused !== null && summary.inKbTotal > 0 ? ` · ${inKbRefused}/${summary.inKbTotal}` : ""}
      </Stat>
      <Stat label="Faithfulness" help="Faithfulness">
        {judged
          ? `${formatPct(summary.meanFaithfulnessPct)} over ${summary.judgedQuestions} scored · ${judgeFailures} judge failure${judgeFailures === 1 ? "" : "s"} · ${summary.unfaithfulQuestions} answer${summary.unfaithfulQuestions === 1 ? "" : "s"} with unsupported claims`
          : "Not measured: the faithfulness judge was off"}
      </Stat>
      <Stat label="Expected source rank" help="Expected source rank">
        {summary.expectedDocRankMean === null ? "—" : `${summary.expectedDocRankMean.toFixed(1)} on average`}
      </Stat>
      <Stat label="Generation fallback" help="Generation fallback">
        {fallbackGenerationCount}/{summary.totalQuestions}
        {failedFallbackCount > 0 ? ` · ${failedFallbackCount} failed all routes` : ""}
      </Stat>
      <Stat label="Failure stage" help="Failure stage">
        search {stages.retrieval} · reranking {stages.rerank} · threshold {stages.threshold} · answer{" "}
        {stages.generation} · unattributed {stages.unattributed}
      </Stat>
      {gradingFailures > 0 ? (
        <Stat label="Answer grading">
          Failed for {gradingFailures} question{gradingFailures === 1 ? "" : "s"}; those count as
          not passed
        </Stat>
      ) : null}
      {summary.splits && summary.splits.protected.total > 0 ? (
        <Stat label="Held-out split">
          protected {summary.splits.protected.passed}/{summary.splits.protected.total} (
          {formatPct(summary.splits.protected.passRatePct)}) · open {summary.splits.open.passed}/
          {summary.splits.open.total} ({formatPct(summary.splits.open.passRatePct)})
        </Stat>
      ) : null}
    </dl>
  );
}

function Stat({
  label,
  help,
  children
}: {
  label: string;
  help?: MetricName;
  children: ReactNode;
}): JSX.Element {
  return help ? (
    <HelpedStat label={label} help={help}>
      {children}
    </HelpedStat>
  ) : (
    <div>
      <dt className="flex min-h-5 items-center gap-1">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

function HelpedStat({
  label,
  help,
  children
}: {
  label: string;
  help: MetricName;
  children: ReactNode;
}): JSX.Element {
  const metricHelp = useMetricHelp(help);
  return (
    <div>
      <dt className="flex min-h-5 items-center gap-1">
        {label}
        {metricHelp.button}
      </dt>
      <dd>
        <span className="font-medium tabular-nums text-foreground">{children}</span>
        {metricHelp.text}
      </dd>
    </div>
  );
}
