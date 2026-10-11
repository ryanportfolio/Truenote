import { useEffect, useState } from "react";
import { MessageSquareWarning, Plus } from "lucide-react";
import { listEvalQuestionSuggestions } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import type {
  DocumentListItem,
  EvalQuestionItem,
  EvalQuestionSuggestion
} from "@/types/api";
import { QuestionForm } from "./QuestionForm";

const WINDOW_OPTIONS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOW_OPTIONS)[number];

export function QuestionSuggestions({
  documents,
  expectedAnswerReady,
  scopeGeneration,
  onSaved
}: {
  documents: DocumentListItem[];
  expectedAnswerReady: boolean;
  scopeGeneration: number;
  onSaved: (item: EvalQuestionItem, scopeGeneration: number) => void;
}): JSX.Element {
  const [days, setDays] = useState<WindowDays>(30);
  const [items, setItems] = useState<EvalQuestionSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [adding, setAdding] = useState<EvalQuestionSuggestion | null>(null);
  // Questions added from this panel, so their rows read "In set" at once.
  const [added, setAdded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    listEvalQuestionSuggestions(days)
      .then((response) => {
        if (!cancelled) setItems(response.items);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Suggestions could not load");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [days, reloadNonce]);

  const key = (question: string): string => question.trim().toLowerCase();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Real questions CSRs asked that were refused or flagged. Add the ones the knowledge base
          should answer, with the expected answer, or the ones it should keep refusing.
        </p>
        <div
          role="group"
          aria-label="Time window"
          className="flex shrink-0 overflow-hidden rounded-lg border border-border"
        >
          {WINDOW_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={days === option}
              aria-label={`Last ${option} days`}
              onClick={() => setDays(option)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                days === option
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {option}d
            </button>
          ))}
        </div>
      </div>

      {adding ? (
        <QuestionForm
          key={adding.question}
          item={null}
          initial={{
            question: adding.question,
            kind: adding.outcome === "refused" ? "out-of-kb" : "in-kb"
          }}
          title="Add a real question"
          documents={documents}
          expectedAnswerReady={expectedAnswerReady}
          scopeGeneration={scopeGeneration}
          nested
          onCancel={() => setAdding(null)}
          onSaved={(item, generation) => {
            setAdded((current) => new Set(current).add(key(adding.question)));
            setAdding(null);
            onSaved(item, generation);
          }}
        />
      ) : null}

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>{error}</span>
          <button
            type="button"
            className="btn-whisper px-3 py-1 text-xs"
            onClick={() => setReloadNonce((current) => current + 1)}
          >
            Try again
          </button>
        </div>
      ) : items === null ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">Loading suggestions…</span>
          {[0, 1, 2].map((row) => (
            <div key={row} className="skeleton h-10 w-full" aria-hidden />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={MessageSquareWarning}
          title={`No refused or flagged questions in the last ${days} days.`}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Question</th>
                <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Asked</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">Last asked</th>
                <th className="px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((suggestion) => {
                const inSet = suggestion.alreadyInSet || added.has(key(suggestion.question));
                return (
                  <tr
                    key={suggestion.question}
                    className="border-t border-border align-top hover:bg-muted/40"
                  >
                    <td className="px-3 py-2">
                      <span className="font-medium">{suggestion.question}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <OutcomeTag outcome={suggestion.outcome} />
                        <span className="tabular-nums sm:hidden">
                          {suggestion.askCount} {suggestion.askCount === 1 ? "time" : "times"}
                        </span>
                        <span className="md:hidden">
                          last <RelativeTime iso={suggestion.lastAskedAt} />
                        </span>
                      </span>
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 text-right tabular-nums sm:table-cell">
                      {suggestion.askCount}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 text-muted-foreground md:table-cell">
                      <RelativeTime iso={suggestion.lastAskedAt} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {inSet ? (
                        <button
                          type="button"
                          className="btn-whisper px-3 py-1 text-xs"
                          disabled
                          aria-label={`In set: ${suggestion.question}`}
                        >
                          In set
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-whisper gap-1 px-3 py-1 text-xs"
                          aria-label={`Add: ${suggestion.question}`}
                          onClick={() => setAdding(suggestion)}
                        >
                          <Plus className="h-3.5 w-3.5" aria-hidden />
                          Add
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OutcomeTag({ outcome }: { outcome: EvalQuestionSuggestion["outcome"] }): JSX.Element {
  return outcome === "refused" ? (
    <span className="rounded-full bg-warning/20 px-2 py-0.5 font-medium text-warning-foreground">
      Refused
    </span>
  ) : (
    <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
      Flagged by CSR
    </span>
  );
}
