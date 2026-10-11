import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, FlaskConical, Star, XCircle } from "lucide-react";
import { getEvalRun } from "@/lib/api";
import {
  comparableToBaseline,
  diffResults,
  evalPassRate,
  sameConfiguration
} from "@/lib/evaluationMetrics";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import type {
  EvalRunDetailResponse,
  EvalRunListItem,
  ModelRoutingOption
} from "@/types/api";
import { BaselineDiff } from "./BaselineDiff";
import { formatPct } from "./format";
import { ResultDetails, type ResultFocusRequest } from "./ResultDetails";
import { RunSummary } from "./RunSummary";

export function RunsPanel({
  loading,
  detailLoading,
  detailError,
  runs,
  selectedRun,
  detail,
  baseline,
  routes,
  cancelingRunId,
  onSelect,
  onRetryDetail,
  onBaseline,
  onCancel
}: {
  loading: boolean;
  detailLoading: boolean;
  detailError: string | null;
  runs: EvalRunListItem[];
  selectedRun: EvalRunListItem | null;
  detail: EvalRunDetailResponse | null;
  baseline: EvalRunListItem | null;
  routes: ModelRoutingOption[];
  cancelingRunId: string | null;
  onSelect: (id: string) => void;
  onRetryDetail: () => void;
  onBaseline: (run: EvalRunListItem) => Promise<void>;
  onCancel: (run: EvalRunListItem) => Promise<void>;
}): JSX.Element {
  const [focusRequest, setFocusRequest] = useState<ResultFocusRequest | null>(null);
  const compareToBaseline =
    selectedRun !== null &&
    baseline !== null &&
    selectedRun.id !== baseline.id &&
    selectedRun.status === "completed" &&
    baseline.status === "completed";
  const baselineDetail = useBaselineDetail(compareToBaseline ? baseline.id : null);

  const selectedResults =
    selectedRun && detail?.report && detail.item.id === selectedRun.id
      ? detail.report.results
      : null;
  const baselineResults =
    compareToBaseline && baselineDetail.detail?.item.id === baseline.id
      ? baselineDetail.detail.report?.results ?? null
      : null;
  const diff = useMemo(
    () =>
      selectedResults && baselineResults ? diffResults(selectedResults, baselineResults) : null,
    [selectedResults, baselineResults]
  );

  if (loading) return <EvaluationSkeleton />;
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="No evaluation runs yet"
        hint="Add questions, then run the suite to establish a baseline."
      />
    );
  }

  const comparable =
    selectedRun && baseline && selectedRun.id !== baseline.id
      ? comparableToBaseline(selectedRun, baseline)
      : false;

  return (
    <div className="flex flex-col gap-6">
      {selectedRun ? (
        <section className="flex flex-col gap-4" aria-labelledby="eval-summary-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="eval-summary-heading"
                className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Selected run
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {selectedRun.startedAt ? "Started" : "Queued"}{" "}
                <RelativeTime iso={selectedRun.startedAt ?? selectedRun.createdAt} />
                {selectedRun.isBaseline ? " · Current baseline" : ""}
                {selectedRun.questionId ? " · Single question" : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <RunStatus run={selectedRun} live />
              {selectedRun.status === "queued" || selectedRun.status === "running" ? (
                <button
                  type="button"
                  className="btn-whisper gap-1.5 px-2.5 py-1 text-xs text-destructive"
                  disabled={cancelingRunId === selectedRun.id}
                  onClick={() => void onCancel(selectedRun)}
                >
                  <XCircle className="h-3.5 w-3.5" aria-hidden />
                  {cancelingRunId === selectedRun.id ? "Cancelling…" : "Cancel run"}
                </button>
              ) : null}
            </div>
          </div>

          <RunSummary
            run={selectedRun}
            results={selectedResults}
            baselineSummary={comparable ? baseline?.summary ?? null : null}
            diff={diff}
            routes={routes}
          />

          {selectedRun.error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {selectedRun.error}
            </p>
          ) : null}

          {compareToBaseline && baseline ? (
            <BaselineDiff
              diff={diff}
              loading={baselineDetail.loading || (selectedResults === null && detailLoading)}
              error={baselineDetail.error}
              sameSetup={sameConfiguration(
                selectedRun.configuration,
                baseline.configuration
              )}
              sameQuestions={comparable}
              onRetry={baselineDetail.retry}
              onShow={(questionId) =>
                setFocusRequest((current) => ({
                  questionId,
                  nonce: (current?.nonce ?? 0) + 1
                }))
              }
            />
          ) : null}

          {detailLoading && detail?.item.id !== selectedRun.id ? (
            <div role="status" className="skeleton h-28 rounded-lg">
              <span className="sr-only">Loading run details…</span>
            </div>
          ) : selectedResults ? (
            <ResultDetails results={selectedResults} focusRequest={focusRequest} />
          ) : selectedRun.status === "completed" ? (
            <div
              role={detailError ? "alert" : undefined}
              className="flex items-center gap-3 text-sm text-muted-foreground"
            >
              <span>
                {detailLoading
                  ? "Run details are loading…"
                  : detailError ?? "Run details could not be loaded."}
              </span>
              {!detailLoading ? (
                <button
                  type="button"
                  className="btn-whisper px-2.5 py-1 text-xs"
                  onClick={onRetryDetail}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <RunHistory
        runs={runs}
        selectedRunId={selectedRun?.id ?? null}
        onSelect={onSelect}
        onBaseline={onBaseline}
      />
    </div>
  );
}

/** The baseline run's detail, fetched once per baseline id. */
function useBaselineDetail(baselineId: string | null): {
  detail: EvalRunDetailResponse | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const [detail, setDetail] = useState<EvalRunDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!baselineId || detail?.item.id === baselineId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getEvalRun(baselineId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? `The baseline run could not load: ${reason.message}`
              : "The baseline run could not load."
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `detail` is read only to skip refetching the baseline already held.
  }, [baselineId, nonce]);

  const retry = useCallback(() => setNonce((current) => current + 1), []);
  return { detail, loading, error, retry };
}

function RunHistory({
  runs,
  selectedRunId,
  onSelect,
  onBaseline
}: {
  runs: EvalRunListItem[];
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  onBaseline: (run: EvalRunListItem) => Promise<void>;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="run-history-heading">
      <h2
        id="run-history-heading"
        className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Run history
      </h2>
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Started / queued</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Pass</th>
              <th className="hidden px-3 py-2 text-right font-medium lg:table-cell">Citation</th>
              <th className="hidden px-3 py-2 text-right font-medium lg:table-cell">Progress</th>
              <th className="px-3 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const trial = run.configuration?.trial === true;
              return (
                <tr
                  key={run.id}
                  className={cn(
                    "border-t border-border hover:bg-muted/40",
                    selectedRunId === run.id && "bg-primary/5"
                  )}
                >
                  <td className="whitespace-nowrap px-3 py-2">
                    <button
                      type="button"
                      onClick={() => onSelect(run.id)}
                      aria-pressed={selectedRunId === run.id}
                      className="rounded text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <RelativeTime iso={run.startedAt ?? run.createdAt} />
                    </button>
                    {!run.startedAt ? (
                      <span className="ml-1 text-xs text-muted-foreground">queued</span>
                    ) : null}
                    {trial ? (
                      <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        Trial
                      </span>
                    ) : null}
                    {run.questionId ? (
                      <span className="ml-2 text-xs text-muted-foreground">single</span>
                    ) : null}
                    <span className="mt-1 block text-xs tabular-nums text-muted-foreground lg:hidden">
                      Citation {formatPct(run.summary?.citationAccuracyPct ?? null)} ·{" "}
                      {run.completedQuestions}/{run.questionCount} answered
                    </span>
                    <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground sm:hidden">
                      Pass {formatPass(run)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <RunStatus run={run} compact />
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-2 text-right tabular-nums sm:table-cell">
                    {formatPass(run)}
                  </td>
                  <td className="hidden px-3 py-2 text-right tabular-nums lg:table-cell">
                    {formatPct(run.summary?.citationAccuracyPct ?? null)}
                  </td>
                  <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground lg:table-cell">
                    {run.completedQuestions}/{run.questionCount}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {run.isBaseline ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                        <Star className="h-3.5 w-3.5" aria-hidden />
                        <span className="hidden lg:inline">Baseline</span>
                        <span className="sr-only lg:hidden">Baseline</span>
                      </span>
                    ) : run.status === "completed" ? (
                      <button
                        type="button"
                        className="btn-whisper gap-1.5 px-2.5 py-1 text-xs"
                        aria-label="Set as baseline"
                        title="Set as baseline"
                        onClick={() => void onBaseline(run)}
                      >
                        <Star className="h-3.5 w-3.5" aria-hidden />
                        <span className="hidden lg:inline">Set baseline</span>
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** "17/20 · 85.0%", or a dash before the run has a score. */
function formatPass(run: EvalRunListItem): string {
  if (!run.summary || run.summary.totalQuestions === 0) return "—";
  return `${run.summary.passed}/${run.summary.totalQuestions} · ${formatPct(evalPassRate(run.summary))}`;
}

export function RunStatus({
  run,
  compact = false,
  live = false
}: {
  run: EvalRunListItem;
  compact?: boolean;
  live?: boolean;
}): JSX.Element {
  const copy =
    run.status === "queued"
      ? "Queued"
      : run.status === "running"
        ? "Running"
        : run.status === "completed"
          ? "Completed"
          : "Failed";
  return (
    <span
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium",
        compact ? "text-xs" : "text-sm",
        run.status === "completed"
          ? "bg-success/15 text-success"
          : run.status === "failed"
            ? "bg-destructive/15 text-destructive"
            : "bg-primary/10 text-primary"
      )}
    >
      {run.status === "completed" ? (
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
      ) : run.status === "failed" ? (
        <XCircle className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden />
      )}
      {copy}
    </span>
  );
}

export function EvaluationSkeleton(): JSX.Element {
  return (
    <div role="status" className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <div key={item} className="skeleton h-20 rounded-lg" />
        ))}
      </div>
      <div className="skeleton h-44 rounded-lg" />
      <span className="sr-only">Loading evaluations…</span>
    </div>
  );
}
