import { useId, useState, type FormEvent } from "react";
import { createEvalQuestion, updateEvalQuestion } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  DocumentListItem,
  EvalQuestionItem,
  EvalQuestionKind,
  SaveEvalQuestionRequest
} from "@/types/api";

export const FIELD_CLASS =
  "rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** Starting values for a new question (from a suggestion or a draft). */
export interface QuestionFormInitial {
  kind?: EvalQuestionKind;
  question?: string;
  expectedDocId?: string | null;
  expectedAnswer?: string | null;
}

export function QuestionForm({
  item,
  initial,
  title,
  documents,
  expectedAnswerReady,
  scopeGeneration,
  nested = false,
  onCancel,
  onSaved
}: {
  /** The question being edited; null creates a new one. */
  item: EvalQuestionItem | null;
  initial?: QuestionFormInitial;
  title: string;
  documents: DocumentListItem[];
  /** False until the database can store expected answers. */
  expectedAnswerReady: boolean;
  scopeGeneration: number;
  /** Inside another panel: hairline only, no second card lift. */
  nested?: boolean;
  onCancel: () => void;
  onSaved: (item: EvalQuestionItem, scopeGeneration: number) => void;
}): JSX.Element {
  const ids = useId();
  const [kind, setKind] = useState<EvalQuestionKind>(item?.kind ?? initial?.kind ?? "in-kb");
  const [question, setQuestion] = useState(item?.question ?? initial?.question ?? "");
  const [expectedDocId, setExpectedDocId] = useState(
    item?.expectedDocId ?? initial?.expectedDocId ?? ""
  );
  const [phrases, setPhrases] = useState(item?.expectedAnswerContains.join("\n") ?? "");
  const [expectedAnswer, setExpectedAnswer] = useState(
    item?.expectedAnswer ?? initial?.expectedAnswer ?? ""
  );
  const [heldOut, setHeldOut] = useState(item?.isProtected ?? false);
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; expectations: boolean } | null>(null);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const seen = new Set<string>();
    const expectedAnswerContains = phrases
      .split("\n")
      .map((value) => value.trim())
      .filter((value) => {
        const key = value.toLowerCase();
        if (!value || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const answer = expectedAnswerReady ? expectedAnswer.trim() || null : null;
    if (kind === "in-kb" && !expectedDocId && expectedAnswerContains.length === 0 && !answer) {
      setError({
        message: "Add an expected answer, an expected source, or at least one expected phrase.",
        expectations: true
      });
      document
        .getElementById(expectedAnswerReady ? `${ids}-answer` : `${ids}-source`)
        ?.focus();
      return;
    }
    const payload: SaveEvalQuestionRequest = {
      kind,
      question: question.trim(),
      expectedDocId: kind === "in-kb" ? expectedDocId || null : null,
      expectedAnswerContains: kind === "in-kb" ? expectedAnswerContains : [],
      expectedAnswer: kind === "in-kb" ? answer : null,
      isProtected: heldOut,
      notes: notes.trim() || null
    };
    setSaving(true);
    setError(null);
    try {
      const saved = item
        ? await updateEvalQuestion(item.id, payload)
        : await createEvalQuestion(payload);
      onSaved(saved, scopeGeneration);
    } catch (reason) {
      setError({
        message: reason instanceof Error ? reason.message : "Question could not be saved",
        expectations: false
      });
    } finally {
      setSaving(false);
    }
  }

  const expectationsInvalid = error?.expectations === true;

  return (
    <form
      onSubmit={(event) => void save(event)}
      aria-labelledby={`${ids}-title`}
      noValidate
      className={cn(
        "rounded-lg border border-border",
        nested ? "p-4" : "bg-card p-5 shadow-card"
      )}
    >
      <h3 id={`${ids}-title`} className="text-base font-semibold">
        {title}
      </h3>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <fieldset className="flex flex-wrap gap-2 lg:col-span-2">
          <legend className="mb-1 block w-full text-sm font-medium">Expected behavior</legend>
          {(["in-kb", "out-of-kb"] as const).map((value) => (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm",
                kind === value ? "border-primary/50 bg-primary/5" : "border-input"
              )}
            >
              <input
                type="radio"
                name={`${ids}-kind`}
                value={value}
                checked={kind === value}
                onChange={() => setKind(value)}
                disabled={saving}
                className="accent-primary"
              />
              {value === "in-kb" ? "Answer from KB" : "Refuse safely"}
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-1 text-sm lg:col-span-2">
          <label htmlFor={`${ids}-question`} className="font-medium">
            Question
          </label>
          <textarea
            id={`${ids}-question`}
            name="question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            required
            maxLength={2000}
            rows={3}
            disabled={saving}
            autoFocus
            className={cn(FIELD_CLASS, "resize-y")}
            placeholder="What should the assistant answer or refuse?"
          />
        </div>

        {kind === "in-kb" ? (
          <>
            <div className="flex flex-col gap-1 text-sm lg:col-span-2">
              <label htmlFor={`${ids}-answer`} className="font-medium">
                Expected answer <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <textarea
                id={`${ids}-answer`}
                name="expectedAnswer"
                value={expectedAnswerReady ? expectedAnswer : ""}
                onChange={(event) => setExpectedAnswer(event.target.value)}
                maxLength={2000}
                rows={3}
                disabled={saving || !expectedAnswerReady}
                aria-invalid={expectationsInvalid || undefined}
                aria-describedby={`${ids}-answer-help`}
                className={cn(FIELD_CLASS, "resize-y")}
              />
              <span id={`${ids}-answer-help`} className="text-xs text-muted-foreground">
                {expectedAnswerReady
                  ? "What a correct answer must say. An AI grader checks the assistant's answer against it, so wording can differ."
                  : "Needs a database update before expected answers can be saved."}
              </span>
            </div>
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor={`${ids}-source`} className="font-medium">
                Expected source <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <select
                id={`${ids}-source`}
                name="expectedDocId"
                value={expectedDocId}
                onChange={(event) => setExpectedDocId(event.target.value)}
                disabled={saving}
                aria-invalid={expectationsInvalid || undefined}
                className={cn("select-quiet", FIELD_CLASS, "pr-8")}
              >
                <option value="">Any source</option>
                {documents.map((document) => (
                  <option key={document.documentId} value={document.documentId}>
                    {document.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor={`${ids}-phrases`} className="font-medium">
                Expected phrases
              </label>
              <textarea
                id={`${ids}-phrases`}
                name="expectedAnswerContains"
                value={phrases}
                onChange={(event) => setPhrases(event.target.value)}
                rows={3}
                disabled={saving}
                aria-invalid={expectationsInvalid || undefined}
                aria-describedby={`${ids}-phrases-help`}
                className={cn(FIELD_CLASS, "resize-y")}
                placeholder={"$25 fee\nwithin 30 days"}
              />
              <span id={`${ids}-phrases-help`} className="text-xs text-muted-foreground">
                Exact text the answer must contain, one per line. Optional.
              </span>
            </div>
          </>
        ) : (
          <p className="rounded-md bg-muted/45 px-3 py-2 text-sm text-muted-foreground lg:col-span-2">
            A passing result must refuse without citing a source.
          </p>
        )}

        <div className="flex flex-col gap-1 text-sm lg:col-span-2">
          <label className="inline-flex w-fit cursor-pointer items-center gap-2 font-medium">
            <input
              type="checkbox"
              name="isProtected"
              checked={heldOut}
              onChange={(event) => setHeldOut(event.target.checked)}
              disabled={saving}
              aria-describedby={`${ids}-heldout-help`}
              className="h-4 w-4 rounded border-input accent-primary"
            />
            Held-out question
          </label>
          <span id={`${ids}-heldout-help`} className="pl-6 text-xs text-muted-foreground">
            Kept out of tuning. If held-out questions score much lower than the rest, the setup
            was tuned to the test.
          </span>
        </div>

        <div className="flex flex-col gap-1 text-sm lg:col-span-2">
          <label htmlFor={`${ids}-notes`} className="font-medium">
            Notes <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            id={`${ids}-notes`}
            name="notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={2000}
            disabled={saving}
            className={FIELD_CLASS}
            placeholder="Why this question matters or how to review it"
          />
        </div>
      </div>
      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error.message}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="btn-whisper px-4 py-2 text-sm"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn-primary px-5 py-2 text-sm"
          disabled={saving || question.trim().length === 0}
        >
          {saving ? "Saving…" : item ? "Save question" : "Add question"}
        </button>
      </div>
    </form>
  );
}
