import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import {
  CheckCircle2,
  FlaskConical,
  Pencil,
  Play,
  Plus,
  Star,
  Trash2,
  XCircle
} from "lucide-react";
import {
  cancelEvalRun,
  createEvalQuestion,
  deleteEvalQuestion,
  getEvalRun,
  listDocuments,
  listEvalQuestions,
  listEvalRuns,
  setEvalBaseline,
  startEvalRun,
  updateEvalQuestion
} from "@/lib/api";
import {
  comparableToBaseline,
  compareMetric,
  evalPassRate,
  type MetricDelta
} from "@/lib/evaluationMetrics";
import { SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import type {
  CurrentUser,
  DocumentListItem,
  EvalQuestionItem,
  EvalQuestionKind,
  EvalQuestionResult,
  EvalRunDetailResponse,
  EvalRunListItem,
  EvalRunListResponse,
  EvalSummary,
  SaveEvalQuestionRequest
} from "@/types/api";

interface AdminEvaluationsPageProps {
  user: CurrentUser;
}

type CenterTab = "results" | "questions";

export function AdminEvaluationsPage({
  user
}: AdminEvaluationsPageProps): JSX.Element {
  if (user.role !== "super_user") {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Forbidden</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Evaluation Center is restricted to super users.
        </p>
      </div>
    );
  }
  return <EvaluationCenter />;
}

