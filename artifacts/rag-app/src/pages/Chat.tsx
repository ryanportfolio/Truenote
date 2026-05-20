import { useEffect, useState, type FormEvent } from "react";
import { askQuestion } from "@/lib/api";
import type { AskResponse, CurrentUser } from "@/types/api";
import { AnswerView } from "@/components/chat/AnswerView";
import {
  getSelectedProgramId,
  SELECTED_PROGRAM_CHANGED_EVENT
} from "@/lib/selectedProgram";

interface ChatPageProps {
  user: CurrentUser;
}

export function ChatPage({ user }: ChatPageProps): JSX.Element {
  // Super_users need a program selection to ask anything. Non-super_user
  // roles always have a fixed program_id, so the picker doesn't apply.
  const [hasProgram, setHasProgram] = useState<boolean>(() =>
    user.role !== "super_user" || getSelectedProgramId(user.id) !== null
  );
  useEffect(() => {
    if (user.role !== "super_user") return;
    function refresh(): void {
      setHasProgram(getSelectedProgramId(user.id) !== null);
    }
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [user.id, user.role]);

  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const out = await askQuestion(trimmed);
      setResult(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch answer");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Chat</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask the knowledge base a question. Every answer ships with at least one citation, or the
          system will explicitly say it could not find the answer.
        </p>
      </header>
      <div className="flex flex-col gap-4">
        {!hasProgram ? (
          <div
            role="status"
            className="rounded border border-dashed border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
          >
            Select a program from the picker in the header to start asking
            questions. The knowledge base is program-scoped, so every answer
            comes from one program's documents at a time.
          </div>
        ) : null}
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask the knowledge base… e.g. 'What's the cancellation fee on the Basic plan?'"
            rows={3}
            disabled={!hasProgram}
            className="rounded border border-input bg-background px-3 py-2 text-sm disabled:opacity-60"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Answers cite source chunks. No citation → not in knowledge base.
            </span>
            <button
              type="submit"
              disabled={busy || !hasProgram || question.trim().length === 0}
              className="btn-csr-ask px-4 py-1.5"
            >
              {busy ? "Asking…" : "Ask"}
            </button>
          </div>
        </form>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {result ? (
          <section className="flex flex-col gap-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Answer</p>
            <AnswerView result={result} />
          </section>
        ) : null}
      </div>
    </div>
  );
}
