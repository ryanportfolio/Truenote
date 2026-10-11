import { useState, type ReactNode } from "react";
import {
  FileUp,
  FlaskConical,
  MessageSquareWarning,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import { deleteEvalQuestion } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";
import { useConfirm } from "@/components/ConfirmDialog";
import type { DocumentListItem, EvalQuestionItem } from "@/types/api";
import { CsvImport } from "./CsvImport";
import { QuestionDrafts } from "./QuestionDrafts";
import { QuestionForm } from "./QuestionForm";
import { QuestionSuggestions } from "./QuestionSuggestions";

type OpenPanel =
  | { kind: "form"; editing: EvalQuestionItem | null }
  | { kind: "suggestions" }
  | { kind: "drafts" }
  | { kind: "csv" }
  | null;

const ENTRY_POINTS = [
  { kind: "suggestions", label: "From real questions", Icon: MessageSquareWarning },
  { kind: "drafts", label: "Draft from a source", Icon: Sparkles },
  { kind: "csv", label: "Import CSV", Icon: FileUp }
] as const;

const PANEL_TITLES = {
  suggestions: "From real questions",
  drafts: "Draft from a source",
  csv: "Import CSV"
} as const;

/** What a run checks for this question, in words. */
export function expectationSummary(item: EvalQuestionItem): string {
  if (item.kind === "out-of-kb") return "Refuses without citing a source";
  const phrases = item.expectedAnswerContains.length;
  const parts = [
    item.expectedDocTitle ? `Cites ${item.expectedDocTitle}` : null,
    phrases > 0 ? `${phrases} exact phrase${phrases === 1 ? "" : "s"}` : null,
    item.expectedAnswer ? "Expected answer" : null
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "Any cited answer";
}

export function QuestionsPanel({
  items,
  documents,
  loading,
  expectedAnswerReady,
  scopeGeneration,
  runDisabled,
  onSaved,
  onCreatedMany,
  onDeleted,
  onRun,
  onError
}: {
  items: EvalQuestionItem[];
  documents: DocumentListItem[];
  loading: boolean;
  expectedAnswerReady: boolean;
  scopeGeneration: number;
  runDisabled: boolean;
  onSaved: (item: EvalQuestionItem, scopeGeneration: number) => void;
  onCreatedMany: (items: EvalQuestionItem[], scopeGeneration: number) => void;
  onDeleted: (id: string, scopeGeneration: number) => void;
  onRun: (id: string) => void;
  onError: (message: string | null, scopeGeneration: number) => void;
}): JSX.Element {
  const confirm = useConfirm();
  const [open, setOpen] = useState<OpenPanel>(null);

  async function remove(item: EvalQuestionItem): Promise<void> {
    const confirmed = await confirm({
      title: "Delete evaluation question?",
      message: item.question,
      confirmLabel: "Delete question",
      tone: "danger"
    });
    if (!confirmed) return;
    onError(null, scopeGeneration);
    try {
      await deleteEvalQuestion(item.id);
      onDeleted(item.id, scopeGeneration);
      setOpen((current) =>
        current?.kind === "form" && current.editing?.id === item.id ? null : current
      );
    } catch (reason) {
      onError(
        reason instanceof Error ? reason.message : "Question could not be deleted",
        scopeGeneration
      );
    }
  }

  function toggle(kind: "suggestions" | "drafts" | "csv"): void {
    setOpen((current) => (current?.kind === kind ? null : { kind }));
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="eval-questions-heading">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2
              id="eval-questions-heading"
              className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Question set
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Answer questions check the answer and its source. Refusal questions check that the
              assistant stays inside the documents.
            </p>
          </div>
          <button
            type="button"
            className={cn(
              "btn-whisper gap-1.5 px-3 py-1.5 text-sm",
              open?.kind === "form" && open.editing === null && "bg-muted"
            )}
            aria-expanded={open?.kind === "form" && open.editing === null}
            onClick={() =>
              setOpen((current) =>
                current?.kind === "form" && current.editing === null
                  ? null
                  : { kind: "form", editing: null }
              )
            }
          >
            <Plus className="h-4 w-4" aria-hidden /> Add question
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Other ways to add questions">
          <span className="text-xs text-muted-foreground">Or add from</span>
          {ENTRY_POINTS.map(({ kind, label, Icon }) => (
            <button
              key={kind}
              type="button"
              className={cn("btn-whisper gap-1.5 px-3 py-1 text-xs", open?.kind === kind && "bg-muted")}
              aria-expanded={open?.kind === kind}
              aria-controls={open?.kind === kind ? "eval-question-source-panel" : undefined}
              onClick={() => toggle(kind)}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </div>

      {open?.kind === "form" ? (
        <QuestionForm
          key={open.editing?.id ?? "new"}
          item={open.editing}
          title={open.editing ? "Edit question" : "Add question"}
          documents={documents}
          expectedAnswerReady={expectedAnswerReady}
          scopeGeneration={scopeGeneration}
          onCancel={() => setOpen(null)}
          onSaved={(item, generation) => {
            setOpen(null);
            onSaved(item, generation);
          }}
        />
      ) : open ? (
        <SourcePanel title={PANEL_TITLES[open.kind]} onClose={() => setOpen(null)}>
          {open.kind === "suggestions" ? (
            <QuestionSuggestions
              documents={documents}
              expectedAnswerReady={expectedAnswerReady}
              scopeGeneration={scopeGeneration}
              onSaved={onSaved}
            />
          ) : open.kind === "drafts" ? (
            <QuestionDrafts
              documents={documents}
              expectedAnswerReady={expectedAnswerReady}
              scopeGeneration={scopeGeneration}
              onSaved={onSaved}
            />
          ) : (
            <CsvImport
              documents={documents}
              expectedAnswerReady={expectedAnswerReady}
              scopeGeneration={scopeGeneration}
              onCreated={onCreatedMany}
            />
          )}
        </SourcePanel>
      ) : null}

      {loading ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">Loading evaluation questions…</span>
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="skeleton h-12 w-full" aria-hidden />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="No evaluation questions"
          hint="Add one answerable question and one expected refusal to start a useful suite."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Question</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">Behavior</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">Expected</th>
                <th className="px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-border align-top hover:bg-muted/40">
                  <td className="max-w-lg px-3 py-2">
                    <span className="font-medium">{item.question}</span>
                    {item.notes ? (
                      <span className="mt-1 block line-clamp-1 text-xs text-muted-foreground">
                        {item.notes}
                      </span>
                    ) : null}
                    <QuestionTags item={item} />
                    <span className="mt-1 block text-xs text-muted-foreground md:hidden">
                      {expectationSummary(item)}
                    </span>
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-2 sm:table-cell">
                    <KindTag item={item} />
                  </td>
                  <td className="hidden max-w-xs px-3 py-2 text-muted-foreground md:table-cell">
                    {expectationSummary(item)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        className="btn-icon"
                        aria-label={`Run: ${item.question}`}
                        title="Run this question"
                        disabled={runDisabled}
                        onClick={() => onRun(item.id)}
                      >
                        <Play className="h-4 w-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="btn-icon"
                        aria-label={`Edit: ${item.question}`}
                        title="Edit"
                        onClick={() => setOpen({ kind: "form", editing: item })}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="btn-icon text-destructive"
                        aria-label={`Delete: ${item.question}`}
                        title="Delete"
                        onClick={() => void remove(item)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
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

function KindTag({ item }: { item: EvalQuestionItem }): JSX.Element {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        item.kind === "in-kb" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
      )}
    >
      {item.kind === "in-kb" ? "Answer" : "Refuse"}
    </span>
  );
}

function QuestionTags({ item }: { item: EvalQuestionItem }): JSX.Element | null {
  const aiGraded = Boolean(item.expectedAnswer);
  return (
    <span className="mt-1 flex flex-wrap gap-1 text-xs">
      <span className="sm:hidden">
        <KindTag item={item} />
      </span>
      {item.isProtected ? (
        <span
          className="rounded-full border border-border px-2 py-0.5 font-medium text-muted-foreground"
          title="Kept out of tuning"
        >
          Held-out
        </span>
      ) : null}
      {aiGraded ? (
        <span
          className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground"
          title="An AI grader checks the answer against the expected answer"
        >
          AI-graded
        </span>
      ) : null}
    </span>
  );
}

function SourcePanel({
  title,
  onClose,
  children
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <section
      id="eval-question-source-panel"
      aria-labelledby="eval-question-source-title"
      className="rounded-lg border border-border bg-card p-5 shadow-card"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <h3 id="eval-question-source-title" className="text-base font-semibold">
          {title}
        </h3>
        <button type="button" className="btn-icon" aria-label={`Close ${title}`} onClick={onClose}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {children}
    </section>
  );
}