function EvaluationCenter(): JSX.Element {
  const [tab, setTab] = useState<CenterTab>("results");
  const [runsState, setRunsState] = useState<EvalRunListResponse | null>(null);
  const [questions, setQuestions] = useState<EvalQuestionItem[]>([]);
  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EvalRunDetailResponse | null>(null);
  const [detailRequestNonce, setDetailRequestNonce] = useState(0);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [judge, setJudge] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelingRunId, setCancelingRunId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EvalQuestionItem | null>(null);
  const requestGenerationRef = useRef(0);
  const programGenerationRef = useRef(0);

  const applyRuns = useCallback((nextRuns: EvalRunListResponse): void => {
    setRunsState(nextRuns);
    setSelectedRunId((current) =>
      current && nextRuns.items.some((run) => run.id === current)
        ? current
        : nextRuns.items[0]?.id ?? null
    );
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++requestGenerationRef.current;
    setError(null);
    const [runsResult, questionsResult, documentsResult] = await Promise.allSettled([
      listEvalRuns(),
      listEvalQuestions(),
      listDocuments()
    ]);
    if (generation !== requestGenerationRef.current) return;
    if (runsResult.status === "fulfilled") applyRuns(runsResult.value);
    if (questionsResult.status === "fulfilled") {
      setQuestions(questionsResult.value.items);
    }
    if (documentsResult.status === "fulfilled") {
      setDocuments(documentsResult.value.items);
    }
    const failures = [runsResult, questionsResult, documentsResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) =>
        result.reason instanceof Error ? result.reason.message : "Evaluation data could not load"
      );
    setError(failures.length > 0 ? Array.from(new Set(failures)).join(" · ") : null);
    setLoading(false);
  }, [applyRuns]);

  const refreshRunProgress = useCallback(async (): Promise<void> => {
    const generation = ++requestGenerationRef.current;
    try {
      const next = await listEvalRuns();
      if (generation === requestGenerationRef.current) applyRuns(next);
    } catch (reason) {
      if (generation === requestGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : "Run progress could not load");
      }
    }
  }, [applyRuns]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    function reloadForProgram(): void {
      programGenerationRef.current += 1;
      setLoading(true);
      setRunsState(null);
      setQuestions([]);
      setDocuments([]);
      setSelectedRunId(null);
      setDetail(null);
      setDetailError(null);
      setFormOpen(false);
      setEditing(null);
      setStarting(false);
      setCancelingRunId(null);
      void refresh();
    }
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reloadForProgram);
    window.addEventListener("storage", reloadForProgram);
    return () => {
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reloadForProgram);
      window.removeEventListener("storage", reloadForProgram);
    };
  }, [refresh]);

  const activeRun = runsState?.items.find(
    (run) => run.status === "queued" || run.status === "running"
  );
  const activeRunId = activeRun?.id;
  const selectedRunStatus = runsState?.items.find(
    (run) => run.id === selectedRunId
  )?.status;
  const selectedRunTerminalStatus =
    selectedRunStatus === "completed" || selectedRunStatus === "failed"
      ? selectedRunStatus
      : null;

  useEffect(() => {
    if (!activeRunId) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      await refreshRunProgress();
      if (!cancelled) {
        timer = window.setTimeout(() => void poll(), 2_500);
      }
    };
    timer = window.setTimeout(() => void poll(), 2_500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeRunId, refreshRunProgress]);

  useEffect(() => {
    if (!selectedRunId || runsState?.persistenceReady === false) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    getEvalRun(selectedRunId)
      .then((next) => {
        if (!cancelled) {
          setDetail(next);
          setDetailError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setDetailError(
            reason instanceof Error ? reason.message : "Evaluation run could not load"
          );
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    runsState?.persistenceReady,
    selectedRunId,
    selectedRunTerminalStatus,
    detailRequestNonce
  ]);

  async function beginRun(questionId?: string): Promise<void> {
    const programGeneration = programGenerationRef.current;
    setStarting(true);
    setError(null);
    try {
      const item = await startEvalRun({ judge, ...(questionId ? { questionId } : {}) });
      if (programGeneration !== programGenerationRef.current) return;
      setRunsState((current) =>
        current
          ? { ...current, items: [item, ...current.items.filter((run) => run.id !== item.id)] }
          : current
      );
      setSelectedRunId(item.id);
      setTab("results");
      setDetail({ item, report: null });
    } catch (reason) {
      if (programGeneration === programGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : "Evaluation could not start");
      }
    } finally {
      if (programGeneration === programGenerationRef.current) setStarting(false);
    }
  }

  async function makeBaseline(run: EvalRunListItem): Promise<void> {
    const programGeneration = programGenerationRef.current;
    setError(null);
    try {
      await setEvalBaseline(run.id);
      if (programGeneration === programGenerationRef.current) await refresh();
    } catch (reason) {
      if (programGeneration === programGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : "Baseline could not be updated");
      }
    }
  }

  async function cancelRun(run: EvalRunListItem): Promise<void> {
    if (!window.confirm("Cancel this evaluation run? It will stop after the current question finishes.")) {
      return;
    }
    const programGeneration = programGenerationRef.current;
    setCancelingRunId(run.id);
    setError(null);
    try {
      const item = await cancelEvalRun(run.id);
      if (programGeneration !== programGenerationRef.current) return;
      setRunsState((current) =>
        current
          ? {
              ...current,
              items: current.items.map((candidate) =>
                candidate.id === item.id ? item : candidate
              )
            }
          : current
      );
      setDetail((current) =>
        current?.item.id === item.id ? { ...current, item } : current
      );
    } catch (reason) {
      if (programGeneration === programGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : "Evaluation could not be cancelled");
      }
    } finally {
      if (programGeneration === programGenerationRef.current) setCancelingRunId(null);
    }
  }

  function openCreate(): void {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(item: EvalQuestionItem): void {
    setEditing(item);
    setFormOpen(true);
  }

  const noProgramSelected = runsState?.noProgramSelected === true;
  const persistenceReady = runsState?.persistenceReady ?? false;
  const selectedRun =
    runsState?.items.find((run) => run.id === selectedRunId) ?? detail?.item ?? null;
  const baseline = runsState?.items.find((run) => run.isBaseline) ?? null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            Evaluation Center
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Test retrieval, citations, answers, and safe refusals against a versioned
            question set before changing the production pipeline.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex flex-col items-start gap-0.5">
            <label className="inline-flex min-h-6 items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={judge}
                onChange={(event) => setJudge(event.target.checked)}
                disabled={starting || Boolean(activeRun)}
                className="h-4 w-4 rounded border-input accent-primary"
                aria-describedby="faithfulness-cost-help"
              />
              Judge faithfulness
            </label>
            <span id="faithfulness-cost-help" className="text-[11px] text-muted-foreground">
              One extra model call per non-refused answer.
            </span>
          </div>
          <button
            type="button"
            className="btn-primary gap-2 px-5 py-2 text-base"
            onClick={() => void beginRun()}
            disabled={
              starting ||
              Boolean(activeRun) ||
              !persistenceReady ||
              noProgramSelected ||
              questions.length === 0
            }
          >
            <Play className="h-4 w-4" aria-hidden />
            {starting ? "Queueing…" : activeRun ? "Run in progress" : "Run evaluation"}
          </button>
        </div>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {noProgramSelected ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Choose a program in the header to manage its evaluation set and runs.
        </div>
      ) : !loading && runsState?.persistenceReady === false ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning-foreground">
          Evaluation storage is not installed yet. Questions remain editable, but runs
          are disabled until the Replit DDL is applied and the worker is restarted.
        </div>
      ) : null}

      {!noProgramSelected ? (
        <>
          <div
            role="tablist"
            aria-label="Evaluation Center sections"
            className="flex w-fit overflow-hidden rounded-lg border border-border bg-card"
          >
            <TabButton tab="results" active={tab === "results"} onSelect={setTab}>
              Runs
            </TabButton>
            <TabButton tab="questions" active={tab === "questions"} onSelect={setTab}>
              Questions <span className="tabular-nums">{questions.length}</span>
            </TabButton>
          </div>

          <div
            role="tabpanel"
            id={`evaluation-${tab}-panel`}
            aria-labelledby={`evaluation-${tab}-tab`}
          >
            {tab === "results" ? (
              <RunsPanel
                loading={loading}
                detailLoading={detailLoading}
                detailError={detailError}
                runs={runsState?.items ?? []}
                selectedRun={selectedRun}
                detail={detail}
                baseline={baseline}
                cancelingRunId={cancelingRunId}
                onSelect={setSelectedRunId}
                onRetryDetail={() => setDetailRequestNonce((current) => current + 1)}
                onBaseline={makeBaseline}
                onCancel={cancelRun}
              />
            ) : (
              <QuestionsPanel
                items={questions}
                documents={documents}
                loading={loading}
                formOpen={formOpen}
                editing={editing}
                scopeGeneration={programGenerationRef.current}
                runDisabled={starting || Boolean(activeRun) || !persistenceReady}
                onCreate={openCreate}
                onEdit={openEdit}
                onCancelForm={() => {
                  setFormOpen(false);
                  setEditing(null);
                }}
                onSaved={(item, scopeGeneration) => {
                  if (scopeGeneration !== programGenerationRef.current) return;
                  setQuestions((current) => {
                    const exists = current.some((question) => question.id === item.id);
                    return exists
                      ? current.map((question) => (question.id === item.id ? item : question))
                      : [item, ...current];
                  });
                  setFormOpen(false);
                  setEditing(null);
                }}
                onDeleted={(id, scopeGeneration) => {
                  if (scopeGeneration !== programGenerationRef.current) return;
                  setQuestions((current) => current.filter((question) => question.id !== id));
                }}
                onRun={(id) => void beginRun(id)}
                onError={(message, scopeGeneration) => {
                  if (scopeGeneration === programGenerationRef.current) setError(message);
                }}
              />
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function TabButton({
  tab,
  active,
  onSelect,
  children
}: {
  tab: CenterTab;
  active: boolean;
  onSelect: (tab: CenterTab) => void;
  children: ReactNode;
}): JSX.Element {
  const other: CenterTab = tab === "results" ? "questions" : "results";
  return (
    <button
      type="button"
      role="tab"
      id={`evaluation-${tab}-tab`}
      aria-controls={`evaluation-${tab}-panel`}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={() => onSelect(tab)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onSelect(other);
        requestAnimationFrame(() =>
          document.getElementById(`evaluation-${other}-tab`)?.focus()
        );
      }}
      className={cn(
        "px-4 py-2 text-sm font-medium transition-colors duration-100",
        active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"
      )}
    >
      {children}
    </button>
  );
}

function RunsPanel({
  loading,
  detailLoading,
  detailError,
  runs,
  selectedRun,
  detail,
  baseline,
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
  cancelingRunId: string | null;
  onSelect: (id: string) => void;
  onRetryDetail: () => void;
  onBaseline: (run: EvalRunListItem) => Promise<void>;
  onCancel: (run: EvalRunListItem) => Promise<void>;
}): JSX.Element {
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
        <section className="flex flex-col gap-3" aria-labelledby="eval-summary-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="eval-summary-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Selected run
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {selectedRun.startedAt ? "Started" : "Queued"}{" "}
                <RelativeTime iso={selectedRun.startedAt ?? selectedRun.createdAt} />
                {selectedRun.isBaseline ? " · Current baseline" : ""}
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

          {baseline && selectedRun.id !== baseline.id && !comparable ? (
            <p className="rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
              Baseline deltas are hidden because the question count, single-question
              scope, or pipeline configuration changed.
            </p>
          ) : null}

          <SummaryMetrics
            summary={selectedRun.summary}
            baseline={comparable ? baseline?.summary ?? null : null}
          />

          {selectedRun.configuration ? (
            <p className="text-xs text-muted-foreground">
              {selectedRun.configuration.generation.label} + {selectedRun.configuration.fallback.label} fallback · top {selectedRun.configuration.retrieval.topK}
              {" · "}threshold {selectedRun.configuration.retrieval.threshold}
              {selectedRun.judge ? " · faithfulness judge on" : ""}
            </p>
          ) : null}

          {selectedRun.error ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {selectedRun.error}
            </p>
          ) : null}

          {detailLoading && detail?.item.id !== selectedRun.id ? (
            <div role="status" className="skeleton h-28 rounded-lg">
              <span className="sr-only">Loading run details…</span>
            </div>
          ) : detail?.report && detail.item.id === selectedRun.id ? (
            <ResultDetails results={detail.report.results} />
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

      <section className="flex flex-col gap-3" aria-labelledby="run-history-heading">
        <h2 id="run-history-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Run history
        </h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-card">
          <table className="w-full min-w-[48rem] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Started / queued</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Pass</th>
                <th className="px-3 py-2 text-right font-medium">Citation</th>
                <th className="px-3 py-2 text-right font-medium">Progress</th>
                <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className={cn("border-t border-border", selectedRun?.id === run.id && "bg-primary/5")}>
                  <td className="whitespace-nowrap px-3 py-2">
                    <button
                      type="button"
                      onClick={() => onSelect(run.id)}
                      aria-pressed={selectedRun?.id === run.id}
                      className="rounded text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <RelativeTime iso={run.startedAt ?? run.createdAt} />
                    </button>
                    {!run.startedAt ? <span className="ml-1 text-xs text-muted-foreground">queued</span> : null}
                    {run.questionId ? <span className="ml-2 text-xs text-muted-foreground">single</span> : null}
                  </td>
                  <td className="px-3 py-2"><RunStatus run={run} compact /></td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPct(evalPassRate(run.summary))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPct(run.summary?.citationAccuracyPct ?? null)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {run.completedQuestions}/{run.questionCount}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {run.isBaseline ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                        <Star className="h-3.5 w-3.5" aria-hidden /> Baseline
                      </span>
                    ) : run.status === "completed" ? (
                      <button type="button" className="btn-whisper gap-1.5 px-2.5 py-1 text-xs" onClick={() => void onBaseline(run)}>
                        <Star className="h-3.5 w-3.5" aria-hidden /> Set baseline
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function SummaryMetrics({
  summary,
  baseline
}: {
  summary: EvalSummary | null;
  baseline: EvalSummary | null;
}): JSX.Element {
  const currentPass = evalPassRate(summary);
  const baselinePass = evalPassRate(baseline);
  const judgeFailures = summary?.judgeFailures ?? 0;
  const fallbackGenerationCount = summary?.fallbackGenerationCount ?? 0;
  const failedFallbackCount = summary?.failedFallbackCount ?? 0;
  const metrics = [
    { label: "Overall pass", value: currentPass, baseline: baselinePass, higher: true },
    { label: "Answer accuracy", value: summary?.answerAccuracyPct ?? null, baseline: baseline?.answerAccuracyPct ?? null, higher: true },
    { label: "Citation accuracy", value: summary?.citationAccuracyPct ?? null, baseline: baseline?.citationAccuracyPct ?? null, higher: true },
    { label: "Out-of-KB refused", value: summary?.outOfKbRefusalRatePct ?? null, baseline: baseline?.outOfKbRefusalRatePct ?? null, higher: true },
    { label: "Retrieval recall", value: summary?.retrievalRecallPct ?? null, baseline: baseline?.retrievalRecallPct ?? null, higher: true },
    { label: "Rerank recall", value: summary?.rerankRecallPct ?? null, baseline: baseline?.rerankRecallPct ?? null, higher: true }
  ];
  return (
    <>
      <dl className="grid overflow-hidden rounded-lg border border-border bg-card shadow-card sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map((metric) => (
          <Metric
            key={metric.label}
            label={metric.label}
            value={formatPct(metric.value)}
            delta={compareMetric(metric.value, metric.baseline, metric.higher)}
          />
        ))}
      </dl>
      {summary ? (
        <div className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-2">
          <p>
            Latency <span className="font-medium text-foreground tabular-nums">p50 {summary.latencyP50Ms} ms · p95 {summary.latencyP95Ms} ms</span>
          </p>
          <p>
            In-KB refusal <span className="font-medium text-foreground tabular-nums">{formatPct(summary.inKbRefusalRatePct)}</span>
            {summary.judgedQuestions > 0 || judgeFailures > 0
              ? ` · Faithfulness ${formatPct(summary.meanFaithfulnessPct)} over ${summary.judgedQuestions} scored · ${judgeFailures} judge failure${judgeFailures === 1 ? "" : "s"} · ${summary.unfaithfulQuestions} answer${summary.unfaithfulQuestions === 1 ? "" : "s"} with unsupported claims`
              : ""}
          </p>
          <p>
            Mean expected source rank{" "}
            <span className="font-medium text-foreground tabular-nums">
              {summary.expectedDocRankMean === null ? "—" : summary.expectedDocRankMean.toFixed(1)}
            </span>
          </p>
          <p>
            Generation fallback{" "}
            <span className="font-medium text-foreground tabular-nums">
              {fallbackGenerationCount}/{summary.totalQuestions}
            </span>
            {failedFallbackCount > 0
              ? ` · ${failedFallbackCount} failed both routes`
              : ""}
          </p>
          <p className="sm:col-span-2">
            Failure stage · retrieval {summary.inKbFailuresByStage.retrieval} · rerank {summary.inKbFailuresByStage.rerank} · threshold {summary.inKbFailuresByStage.threshold} · generation {summary.inKbFailuresByStage.generation} · unattributed {summary.inKbFailuresByStage.unattributed}
          </p>
        </div>
      ) : null}
    </>
  );
}

function Metric({ label, value, delta }: { label: string; value: string; delta: MetricDelta | null }): JSX.Element {
  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 lg:border-b lg:border-r lg:[&:nth-child(3n)]:border-r-0 lg:[&:nth-last-child(-n+3)]:border-b-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums">{value}</span>
        {delta ? (
          <span className={cn("text-xs tabular-nums", delta.tone === "better" ? "text-success" : delta.tone === "worse" ? "text-destructive" : "text-muted-foreground")}>
            {delta.value > 0 ? "+" : ""}{delta.value.toFixed(1)} pts
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function RunStatus({ run, compact = false, live = false }: { run: EvalRunListItem; compact?: boolean; live?: boolean }): JSX.Element {
  const copy = run.status === "queued" ? "Queued" : run.status === "running" ? "Running" : run.status === "completed" ? "Completed" : "Failed";
  return (
    <span role={live ? "status" : undefined} aria-live={live ? "polite" : undefined} className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium", compact ? "text-xs" : "text-sm", run.status === "completed" ? "bg-success/15 text-success" : run.status === "failed" ? "bg-destructive/15 text-destructive" : "bg-primary/10 text-primary")}>
      {run.status === "completed" ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : run.status === "failed" ? <XCircle className="h-3.5 w-3.5" aria-hidden /> : <span className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden />}
      {copy}
    </span>
  );
}

function ResultDetails({ results }: { results: EvalQuestionResult[] }): JSX.Element {
  const ordered = useMemo(
    () =>
      [...results].sort((left, right) => {
        const severity = (result: EvalQuestionResult) =>
          !result.pass ? 0 : result.unsupportedClaims.length > 0 ? 1 : 2;
        return severity(left) - severity(right);
      }),
    [results]
  );
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium">Question results</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">Failures and passing answers with unsupported claims appear first. Open a row for its evidence checks.</p>
      </div>
      <ul className="divide-y divide-border">
        {ordered.map((result) => (
          <li key={result.questionId}>
            <details className="group px-4 py-3 open:bg-muted/25">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{result.question}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{result.kind === "in-kb" ? "In-KB" : "Expected refusal"}{result.failureStage ? ` · lost at ${result.failureStage}` : ""} · {result.latencyMs} ms</span>
                </span>
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", !result.pass ? "bg-destructive/15 text-destructive" : result.unsupportedClaims.length > 0 ? "bg-warning/20 text-warning-foreground" : "bg-success/15 text-success")}>{!result.pass ? "Fail" : result.unsupportedClaims.length > 0 ? "Review" : "Pass"}</span>
              </summary>
              <div className="mt-3 grid gap-3 border-t border-border pt-3 text-sm lg:grid-cols-2">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Answer</p>
                  <p className="mt-1 whitespace-pre-wrap leading-relaxed">{result.answer || "No answer returned."}</p>
                </div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  {result.error ? <p className="text-destructive">Error: {result.error}</p> : null}
                  <p>Citation: {formatCheck(result.citationCorrect)}</p>
                  <p>Expected phrases: {formatCheck(result.answerCorrect)}</p>
                  <p>Retrieval hit: {formatCheck(result.retrievalHit)}</p>
                   <p>Rerank hit: {formatCheck(result.rerankHit)}</p>
                   <p>
                     Expected source rank:{" "}
                     {result.expectedDocId
                       ? result.expectedDocRank ?? "not found"
                       : "not applicable"}
                   </p>
                   <p>Top retrieval score: {result.topScore === null ? "not available" : result.topScore.toFixed(3)}</p>
                   <p>Generation path: {formatGenerationPath(result.generationPath)}</p>
                   {result.faithfulnessJudgeFailed ? <p className="text-warning-foreground">Faithfulness judge failed for this answer.</p> : null}
                   <p>Refused: {result.refused ? "yes" : "no"}</p>
                  {result.unsupportedClaims.map((claim) => <p key={claim} className="text-destructive">Unsupported: {claim}</p>)}
                </div>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function QuestionsPanel({
  items,
  documents,
  loading,
  formOpen,
  editing,
  scopeGeneration,
  runDisabled,
  onCreate,
  onEdit,
  onCancelForm,
  onSaved,
  onDeleted,
  onRun,
  onError
}: {
  items: EvalQuestionItem[];
  documents: DocumentListItem[];
  loading: boolean;
  formOpen: boolean;
  editing: EvalQuestionItem | null;
  scopeGeneration: number;
  runDisabled: boolean;
  onCreate: () => void;
  onEdit: (item: EvalQuestionItem) => void;
  onCancelForm: () => void;
  onSaved: (item: EvalQuestionItem, scopeGeneration: number) => void;
  onDeleted: (id: string, scopeGeneration: number) => void;
  onRun: (id: string) => void;
  onError: (message: string | null, scopeGeneration: number) => void;
}): JSX.Element {
  async function remove(item: EvalQuestionItem): Promise<void> {
    if (!window.confirm(`Delete this evaluation question?\n\n${item.question}`)) return;
    onError(null, scopeGeneration);
    try {
      await deleteEvalQuestion(item.id);
      onDeleted(item.id, scopeGeneration);
    } catch (reason) {
      onError(
        reason instanceof Error ? reason.message : "Question could not be deleted",
        scopeGeneration
      );
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="eval-questions-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="eval-questions-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Question set</h2>
          <p className="mt-1 text-sm text-muted-foreground">In-KB questions verify answers and sources. Refusal questions verify the assistant stays inside the documents.</p>
        </div>
        {!formOpen ? (
          <button type="button" className="btn-whisper gap-1.5 px-3 py-1.5 text-sm" onClick={onCreate}>
            <Plus className="h-4 w-4" aria-hidden /> Add question
          </button>
        ) : null}
      </div>

      {formOpen ? (
        <QuestionForm
          key={editing?.id ?? "new"}
          item={editing}
          documents={documents}
          scopeGeneration={scopeGeneration}
          onCancel={onCancelForm}
          onSaved={onSaved}
        />
      ) : null}

      {loading ? (
        <div role="status" className="skeleton h-40 rounded-lg"><span className="sr-only">Loading evaluation questions…</span></div>
      ) : items.length === 0 ? (
        <EmptyState icon={FlaskConical} title="No evaluation questions" hint="Add one answerable question and one expected refusal to start a useful suite." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-card">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Question</th>
                <th className="px-3 py-2 font-medium">Expected</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-border align-top hover:bg-muted/30">
                  <td className="max-w-lg px-3 py-2">
                    <span className="font-medium">{item.question}</span>
                    {item.notes ? <span className="mt-1 block line-clamp-1 text-xs text-muted-foreground">{item.notes}</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", item.kind === "in-kb" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>{item.kind === "in-kb" ? "Answer" : "Refuse"}</span>
                  </td>
                  <td className="max-w-xs px-3 py-2 text-muted-foreground">
                    {item.expectedDocTitle ?? (item.expectedAnswerContains.length > 0 ? `${item.expectedAnswerContains.length} phrase${item.expectedAnswerContains.length === 1 ? "" : "s"}` : "—")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button type="button" className="btn-icon" aria-label={`Run: ${item.question}`} title="Run this question" disabled={runDisabled} onClick={() => onRun(item.id)}><Play className="h-4 w-4" aria-hidden /></button>
                      <button type="button" className="btn-icon" aria-label={`Edit: ${item.question}`} onClick={() => onEdit(item)}><Pencil className="h-4 w-4" aria-hidden /></button>
                      <button type="button" className="btn-icon text-destructive" aria-label={`Delete: ${item.question}`} onClick={() => void remove(item)}><Trash2 className="h-4 w-4" aria-hidden /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function QuestionForm({ item, documents, scopeGeneration, onCancel, onSaved }: { item: EvalQuestionItem | null; documents: DocumentListItem[]; scopeGeneration: number; onCancel: () => void; onSaved: (item: EvalQuestionItem, scopeGeneration: number) => void }): JSX.Element {
  const [kind, setKind] = useState<EvalQuestionKind>(item?.kind ?? "in-kb");
  const [question, setQuestion] = useState(item?.question ?? "");
  const [expectedDocId, setExpectedDocId] = useState(item?.expectedDocId ?? "");
  const [phrases, setPhrases] = useState(item?.expectedAnswerContains.join("\n") ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const expectedAnswerContains = Array.from(new Set(phrases.split("\n").map((value) => value.trim()).filter(Boolean)));
    if (kind === "in-kb" && !expectedDocId && expectedAnswerContains.length === 0) {
      setError("Choose an expected document or add at least one expected phrase.");
      return;
    }
    const payload: SaveEvalQuestionRequest = {
      kind,
      question: question.trim(),
      expectedDocId: kind === "in-kb" ? expectedDocId || null : null,
      expectedAnswerContains: kind === "in-kb" ? expectedAnswerContains : [],
      notes: notes.trim() || null
    };
    setSaving(true);
    setError(null);
    try {
      onSaved(
        item ? await updateEvalQuestion(item.id, payload) : await createEvalQuestion(payload),
        scopeGeneration
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Question could not be saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} className="rounded-lg border border-border bg-card p-5 shadow-card">
      <div className="grid gap-4 lg:grid-cols-2">
        <fieldset className="flex gap-2 lg:col-span-2">
          <legend className="mb-1 block w-full text-sm font-medium">Expected behavior</legend>
          {(["in-kb", "out-of-kb"] as const).map((value) => (
            <label key={value} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm", kind === value ? "border-primary/50 bg-primary/5" : "border-input")}>
              <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} disabled={saving} className="accent-primary" />
              {value === "in-kb" ? "Answer from KB" : "Refuse safely"}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1 text-sm lg:col-span-2">
          <span className="font-medium">Question</span>
          <textarea value={question} onChange={(event) => setQuestion(event.target.value)} required maxLength={2000} rows={3} disabled={saving} className="resize-y rounded-md border border-input bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring" placeholder="What should the assistant answer or refuse?" />
        </label>
        {kind === "in-kb" ? (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Expected source <span className="font-normal text-muted-foreground">(optional)</span></span>
              <select value={expectedDocId} onChange={(event) => setExpectedDocId(event.target.value)} disabled={saving} className="rounded-md border border-input bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring">
                <option value="">Any source</option>
                {documents.map((document) => <option key={document.documentId} value={document.documentId}>{document.title}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Expected phrases <span className="font-normal text-muted-foreground">(one per line)</span></span>
              <textarea value={phrases} onChange={(event) => setPhrases(event.target.value)} rows={3} disabled={saving} className="resize-y rounded-md border border-input bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring" placeholder={"$25 fee\nwithin 30 days"} />
            </label>
          </>
        ) : (
          <p className="rounded-md bg-muted/45 px-3 py-2 text-sm text-muted-foreground lg:col-span-2">A passing result must refuse without citing a source.</p>
        )}
        <label className="flex flex-col gap-1 text-sm lg:col-span-2">
          <span className="font-medium">Notes <span className="font-normal text-muted-foreground">(optional)</span></span>
          <input value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} disabled={saving} className="rounded-md border border-input bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring" placeholder="Why this question matters or how to review it" />
        </label>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-whisper px-4 py-2 text-sm" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" className="btn-primary px-5 py-2 text-sm" disabled={saving || question.trim().length === 0}>{saving ? "Saving…" : item ? "Save question" : "Add question"}</button>
      </div>
    </form>
  );
}

function EvaluationSkeleton(): JSX.Element {
  return (
    <div role="status" className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((item) => <div key={item} className="skeleton h-20 rounded-lg" />)}</div>
      <div className="skeleton h-44 rounded-lg" />
      <span className="sr-only">Loading evaluations…</span>
    </div>
  );
}

function formatPct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatCheck(value: boolean | null): string {
  return value === null ? "not applicable" : value ? "pass" : "fail";
}

function formatGenerationPath(
  path: EvalQuestionResult["generationPath"]
): string {
  switch (path) {
    case "retrieval-refusal":
      return "retrieval refusal (no model call)";
    case "primary":
      return "configured primary";
    case "fallback":
      return "direct OpenAI fallback";
    case "fallback-failed":
      return "both routes failed; safe refusal";
    default:
      return "not run";
  }
}
