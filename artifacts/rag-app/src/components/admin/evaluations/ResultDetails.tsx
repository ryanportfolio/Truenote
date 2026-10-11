import { useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { EvalCorrectnessVerdict, EvalQuestionResult } from "@/types/api";
import { formatCheck, formatGenerationPath } from "./format";

/** Ask ResultDetails to open and scroll to one question's row. */
export interface ResultFocusRequest {
  questionId: string;
  /** Bumped on every request so asking for the same row twice still works. */
  nonce: number;
}

export function resultRowId(questionId: string): string {
  return `eval-result-${questionId}`;
}

const VERDICT_COPY: Record<EvalCorrectnessVerdict, string> = {
  correct: "correct",
  partial: "partly correct",
  incorrect: "incorrect"
};

// The runner records a grading failure as this error too; the grading line
// already says it, so the duplicate error line is skipped.
const GRADING_FAILED = "Answer grading failed";

export function ResultDetails({
  results,
  focusRequest
}: {
  results: EvalQuestionResult[];
  focusRequest: ResultFocusRequest | null;
}): JSX.Element {
  const ordered = useMemo(
    () =>
      [...results].sort((left, right) => {
        const severity = (result: EvalQuestionResult) =>
          !result.pass ? 0 : result.unsupportedClaims.length > 0 ? 1 : 2;
        return severity(left) - severity(right);
      }),
    [results]
  );

  useEffect(() => {
    if (!focusRequest) return;
    const row = document.getElementById(resultRowId(focusRequest.questionId));
    if (!(row instanceof HTMLDetailsElement)) return;
    row.open = true;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    row.querySelector("summary")?.focus({ preventScroll: true });
  }, [focusRequest]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium">Question results</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Failures and passing answers with unsupported claims appear first. Open a row for
          its evidence checks.
        </p>
      </div>
      <ul className="divide-y divide-border">
        {ordered.map((result) => {
          const showError =
            result.error !== null &&
            !(result.correctnessJudgeFailed === true && result.error === GRADING_FAILED);
          return (
            <li key={result.questionId}>
              <details
                id={resultRowId(result.questionId)}
                className="group scroll-mt-24 px-4 py-3 open:bg-muted/25"
              >
                <summary className="flex cursor-pointer list-none items-start justify-between gap-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{result.question}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {result.kind === "in-kb" ? "In-KB" : "Expected refusal"}
                      {result.failureStage ? ` · lost at ${result.failureStage}` : ""} ·{" "}
                      {result.latencyMs} ms
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                      !result.pass
                        ? "bg-destructive/15 text-destructive"
                        : result.unsupportedClaims.length > 0
                          ? "bg-warning/20 text-warning-foreground"
                          : "bg-success/15 text-success"
                    )}
                  >
                    {!result.pass ? "Fail" : result.unsupportedClaims.length > 0 ? "Review" : "Pass"}
                  </span>
                </summary>
                <div className="mt-3 grid gap-3 border-t border-border pt-3 text-sm lg:grid-cols-2">
                  <div className="flex flex-col gap-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Answer
                      </p>
                      <p className="mt-1 whitespace-pre-wrap leading-relaxed">
                        {result.answer || "No answer returned."}
                      </p>
                    </div>
                    {result.expectedAnswer ? (
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Expected answer
                        </p>
                        <p className="mt-1 whitespace-pre-wrap leading-relaxed text-muted-foreground">
                          {result.expectedAnswer}
                        </p>
                      </div>
                    ) : null}
                    {result.correctnessJudgeFailed ? (
                      <p className="rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
                        Answer grading failed
                      </p>
                    ) : result.correctness ? (
                      <p className="text-xs">
                        <span className="font-medium">
                          Graded: {VERDICT_COPY[result.correctness.verdict]}
                        </span>
                        <span className="text-muted-foreground"> · {result.correctness.reason}</span>
                      </p>
                    ) : null}
                  </div>
                  <div className="space-y-1 text-xs text-muted-foreground">
                    {showError ? <p className="text-destructive">Error: {result.error}</p> : null}
                    <p>Citation: {formatCheck(result.citationCorrect)}</p>
                    <p>Expected phrases: {formatCheck(result.phrasesPresent.length > 0 ? result.phrasesPresent.every((phrase) => phrase.present) : null)}</p>
                    <p>Retrieval hit: {formatCheck(result.retrievalHit)}</p>
                    <p>Rerank hit: {formatCheck(result.rerankHit)}</p>
                    <p>
                      Expected source rank:{" "}
                      {result.expectedDocId
                        ? result.expectedDocRank ?? "not found"
                        : "not applicable"}
                    </p>
                    <p>
                      Top retrieval score:{" "}
                      {result.topScore === null ? "not available" : result.topScore.toFixed(3)}
                    </p>
                    <p>Generation path: {formatGenerationPath(result.generationPath)}</p>
                    {result.faithfulnessJudgeFailed ? (
                      <p className="text-warning-foreground">Faithfulness judge failed for this answer.</p>
                    ) : null}
                    <p>Refused: {result.refused ? "yes" : "no"}</p>
                    {result.unsupportedClaims.map((claim) => (
                      <p key={claim} className="text-destructive">
                        Unsupported: {claim}
                      </p>
                    ))}
                  </div>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
