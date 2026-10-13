import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "wouter";
import { BookOpen, X } from "lucide-react";
import { AnswerMarkdown } from "@/components/chat/AnswerMarkdown";
import { UnauthorizedError, askCompliance, getComplianceSuggestions } from "@/lib/api";
import { complianceCitationHref } from "@/lib/complianceAccess";
import type { ComplianceAskResponse, ComplianceSource, Source } from "@/types/api";
import { useTypewriter } from "./useTypewriter";

const FALLBACK_PLACEHOLDER = "Ask about the compliance documents";
const SUGGESTION_POLL_MS = 15_000;
const SUGGESTION_POLLS = 8;

/** Shuffled once per visit so the box does not open on the same question. */
function shuffled(lines: readonly string[]): string[] {
  const out = [...lines];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Example questions written from the current documents. The server answers
 * "pending" while it writes them, so this asks again a few times.
 */
function useComplianceSuggestions(): string[] {
  const [questions, setQuestions] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let polls = 0;
    const load = (): void => {
      getComplianceSuggestions()
        .then((result) => {
          if (cancelled) return;
          if (result.questions.length > 0) setQuestions(shuffled(result.questions));
          else if (result.status === "pending" && polls++ < SUGGESTION_POLLS) {
            timer = window.setTimeout(load, SUGGESTION_POLL_MS);
          }
        })
        .catch(() => {
          // The fixed placeholder stays; the box works without examples.
        });
    };
    load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);
  return questions;
}

/**
 * Questions about the compliance documents. Answers come from the server
 * cited to document sections, or as the refusal; nothing is kept between
 * visits. The server records each question (a hash, never the text).
 */

/** The one open citation, and the chip that opened it (focus returns there). */
interface OpenCitation {
  source: ComplianceSource;
  opener: HTMLElement | null;
}

interface Exchange {
  id: number;
  question: string;
  result: ComplianceAskResponse | null;
  error: string | null;
}

function sourceLabel(source: ComplianceSource): string {
  return source.section ? `${source.title} · ${source.section}` : source.title;
}

/** AnswerMarkdown renders chips from the CSR Source shape. */
function asChipSources(sources: ComplianceSource[]): Source[] {
  return sources.map((source, index) => ({
    chunk_id: source.chunk_id,
    doc_title: sourceLabel(source),
    excerpt: source.excerpt,
    doc_id: null,
    document_version_id: null,
    version_number: null,
    citation_index: index,
    source_start: source.source_start,
    source_end: source.source_end
  }));
}

