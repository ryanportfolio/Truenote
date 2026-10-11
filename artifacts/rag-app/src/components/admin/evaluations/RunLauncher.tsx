import { useEffect, useId, useState, type FormEvent } from "react";
import { FlaskConical, Play } from "lucide-react";
import { estimate } from "@/lib/evaluationMetrics";
import { cn } from "@/lib/utils";
import type {
  EvalQuestionItem,
  EvalTrialSettings,
  ModelRoutingOption,
  ReasoningEffort
} from "@/types/api";

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "None (reasoning off)",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high"
};

const INPUT_CLASS =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function initialEffort(route: ModelRoutingOption): ReasoningEffort | "" {
  if (route.supportedEfforts.includes(route.reasoningEffort)) return route.reasoningEffort;
  if (route.supportedEfforts.includes(route.defaultReasoningEffort)) {
    return route.defaultReasoningEffort;
  }
  return route.supportedEfforts[0] ?? "";
}

export function RunLauncher({
  questions,
  judge,
  onJudgeChange,
  starting,
  running,
  disabled,
  latencyP50Ms,
  liveRetrieval,
  routes,
  routesError,
  onRun,
  onTrial
}: {
  questions: EvalQuestionItem[];
  judge: boolean;
  onJudgeChange: (judge: boolean) => void;
  starting: boolean;
  /** A run is queued or running for this program. */
  running: boolean;
  /** Runs cannot start (no storage, no program, or no questions). */
  disabled: boolean;
  /** p50 latency of the last completed run; null hides the time estimate. */
  latencyP50Ms: number | null;
  /** Retrieval settings of the latest live run, shown as placeholders. */
  liveRetrieval: { threshold: number; topK: number } | null;
  /** Approved routes for answers; null while loading. */
  routes: ModelRoutingOption[] | null;
  routesError: string | null;
  onRun: () => void;
  /** Resolves true when the trial run was queued. */
  onTrial: (trial: EvalTrialSettings) => Promise<boolean>;
}): JSX.Element {
  const [trialOpen, setTrialOpen] = useState(false);
  const blocked = disabled || starting || running;
  const expectedAnswers = questions.filter(
    (question) => question.kind === "in-kb" && Boolean(question.expectedAnswer)
  ).length;
  const plan = estimate({
    questions: questions.length,
    judge,
    expectedAnswers,
    latencyP50Ms
  });

  return (
    <section
      aria-label="Start an evaluation"
      className="rounded-lg border border-border bg-card p-5 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary gap-2 px-5 py-2 text-base"
          onClick={onRun}
          disabled={blocked}
        >
          <Play className="h-4 w-4" aria-hidden />
          {starting ? "Queueing…" : running ? "Run in progress" : "Run evaluation"}
        </button>
        <button
          type="button"
          className={cn("btn-whisper gap-2 px-4 py-2", trialOpen && "bg-muted")}
          aria-expanded={trialOpen}
          aria-controls="eval-trial-panel"
          onClick={() => setTrialOpen((current) => !current)}
        >
          <FlaskConical className="h-4 w-4" aria-hidden />
          Trial run
        </button>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={judge}
            onChange={(event) => onJudgeChange(event.target.checked)}
            disabled={starting || running}
            className="h-4 w-4 rounded border-input accent-primary"
            aria-describedby="eval-judge-help"
          />
          Judge faithfulness
        </label>
        <span id="eval-judge-help" className="text-xs text-muted-foreground">
          Checks each answer against its excerpts; one extra model call per answer.
        </span>
      </div>

      <p className="mt-3 text-xs tabular-nums text-muted-foreground">
        {plan.questions} question{plan.questions === 1 ? "" : "s"} · about {plan.answerCalls} answer
        call{plan.answerCalls === 1 ? "" : "s"}
        {plan.judgeCalls > 0 ? ` and up to ${plan.judgeCalls} judge calls` : ""}
        {plan.gradedAnswers > 0
          ? ` · ${plan.gradedAnswers} answer${plan.gradedAnswers === 1 ? "" : "s"} graded by AI`
          : ""}
        {plan.minutes !== null ? ` · about ${plan.minutes} min` : ""}
      </p>

      <div id="eval-trial-panel" hidden={!trialOpen}>
        {trialOpen ? (
          <TrialForm
            routes={routes}
            routesError={routesError}
            liveRetrieval={liveRetrieval}
            blocked={blocked}
            starting={starting}
            onTrial={async (trial) => {
              if (await onTrial(trial)) setTrialOpen(false);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

function TrialForm({
  routes,
  routesError,
  liveRetrieval,
  blocked,
  starting,
  onTrial
}: {
  routes: ModelRoutingOption[] | null;
  routesError: string | null;
  liveRetrieval: { threshold: number; topK: number } | null;
  blocked: boolean;
  starting: boolean;
  onTrial: (trial: EvalTrialSettings) => Promise<void>;
}): JSX.Element {
  const ids = useId();
  const [routeId, setRouteId] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort | "">("");
  const [threshold, setThreshold] = useState("");
  const [topK, setTopK] = useState("");
  const [error, setError] = useState<{ field: "threshold" | "topK"; message: string } | null>(null);
  const route = routes?.find((candidate) => candidate.id === routeId) ?? null;

  useEffect(() => {
    const first = routes?.[0];
    if (first && !routeId) {
      setRouteId(first.id);
      setEffort(initialEffort(first));
    }
  }, [routes, routeId]);

  function chooseRoute(nextId: string): void {
    setRouteId(nextId);
    const next = routes?.find((candidate) => candidate.id === nextId);
    setEffort(next ? initialEffort(next) : "");
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!route) return;
    const trial: EvalTrialSettings = { routeId: route.id };
    if (effort) trial.reasoningEffort = effort;
    if (threshold.trim()) {
      const value = Number(threshold);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        setError({ field: "threshold", message: "Threshold must be between 0 and 1." });
        document.getElementById(`${ids}-threshold`)?.focus();
        return;
      }
      trial.threshold = value;
    }
    if (topK.trim()) {
      const value = Number(topK);
      if (!Number.isInteger(value) || value < 1 || value > 20) {
        setError({ field: "topK", message: "Top K must be a whole number from 1 to 20." });
        document.getElementById(`${ids}-topk`)?.focus();
        return;
      }
      trial.topK = value;
    }
    setError(null);
    await onTrial(trial);
  }

  const toggle = route?.reasoningControl === "toggle";
  const effortOptions: Array<{ value: ReasoningEffort; label: string }> = route
    ? toggle
      ? [
          ...(route.supportedEfforts.includes("medium") ? [{ value: "medium" as const, label: "On" }] : []),
          ...(route.supportedEfforts.includes("none") ? [{ value: "none" as const, label: "Off" }] : [])
        ]
      : route.supportedEfforts.map((value) => ({ value, label: EFFORT_LABELS[value] }))
    : [];

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="mt-4 flex flex-col gap-4 border-t border-border pt-4"
      noValidate
    >
      <p className="text-sm text-muted-foreground">
        Tests this setup on the question set without changing what CSRs use.
      </p>
      {routesError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {routesError}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <label className="flex flex-col gap-1 text-sm" htmlFor={`${ids}-model`}>
          <span className="font-medium">Model</span>
          {routes === null && !routesError ? (
            <span role="status" className="skeleton block h-10 w-full">
              <span className="sr-only">Loading approved models…</span>
            </span>
          ) : (
            <select
              id={`${ids}-model`}
              value={routeId}
              onChange={(event) => chooseRoute(event.target.value)}
              disabled={!routes || routes.length === 0 || starting}
              className={cn("select-quiet", INPUT_CLASS)}
            >
              {(routes ?? []).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label} · {candidate.providerLabel}
                </option>
              ))}
            </select>
          )}
        </label>
        {effortOptions.length > 0 ? (
          <label className="flex flex-col gap-1 text-sm" htmlFor={`${ids}-effort`}>
            <span className="font-medium">{toggle ? "Reasoning" : "Effort"}</span>
            <select
              id={`${ids}-effort`}
              value={effort}
              onChange={(event) => setEffort(event.target.value as ReasoningEffort)}
              disabled={starting}
              className={cn("select-quiet", INPUT_CLASS)}
            >
              {effortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-sm" htmlFor={`${ids}-threshold`}>
          <span className="font-medium">
            Threshold <span className="font-normal text-muted-foreground">(0 to 1)</span>
          </span>
          <input
            id={`${ids}-threshold`}
            name="threshold"
            type="number"
            inputMode="decimal"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            placeholder={liveRetrieval ? `Live: ${liveRetrieval.threshold}` : "Live value"}
            disabled={starting}
            aria-invalid={error?.field === "threshold" || undefined}
            aria-describedby={error?.field === "threshold" ? `${ids}-error` : undefined}
            className={INPUT_CLASS}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor={`${ids}-topk`}>
          <span className="font-medium">
            Top K <span className="font-normal text-muted-foreground">(1 to 20)</span>
          </span>
          <input
            id={`${ids}-topk`}
            name="topK"
            type="number"
            inputMode="numeric"
            min={1}
            max={20}
            step={1}
            value={topK}
            onChange={(event) => setTopK(event.target.value)}
            placeholder={liveRetrieval ? `Live: ${liveRetrieval.topK}` : "Live value"}
            disabled={starting}
            aria-invalid={error?.field === "topK" || undefined}
            aria-describedby={error?.field === "topK" ? `${ids}-error` : undefined}
            className={INPUT_CLASS}
          />
        </label>
      </div>
      {error ? (
        <p
          id={`${ids}-error`}
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error.message}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="btn-whisper gap-2 px-4 py-2"
          disabled={blocked || !route}
        >
          <FlaskConical className="h-4 w-4" aria-hidden />
          {starting ? "Queueing…" : "Start trial"}
        </button>
        <span className="text-xs text-muted-foreground">
          Empty fields use the live value. Judge faithfulness above applies here too.
        </span>
      </div>
    </form>
  );
}
