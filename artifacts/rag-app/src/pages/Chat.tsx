import { useState, type FormEvent } from "react";
import { askQuestion } from "@/lib/api";
import type { AskResponse } from "@/types/api";
import { AnswerView } from "@/components/chat/AnswerView";

export function ChatPage(): JSX.Element {
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
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask the knowledge base… e.g. 'What's the cancellation fee on the Basic plan?'"
            rows={3}
            className="rounded border border-input bg-background px-3 py-2 text-sm"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Answers cite source chunks. No citation → not in knowledge base.
            </span>
            <button
              type="submit"
              disabled={busy || question.trim().length === 0}
              className="rounded bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
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
