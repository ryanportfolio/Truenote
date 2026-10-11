import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { ResultDiff } from "@/lib/evaluationMetrics";
import type { EvalQuestionResult } from "@/types/api";
import { kindLabel } from "./format";

export function BaselineDiff({
  diff,
  loading,
  error,
  sameSetup,
  sameQuestions,
  onRetry,
  onShow
}: {
  diff: ResultDiff | null;
  loading: boolean;
  error: string | null;
  /** Same routes, retrieval settings and judge as the baseline. */
  sameSetup: boolean;
  /** Same question set and scope as the baseline. */
  sameQuestions: boolean;
  onRetry: () => void;
  onShow: (questionId: string) => void;
}): JSX.Element {
  return (
    <section
      aria-labelledby="eval-baseline-diff-heading"
      className="overflow-hidden rounded-lg border border-border bg-card shadow-card"
    >
      <div className="border-b border-border px-4 py-3">
        <h3 id="eval-baseline-diff-heading" className="text-sm font-medium">
          Changes since the baseline
        </h3>
        {diff ? (
          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
            {diff.newlyFailing.length} newly failing · {diff.newlyPassing.length} newly passing ·{" "}
            {diff.unchanged} unchanged
          </p>
        ) : null}
      </div>

      {!sameSetup ? (
        <p className="border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning-foreground">
          Different setup from the baseline: differences may come from the setup, not a
          regression.
        </p>
      ) : !sameQuestions ? (
        <p className="border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning-foreground">
          The question set or scope differs from the baseline, so the score deltas are
          hidden; only questions in both runs are compared below.
        </p>
      ) : null}

      {loading && !diff ? (
        <div role="status" className="flex flex-col gap-2 px-4 py-3">
          <div className="skeleton h-4 w-2/3" />
          <div className="skeleton h-4 w-1/2" />
          <span className="sr-only">Loading the baseline comparison…</span>
        </div>
      ) : error && !diff ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm text-muted-foreground">
          <span>{error}</span>
          <button type="button" className="btn-whisper px-2.5 py-1 text-xs" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : diff ? (
        <div className="flex flex-col gap-4 px-4 py-3">
          <div className="grid gap-4 lg:grid-cols-2">
            <DiffList
              title="Newly failing"
              tone="worse"
              items={diff.newlyFailing}
              empty="Nothing that passed in the baseline fails now."
              onShow={onShow}
            />
            <DiffList
              title="Newly passing"
              tone="better"
              items={diff.newlyPassing}
              empty="Nothing that failed in the baseline passes now."
              onShow={onShow}
            />
          </div>
          {diff.onlyInCurrent.length > 0 || diff.onlyInBaseline.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-border pt-3 text-xs text-muted-foreground">
              {diff.onlyInCurrent.length > 0 ? (
                <OnlyInOne
                  label={`${diff.onlyInCurrent.length} question${diff.onlyInCurrent.length === 1 ? "" : "s"} only in this run`}
                  items={diff.onlyInCurrent}
                />
              ) : null}
              {diff.onlyInBaseline.length > 0 ? (
                <OnlyInOne
                  label={`${diff.onlyInBaseline.length} question${diff.onlyInBaseline.length === 1 ? "" : "s"} only in the baseline`}
                  items={diff.onlyInBaseline}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function DiffList({
  title,
  tone,
  items,
  empty,
  onShow
}: {
  title: string;
  tone: "better" | "worse";
  items: EvalQuestionResult[];
  empty: string;
  onShow: (questionId: string) => void;
}): JSX.Element {
  const Icon = tone === "worse" ? ArrowDownRight : ArrowUpRight;
  return (
    <div>
      <h4 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon
          className={tone === "worse" ? "h-3.5 w-3.5 text-destructive" : "h-3.5 w-3.5 text-success"}
          aria-hidden
        />
        {title} <span className="tabular-nums">{items.length}</span>
      </h4>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((result) => (
            <li key={result.questionId} className="flex items-start justify-between gap-3">
              <span className="min-w-0 text-sm">
                <span className="block">{result.question}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {kindLabel(result.kind)}
                  {result.failureStage ? ` · lost at ${result.failureStage}` : ""}
                </span>
              </span>
              <button
                type="button"
                className="btn-whisper shrink-0 px-2.5 py-1 text-xs"
                aria-label={`Show result: ${result.question}`}
                onClick={() => onShow(result.questionId)}
              >
                Show result
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OnlyInOne({ label, items }: { label: string; items: EvalQuestionResult[] }): JSX.Element {
  return (
    <details>
      <summary className="w-fit cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {label}
      </summary>
      <ul className="mt-1 list-disc pl-5">
        {items.map((result) => (
          <li key={result.questionId}>{result.question}</li>
        ))}
      </ul>
    </details>
  );
}
