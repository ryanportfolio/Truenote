import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from "react";
import { MessageSquare } from "lucide-react";
import { askQuestionStream } from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import {
  hasAtLeastRole,
  type AskResponse,
  type AskStage,
  type CurrentUser
} from "@/types/api";
import { AnswerView } from "@/components/chat/AnswerView";
import {
  getSelectedProgramId,
  SELECTED_PROGRAM_CHANGED_EVENT
} from "@/lib/selectedProgram";

interface ChatPageProps {
  user: CurrentUser;
}

interface Exchange {
  id: number;
  question: string;
  result: AskResponse | null;
  error: string | null;
}

const STAGE_LABEL: Record<AskStage, string> = {
  searching: "Searching the knowledge base…",
  reranking: "Ranking sources…",
  generating: "Writing the answer…"
};

// First-run teaching examples. Clicking prefills the textarea (never
// auto-submits) so the CSR sees the register questions are asked in.
const EXAMPLE_QUESTIONS = [
  "What's the cancellation fee on the Basic plan?",
  "How do I process a refund for a returned device?",
  "What ID does a caller need to verify their account?"
] as const;

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

  // Pipeline telemetry (scores, latency, chunk ids) is operator data —
  // manager and above. CSRs see citations, not rerank scores.
  const showDebug = hasAtLeastRole(user, "manager");

  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<AskStage | null>(null);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const nextId = useRef(1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Keep the newest exchange in view as the transcript grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [exchanges, stage]);

  // Abort any in-flight request when the page unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // "/" focuses the ask box from anywhere on the page (unless the user is
  // already typing somewhere). CSRs are mid-call — reaching the composer
  // must never require the mouse.
  useEffect(() => {
    function onSlash(event: globalThis.KeyboardEvent): void {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      textareaRef.current?.focus();
    }
    window.addEventListener("keydown", onSlash);
    return () => window.removeEventListener("keydown", onSlash);
  }, []);

  async function ask(trimmed: string): Promise<void> {
    const id = nextId.current;
    nextId.current += 1;
    setBusy(true);
    setStage(null);
    setExchanges((prev) => [...prev, { id, question: trimmed, result: null, error: null }]);

    const controller = new AbortController();
    abortRef.current = controller;

    const patch = (fields: Partial<Exchange>): void =>
      setExchanges((prev) => prev.map((e) => (e.id === id ? { ...e, ...fields } : e)));

    try {
      const result = await askQuestionStream(trimmed, setStage, controller.signal);
      patch({ result });
    } catch (err) {
      if (controller.signal.aborted) {
        patch({ error: "Cancelled." });
      } else {
        patch({ error: err instanceof Error ? err.message : "Failed to fetch answer" });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
      setStage(null);
      textareaRef.current?.focus();
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length === 0 || busy || !hasProgram) return;
    setQuestion("");
    void ask(trimmed);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter asks, Shift+Enter makes a newline — CSRs are mid-call; the
    // keyboard path must never require the mouse.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    // CSR surface: tight density by design (DESIGN.md §Density) — narrower
    // column (~Cohere's 640px measure), smaller gaps than admin pages.
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Chat</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask the knowledge base a question. Every answer ships with at least one citation, or the
          system will explicitly say it could not find the answer.
        </p>
      </header>
      <div className="flex flex-col gap-4">
        {!hasProgram ? (
          <div
            role="status"
            className="rounded-lg border border-dashed border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
          >
            Select a program from the picker in the header to start asking
            questions. The knowledge base is program-scoped, so every answer
            comes from one program's documents at a time.
          </div>
        ) : null}

        {exchanges.length === 0 && hasProgram ? (
          <EmptyState
            icon={MessageSquare}
            title="Ask your first question"
            hint="Answers come from your program's documents and always cite their source."
          >
            {EXAMPLE_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => {
                  setQuestion(q);
                  textareaRef.current?.focus();
                }}
                className="btn-whisper px-3 py-1 text-xs"
              >
                {q}
              </button>
            ))}
          </EmptyState>
        ) : null}

        {exchanges.length > 0 ? (
          <ol className="flex flex-col gap-4" aria-label="Questions and answers">
            {exchanges.map((exchange) => (
              <li key={exchange.id} className="flex flex-col gap-1.5">
                <p className="text-sm font-medium text-muted-foreground">{exchange.question}</p>
                {exchange.result ? (
                  <AnswerView result={exchange.result} showDebug={showDebug} />
                ) : exchange.error ? (
                  <div className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    <span>{exchange.error}</span>
                    <button
                      type="button"
                      disabled={busy || !hasProgram}
                      onClick={() => void ask(exchange.question)}
                      className="rounded-full border border-destructive/40 px-2.5 py-0.5 text-xs font-medium hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <p
                      className="text-sm text-muted-foreground motion-safe:animate-pulse"
                      role="status"
                      aria-live="polite"
                    >
                      {stage ? STAGE_LABEL[stage] : "Sending…"}
                    </p>
                    {/* Answer-card silhouette: shows the CSR where the answer
                      * will land. Decorative — the stage line above carries
                      * the status for screen readers. */}
                    <div
                      aria-hidden
                      className="rounded-lg border border-border bg-card p-4 shadow-card"
                    >
                      <div className="skeleton h-3.5 w-11/12" />
                      <div className="skeleton mt-2 h-3.5 w-full" />
                      <div className="skeleton mt-2 h-3.5 w-3/5" />
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ol>
        ) : null}
        <div ref={bottomRef} />

        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <textarea
            ref={textareaRef}
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask the knowledge base… e.g. 'What's the cancellation fee on the Basic plan?'"
            rows={3}
            disabled={!hasProgram}
            className="rounded-md border border-input bg-card px-3 py-2 text-base shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              <kbd className="kbd">Enter</kbd> asks · <kbd className="kbd">Shift</kbd>+
              <kbd className="kbd">Enter</kbd> new line · <kbd className="kbd">/</kbd> focuses.
              Answers cite source chunks.
            </span>
            <div className="flex items-center gap-2">
              {busy ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="btn-whisper px-4 py-2"
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="submit"
                disabled={busy || !hasProgram || question.trim().length === 0}
                className="btn-csr-ask px-5 py-2 text-base"
              >
                {busy ? "Asking…" : "Ask"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