export function ComplianceAsk(): JSX.Element {
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const suggestions = useComplianceSuggestions();
  // Types example questions into the empty box; stops while it has focus.
  const example = useTypewriter(suggestions, focused || question.length > 0);
  const nextId = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  // One citation panel for the whole section, whichever answer it came from.
  const [openCitation, setOpenCitation] = useState<OpenCitation | null>(null);
  const openSource = useCallback((source: ComplianceSource) => {
    const active = document.activeElement;
    setOpenCitation({ source, opener: active instanceof HTMLElement ? active : null });
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function ask(text: string, retryId?: number): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const id = retryId ?? nextId.current++;
    setExchanges((current) =>
      retryId
        ? current.map((item) => (item.id === id ? { ...item, result: null, error: null } : item))
        : [{ id, question: trimmed, result: null, error: null }, ...current]
    );
    if (!retryId) setQuestion("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await askCompliance(trimmed, controller.signal);
      setExchanges((current) => current.map((item) => (item.id === id ? { ...item, result } : item)));
    } catch (reason) {
      if (reason instanceof UnauthorizedError) return;
      const message =
        reason instanceof DOMException && reason.name === "AbortError"
          ? "Question cancelled."
          : reason instanceof Error
            ? reason.message
            : "The question could not be answered.";
      setExchanges((current) =>
        current.map((item) => (item.id === id ? { ...item, error: message } : item))
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    void ask(question);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask(question);
    }
  }

  return (
    <section aria-labelledby="ask-compliance" className="flex flex-col gap-3">
      <div>
        <h2 id="ask-compliance" className="text-xl font-semibold tracking-tight">
          Ask the compliance documents
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Answers cite the document section they come from, or say the documents do not cover
          the question. Each question is recorded in the security log without its text.
        </p>
      </div>
      <form onSubmit={onSubmit} className="composer-frame">
        <label htmlFor="compliance-question" className="composer-label">
          Question
        </label>
        <textarea
          id="compliance-question"
          name="question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          maxLength={1000}
          rows={2}
          placeholder={suggestions.length > 0 ? example : FALLBACK_PLACEHOLDER}
          className="composer-input placeholder:opacity-90"
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            <kbd className="kbd">Enter</kbd> to ask
          </span>
          <div className="flex items-center gap-2">
            {busy ? (
              <button type="button" onClick={() => abortRef.current?.abort()} className="btn-whisper px-4 py-2">
                Cancel
              </button>
            ) : null}
            <button
              type="submit"
              disabled={busy || question.trim().length === 0}
              className="btn-primary min-w-24 px-5 py-2 text-base"
            >
              {busy ? "Asking…" : "Ask"}
            </button>
          </div>
        </div>
      </form>

      {exchanges.length > 0 ? (
        <ol className="flex flex-col gap-4" aria-label="Compliance questions and answers">
          {exchanges.map((exchange) => (
            <li key={exchange.id} className="exchange-group">
              <div className="question-row">
                <span aria-hidden>Q</span>
                <p>{exchange.question}</p>
              </div>
              {exchange.result ? (
                <ComplianceAnswer result={exchange.result} onOpenSource={openSource} />
              ) : exchange.error ? (
                <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  <span>{exchange.error}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void ask(exchange.question, exchange.id)}
                    className="rounded-full border border-destructive/40 px-2.5 py-0.5 text-xs font-medium hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <p role="status" className="text-sm text-muted-foreground motion-safe:animate-pulse">
                  Searching the compliance documents…
                </p>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {openCitation ? (
        <ComplianceCitationPanel
          key={openCitation.source.chunk_id}
          source={openCitation.source}
          opener={openCitation.opener}
          onClose={() => setOpenCitation(null)}
        />
      ) : null}
    </section>
  );
}

function ComplianceAnswer({
  result,
  onOpenSource
}: {
  result: ComplianceAskResponse;
  onOpenSource: (source: ComplianceSource) => void;
}): JSX.Element {
  // Built once per answer: re-rendering AnswerMarkdown remounts its chips,
  // and the citation panel hands focus back to the chip that opened it.
  const body = useMemo(
    () => (
      <AnswerMarkdown
        answer={result.answer}
        sources={asChipSources(result.sources)}
        onChipClick={(chunkId) => {
          const source = result.sources.find((candidate) => candidate.chunk_id === chunkId);
          if (source) onOpenSource(source);
        }}
      />
    ),
    [result, onOpenSource]
  );
  // Cite or refuse: an answer without a source renders as a refusal.
  if (result.refused || result.sources.length === 0) {
    return (
      <article className="answer-surface refusal-surface motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-240 motion-safe:ease-out-quart">
        <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-warning-foreground">
          Not found in the compliance documents
        </span>
        <p className="mt-2 text-sm leading-relaxed">{result.answer}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Try the control id, document name or term the documents use.
        </p>
      </article>
    );
  }
  const titles = Array.from(new Set(result.sources.map((source) => source.title)));
  return (
    <article className="answer-surface motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-240 motion-safe:ease-out-quart">
      <div className="answer-kicker">
        <span className="answer-signal" aria-hidden />
        Answer
      </div>
      {body}
      <div className="receipt-strip motion-safe:animate-receipt-in">
        <span className="receipt-count">{result.sources.length}</span>
        <p>
          Source passage{result.sources.length === 1 ? "" : "s"} ·{" "}
          {titles.slice(0, 2).join(", ")}
          {titles.length > 2 ? ` and ${titles.length - 2} more` : ""}
        </p>
      </div>
    </article>
  );
}

function ComplianceCitationPanel({
  source,
  opener,
  onClose
}: {
  source: ComplianceSource;
  opener: HTMLElement | null;
  onClose: () => void;
}): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus moves to Close on open and back to the chip that opened it on close.
  useEffect(() => {
    closeRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  return (
    <aside
      role="dialog"
      aria-label={`Citation: ${source.title}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="fixed right-0 top-14 z-40 flex h-[calc(100vh-3.5rem)] w-[min(560px,90vw)] flex-col border-l border-border bg-card shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 motion-safe:duration-240 motion-safe:ease-out-quart"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Source passage</span>
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {source.title}
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Version {source.version}
            </span>
          </span>
          {source.section ? (
            <span className="text-xs text-muted-foreground">{source.section}</span>
          ) : null}
        </div>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close citation" className="btn-icon">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <div className="flex-1 overflow-auto p-4">
        <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-[13px] leading-relaxed">
          {source.excerpt}
        </pre>
        <Link href={complianceCitationHref(source)} className="btn-whisper mt-3 inline-flex gap-1.5 px-3 py-1.5 text-sm">
          <BookOpen className="h-4 w-4" aria-hidden />
          Open cited passage
        </Link>
      </div>
    </aside>
  );
}
