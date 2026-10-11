import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, Pencil, Sparkles, X } from "lucide-react";
import { createEvalQuestion, draftEvalQuestions } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  DocumentListItem,
  EvalQuestionDraft,
  EvalQuestionItem
} from "@/types/api";
import { FIELD_CLASS, QuestionForm } from "./QuestionForm";

const COUNT_OPTIONS = [3, 5, 10] as const;
type DraftCount = (typeof COUNT_OPTIONS)[number];

interface DraftCard {
  key: number;
  draft: EvalQuestionDraft;
  status: "new" | "saving" | "added";
  error: string | null;
}

export function QuestionDrafts({
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
  const ids = useId();
  const [documentId, setDocumentId] = useState("");
  const [count, setCount] = useState<DraftCount>(5);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<DraftCard[]>([]);
  const [editingKey, setEditingKey] = useState<number | null>(null);
  const requestRef = useRef(0);
  const nextKeyRef = useRef(0);

  // A response that lands after the panel closes is dropped.
  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );

  async function draft(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!documentId) {
      setError("Choose a source to draft from.");
      document.getElementById(`${ids}-source`)?.focus();
      return;
    }
    const request = ++requestRef.current;
    setDrafting(true);
    setError(null);
    try {
      const response = await draftEvalQuestions(documentId, count);
      if (request !== requestRef.current) return;
      setEditingKey(null);
      setCards(
        response.items.map((item) => ({
          key: nextKeyRef.current++,
          draft: item,
          status: "new",
          error: null
        }))
      );
      if (response.items.length === 0) {
        setError("No questions came back for this source. Try again or choose another source.");
      }
    } catch (reason) {
      if (request === requestRef.current) {
        setError(reason instanceof Error ? reason.message : "Drafting failed. Try again.");
      }
    } finally {
      if (request === requestRef.current) setDrafting(false);
    }
  }

  function patch(key: number, next: Partial<DraftCard>): void {
    setCards((current) =>
      current.map((card) => (card.key === key ? { ...card, ...next } : card))
    );
  }

  async function approve(card: DraftCard): Promise<void> {
    patch(card.key, { status: "saving", error: null });
    try {
      const item = await createEvalQuestion({
        kind: "in-kb",
        question: card.draft.question,
        expectedDocId: card.draft.expectedDocId,
        expectedAnswer: card.draft.expectedAnswer,
        expectedAnswerContains: []
      });
      patch(card.key, { status: "added" });
      onSaved(item, scopeGeneration);
    } catch (reason) {
      patch(card.key, {
        status: "new",
        error: reason instanceof Error ? reason.message : "Question could not be saved"
      });
    }
  }

  const pendingCount = cards.filter((card) => card.status !== "added").length;

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        AI reads the source and suggests questions with their answers. Nothing is added until you
        approve it.
      </p>
      <form
        onSubmit={(event) => void draft(event)}
        noValidate
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1 text-sm">
          <label htmlFor={`${ids}-source`} className="font-medium">
            Source
          </label>
          <select
            id={`${ids}-source`}
            value={documentId}
            onChange={(event) => setDocumentId(event.target.value)}
            disabled={drafting}
            className={cn("select-quiet", FIELD_CLASS, "w-full pr-8")}
          >
            <option value="">Choose a source</option>
            {documents.map((document) => (
              <option key={document.documentId} value={document.documentId}>
                {document.title}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <span id={`${ids}-count`} className="font-medium">
            Questions
          </span>
          <div
            role="group"
            aria-labelledby={`${ids}-count`}
            className="flex overflow-hidden rounded-lg border border-border"
          >
            {COUNT_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={count === option}
                onClick={() => setCount(option)}
                disabled={drafting}
                className={cn(
                  "px-3 py-2 text-sm font-medium tabular-nums transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                  count === option
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
        <button type="submit" className="btn-whisper gap-2 px-4 py-2 text-sm" disabled={drafting}>
          <Sparkles className="h-4 w-4" aria-hidden />
          {drafting ? "Drafting…" : "Draft questions"}
        </button>
      </form>

      {!expectedAnswerReady ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
          Needs a database update before expected answers can be saved. Use Edit to keep a
          drafted question with its source only.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {drafting ? (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">Drafting questions…</span>
          {[0, 1, 2].map((row) => (
            <div key={row} className="rounded-lg border border-border p-4" aria-hidden>
              <div className="skeleton h-4 w-3/4" />
              <div className="skeleton mt-3 h-3 w-full" />
              <div className="skeleton mt-2 h-3 w-2/3" />
            </div>
          ))}
        </div>
      ) : cards.length > 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {pendingCount === 0
              ? "All drafted questions handled."
              : `${pendingCount} drafted question${pendingCount === 1 ? "" : "s"} to review.`}
          </p>
          <ul className="flex flex-col gap-3">
            {cards.map((card) =>
              editingKey === card.key ? (
                <li key={card.key}>
                  <QuestionForm
                    item={null}
                    initial={{
                      kind: "in-kb",
                      question: card.draft.question,
                      expectedAnswer: card.draft.expectedAnswer,
                      expectedDocId: card.draft.expectedDocId
                    }}
                    title="Edit drafted question"
                    documents={documents}
                    expectedAnswerReady={expectedAnswerReady}
                    scopeGeneration={scopeGeneration}
                    nested
                    onCancel={() => setEditingKey(null)}
                    onSaved={(item, generation) => {
                      patch(card.key, { status: "added", error: null });
                      setEditingKey(null);
                      onSaved(item, generation);
                    }}
                  />
                </li>
              ) : (
                <DraftCardView
                  key={card.key}
                  card={card}
                  canApprove={expectedAnswerReady}
                  onApprove={() => void approve(card)}
                  onEdit={() => setEditingKey(card.key)}
                  onDiscard={() =>
                    setCards((current) => current.filter((candidate) => candidate.key !== card.key))
                  }
                />
              )
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function DraftCardView({
  card,
  canApprove,
  onApprove,
  onEdit,
  onDiscard
}: {
  card: DraftCard;
  canApprove: boolean;
  onApprove: () => void;
  onEdit: () => void;
  onDiscard: () => void;
}): JSX.Element {
  const { draft, status } = card;
  const saving = status === "saving";
  return (
    <li
      className={cn(
        "rounded-lg border border-border p-4",
        status === "added" && "bg-muted/40"
      )}
    >
      <p className="font-medium">{draft.question}</p>
      <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Expected answer
      </p>
      <p className="mt-1 text-sm leading-relaxed">{draft.expectedAnswer}</p>
      <p className="mt-2 text-xs text-muted-foreground">Source: {draft.expectedDocTitle}</p>
      {card.error ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {card.error}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {status === "added" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
            <Check className="h-3.5 w-3.5" aria-hidden />
            Added
          </span>
        ) : (
          <>
            <button
              type="button"
              className="btn-whisper gap-1.5 px-3 py-1 text-xs"
              onClick={onApprove}
              disabled={saving || !canApprove}
              aria-label={`Approve: ${draft.question}`}
            >
              <Check className="h-3.5 w-3.5" aria-hidden />
              {saving ? "Adding…" : "Approve"}
            </button>
            <button
              type="button"
              className="btn-whisper gap-1.5 px-3 py-1 text-xs"
              onClick={onEdit}
              disabled={saving}
              aria-label={`Edit: ${draft.question}`}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit
            </button>
            <button
              type="button"
              className="btn-whisper gap-1.5 px-3 py-1 text-xs"
              onClick={onDiscard}
              disabled={saving}
              aria-label={`Discard: ${draft.question}`}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Discard
            </button>
          </>
        )}
      </div>
    </li>
  );
}
