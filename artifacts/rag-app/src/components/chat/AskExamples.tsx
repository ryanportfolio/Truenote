import { useEffect, useRef, useState } from "react";
import { Check, Pencil, Plus, RotateCcw, X } from "lucide-react";
import { fetchAskExamples, saveAskExamples, type AskExamples as Examples } from "@/lib/api";
import { getSelectedProgramIdRaw, SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";

const MAX_EXAMPLES = 6;
const MAX_LENGTH = 200;

interface AskExamplesProps {
  /** Manager and above edit the list for their program. */
  canEdit: boolean;
  /** Fill the question box; never submits. */
  onPick: (question: string) => void;
}

/**
 * Example questions on the empty Ask page. The list belongs to the program;
 * managers replace it in place. Nothing renders until the list loads, so a
 * team's own questions never flash in after the defaults.
 */
export function AskExamples({ canEdit, onPick }: AskExamplesProps): JSX.Element | null {
  const [examples, setExamples] = useState<Examples | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each program change starts a new generation: the old list and draft are
  // dropped at once, and answers from an older generation are ignored, so
  // one program's examples never show, or save, under another.
  const generation = useRef(0);
  // The program whose list is loaded; saves go to it explicitly.
  const programId = useRef<string | null>(null);

  useEffect(() => {
    function load(): void {
      const gen = ++generation.current;
      programId.current = getSelectedProgramIdRaw();
      setExamples(null);
      setDraft(null);
      setError(null);
      setSaving(false);
      fetchAskExamples()
        .then((next) => {
          if (gen === generation.current) setExamples(next);
        })
        .catch(() => {
          // No examples is fine: the question box still works.
        });
    }
    function onStorage(): void {
      if (getSelectedProgramIdRaw() !== programId.current) load();
    }
    load();
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, load);
    window.addEventListener("storage", onStorage);
    return () => {
      generation.current++;
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, load);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  async function save(questions: string[]): Promise<void> {
    const gen = generation.current;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveAskExamples(questions, programId.current);
      if (gen !== generation.current) return;
      setExamples(saved);
      setDraft(null);
    } catch (err) {
      if (gen !== generation.current) return;
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      if (gen === generation.current) setSaving(false);
    }
  }

  if (draft !== null) {
    const cleaned = draft.map((q) => q.trim()).filter(Boolean);
    return (
      <form
        data-ask-examples-editor
        className="flex w-full max-w-lg flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save(cleaned);
        }}
      >
        {draft.map((q, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              value={q}
              maxLength={MAX_LENGTH}
              autoFocus={index === draft.length - 1 && q === ""}
              aria-label={`Example question ${index + 1}`}
              onChange={(event) =>
                setDraft(draft.map((d, i) => (i === index ? event.target.value : d)))
              }
              className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="button"
              aria-label={`Remove example question ${index + 1}`}
              title="Remove"
              onClick={() => setDraft(draft.filter((_, i) => i !== index))}
              className="btn-whisper h-8 w-8 shrink-0"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <button
            type="button"
            disabled={draft.length >= MAX_EXAMPLES}
            title={`Up to ${MAX_EXAMPLES} questions`}
            onClick={() => setDraft([...draft, ""])}
            className="btn-whisper gap-1.5 px-3 py-1.5 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add
          </button>
          {examples?.custom ? (
            <button
              type="button"
              disabled={saving}
              title="Go back to the built-in examples"
              onClick={() => void save([])}
              className="btn-whisper gap-1.5 px-3 py-1.5 disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              Reset
            </button>
          ) : null}
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
            className="btn-whisper px-3 py-1.5 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || cleaned.length === 0}
            className="btn-whisper gap-1.5 px-3 py-1.5 disabled:opacity-50"
          >
            <Check className="h-4 w-4" aria-hidden />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    );
  }

  if (!examples) return null;
  return (
    <>
      {examples.questions.map((q) => (
        <button key={q} type="button" onClick={() => onPick(q)} className="example-question">
          {q}
        </button>
      ))}
      {canEdit ? (
        <button
          type="button"
          data-ask-examples-edit
          aria-label="Edit example questions"
          title="Edit example questions for your team"
          onClick={() => {
            setError(null);
            setDraft([...examples.questions]);
          }}
          className="btn-whisper h-8 w-8"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </>
  );
}
