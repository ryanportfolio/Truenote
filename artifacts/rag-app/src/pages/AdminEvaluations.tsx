import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  cancelEvalRun,
  getEvalRun,
  getModelRouting,
  listDocuments,
  listEvalQuestions,
  listEvalRuns,
  setEvalBaseline,
  startEvalRun
} from "@/lib/api";
import { SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmDialog";
import { QuestionsPanel } from "@/components/admin/evaluations/QuestionsPanel";
import { RunLauncher } from "@/components/admin/evaluations/RunLauncher";
import { RunsPanel } from "@/components/admin/evaluations/RunsPanel";
import type {
  CurrentUser,
  DocumentListItem,
  EvalQuestionItem,
  EvalRunDetailResponse,
  EvalRunListItem,
  EvalRunListResponse,
  EvalTrialSettings,
  ModelRoutingOption
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
  const confirm = useConfirm();
  const [tab, setTab] = useState<CenterTab>("results");
  const [runsState, setRunsState] = useState<EvalRunListResponse | null>(null);
  const [questions, setQuestions] = useState<EvalQuestionItem[]>([]);
  const [expectedAnswerReady, setExpectedAnswerReady] = useState(true);
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
  // Bumped on a program switch; remounts the Questions side so open forms,
  // drafts and imports never carry over to another program.
  const [programEpoch, setProgramEpoch] = useState(0);
  const [routes, setRoutes] = useState<ModelRoutingOption[] | null>(null);
  const [routesError, setRoutesError] = useState<string | null>(null);
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
      setExpectedAnswerReady(questionsResult.value.expectedAnswerReady !== false);
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

  // Only the run-progress timer calls this, so it is a background request
  // that does not count as session activity.
  const refreshRunProgress = useCallback(async (): Promise<void> => {
    const generation = ++requestGenerationRef.current;
    try {
      const next = await listEvalRuns({ background: true });
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

  // Approved answer routes: the trial picker's options, and how a trial's
  // reasoning setting reads (toggle routes say on/off). Not program-scoped.
  useEffect(() => {
    let cancelled = false;
    getModelRouting()
      .then((config) => {
        if (!cancelled) setRoutes(config.routes);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setRoutesError(
            reason instanceof Error
              ? `Approved models could not load: ${reason.message}`
              : "Approved models could not load."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      setProgramEpoch((current) => current + 1);
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

  async function beginRun(
    { questionId, trial }: { questionId?: string; trial?: EvalTrialSettings } = {}
  ): Promise<boolean> {
    const programGeneration = programGenerationRef.current;
    setStarting(true);
    setError(null);
    try {
      const item = await startEvalRun({
        judge,
        ...(questionId ? { questionId } : {}),
        ...(trial ? { trial } : {})
      });
      if (programGeneration !== programGenerationRef.current) return false;
      setRunsState((current) =>
        current
          ? { ...current, items: [item, ...current.items.filter((run) => run.id !== item.id)] }
          : current
      );
      setSelectedRunId(item.id);
      setTab("results");
      setDetail({ item, report: null });
      return true;
    } catch (reason) {
      if (programGeneration === programGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : "Evaluation could not start");
      }
      return false;
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
    const confirmed = await confirm({
      title: "Cancel evaluation run?",
      message:
        "The worker will stop after the current question finishes. Completed results from this run will not become a report.",
      confirmLabel: "Cancel run",
      tone: "danger"
    });
    if (!confirmed) return;
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

  const noProgramSelected = runsState?.noProgramSelected === true;
  const persistenceReady = runsState?.persistenceReady ?? false;
  const selectedRun =
    runsState?.items.find((run) => run.id === selectedRunId) ?? detail?.item ?? null;
  const baseline = runsState?.items.find((run) => run.isBaseline) ?? null;
  const runs = runsState?.items;
  const lastCompleted = useMemo(
    () =>
      (runs ?? [])
        .filter((run) => run.status === "completed" && run.summary !== null)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null,
    [runs]
  );
  const latestLive = useMemo(
    () =>
      (runs ?? [])
        .filter((run) => run.configuration !== null && run.configuration.trial !== true)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null,
    [runs]
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Evaluation Center
        </h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          A test set of questions with known right answers, plus questions the assistant
          should refuse. A run asks every question through the live assistant and grades the
          answers, so you can see whether a change made answers better or worse.
        </p>
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
          are disabled until the reviewed DDL is applied and the worker is restarted.
        </div>
      ) : null}

      {!noProgramSelected ? (
        <>
          <RunLauncher
            questions={questions}
            judge={judge}
            onJudgeChange={setJudge}
            starting={starting}
            running={Boolean(activeRun)}
            disabled={loading || !persistenceReady || questions.length === 0}
            latencyP50Ms={lastCompleted?.summary?.latencyP50Ms ?? null}
            liveRetrieval={
              latestLive?.configuration
                ? {
                    threshold: latestLive.configuration.retrieval.threshold,
                    topK: latestLive.configuration.retrieval.topK
                  }
                : null
            }
            routes={routes}
            routesError={routesError}
            onRun={() => void beginRun()}
            onTrial={(trial) => beginRun({ trial })}
          />

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
            id="evaluation-results-panel"
            aria-labelledby="evaluation-results-tab"
            hidden={tab !== "results"}
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
                routes={routes ?? []}
                cancelingRunId={cancelingRunId}
                onSelect={setSelectedRunId}
                onRetryDetail={() => setDetailRequestNonce((current) => current + 1)}
                onBaseline={makeBaseline}
                onCancel={cancelRun}
              />
            ) : null}
          </div>
          {/* Stays mounted on the Runs tab so drafts and imports survive a
              single-question run, which switches to Runs. */}
          <div
            role="tabpanel"
            id="evaluation-questions-panel"
            aria-labelledby="evaluation-questions-tab"
            hidden={tab !== "questions"}
          >
            <QuestionsPanel
              key={programEpoch}
              items={questions}
              documents={documents}
              loading={loading}
              expectedAnswerReady={expectedAnswerReady}
              scopeGeneration={programGenerationRef.current}
              runDisabled={starting || Boolean(activeRun) || !persistenceReady}
              onSaved={(item, scopeGeneration) => {
                if (scopeGeneration !== programGenerationRef.current) return;
                setQuestions((current) => {
                  const exists = current.some((question) => question.id === item.id);
                  return exists
                    ? current.map((question) => (question.id === item.id ? item : question))
                    : [item, ...current];
                });
              }}
              onCreatedMany={(items, scopeGeneration) => {
                if (scopeGeneration !== programGenerationRef.current) return;
                setQuestions((current) => [...items, ...current]);
              }}
              onDeleted={(id, scopeGeneration) => {
                if (scopeGeneration !== programGenerationRef.current) return;
                setQuestions((current) => current.filter((question) => question.id !== id));
              }}
              onRun={(id) => void beginRun({ questionId: id })}
              onError={(message, scopeGeneration) => {
                if (scopeGeneration === programGenerationRef.current) setError(message);
              }}
            />
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
