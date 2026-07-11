import { useState } from "react";
import { Link } from "wouter";
import { Check, Copy, Flag, ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { answerForClipboard } from "@/lib/citation-rendering";
import { citationDocumentHref } from "@/lib/citationLinks";
import { submitFeedback, flagMissingContent } from "@/lib/api";
import type { AskResponse } from "@/types/api";
import { AnswerMarkdown } from "./AnswerMarkdown";
import { CitationPanel } from "./CitationPanel";

interface AnswerViewProps {
  result: AskResponse;
  question: string;
  /** Manager-and-above retrieval details kept inside source inspection. */
  showDebug: boolean;
}

export function AnswerView({ result, question, showDebug }: AnswerViewProps): JSX.Element {
  const [openChunkId, setOpenChunkId] = useState<string | null>(null);

  if (result.refused) {
    return <RefusalView result={result} />;
  }

  const openSource = openChunkId
    ? result.sources.find((s) => s.chunk_id === openChunkId) ?? null
    : null;

  return (
    <>
      <article className="answer-surface motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-240 motion-safe:ease-out-quart">
        <div className="answer-kicker">
          <span className="answer-signal" aria-hidden />
          Answer
        </div>
        <AnswerMarkdown
          answer={result.answer}
          sources={result.sources}
          onChipClick={setOpenChunkId}
        />
        {result.sources.length > 0 ? (
          // The receipt strip: "show the receipt" (PRODUCT.md) made literal.
          // The merged receipt timing makes the grounding print a beat after
          // the answer card lands. Reduced-motion users see it immediately.
          <div className="receipt-strip motion-safe:animate-receipt-in">
            <span className="receipt-count">{result.sources.length}</span>
            <p>
              Source passage{result.sources.length === 1 ? "" : "s"} ·{" "}
              <ReceiptTitles sources={result.sources} queryLogId={result.queryLogId} />
            </p>
          </div>
        ) : null}
        <footer className="mt-4 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
          <span aria-hidden />
          <div className="flex items-center gap-1">
            <CopyAnswerButton result={result} question={question} />
            <FeedbackButtons result={result} />
          </div>
        </footer>
      </article>

      {openSource ? (
        <CitationPanel
          source={openSource}
          queryLogId={result.queryLogId}
          onClose={() => setOpenChunkId(null)}
          showDebug={showDebug}
        />
      ) : null}
    </>
  );
}

/**
 * Unique source documents, capped at two plus a count. Each title links
 * into the knowledge base reader when the server resolved its doc id —
 * the receipt isn't just named, it's openable.
 */
function ReceiptTitles({
  sources,
  queryLogId
}: {
  sources: AskResponse["sources"];
  queryLogId: string | null;
}): JSX.Element {
  const unique = new Map<string, { title: string; href: string | null }>();
  for (const s of sources) {
    const key = s.doc_id ?? s.doc_title;
    if (!unique.has(key)) {
      unique.set(key, {
        title: s.doc_title,
        href: citationDocumentHref(s, queryLogId)
      });
    }
  }
  const docs = Array.from(unique.values());
  const shown = docs.slice(0, 2);
  const rest = docs.length - shown.length;
  return (
    <>
      {shown.map((doc, i) => (
        <span key={doc.href ?? doc.title}>
          {i > 0 ? " · " : ""}
          {doc.href ? (
            <Link
              href={doc.href}
              className="underline underline-offset-2 transition-colors duration-100 ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {doc.title}
            </Link>
          ) : (
            doc.title
          )}
        </span>
      ))}
      {rest > 0 ? ` +${rest} more` : ""}
    </>
  );
}

function CopyAnswerButton({ result, question }: { result: AskResponse; question: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(
        answerForClipboard(result.answer, result.sources, {
          question,
          queryLogId: result.queryLogId,
          origin: window.location.origin
        })
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied (permissions/insecure context): nothing to recover.
    }
  }

  return (
    <>
      <span className="sr-only" aria-live="polite">
        {copied ? "Answer and sources copied" : ""}
      </span>
      <button
      type="button"
      aria-label="Copy answer"
      onClick={() => void copy()}
      className="btn-icon"
      >
        {copied ? (
          <Check
            className="h-4 w-4 text-success motion-safe:animate-in motion-safe:zoom-in-75 motion-safe:duration-100"
            aria-hidden
          />
        ) : (
          <Copy className="h-4 w-4" aria-hidden />
        )}
      </button>
    </>
  );
}

function FeedbackButtons({ result }: { result: AskResponse }): JSX.Element {
  const [feedback, setFeedback] = useState<-1 | 0 | 1>(0);

  async function vote(value: 1 | -1): Promise<void> {
    if (!result.queryLogId) return;
    const prev = feedback;
    const next = feedback === value ? 0 : value;
    setFeedback(next);
    try {
      await submitFeedback(result.queryLogId, next);
    } catch {
      setFeedback(prev); // write failed — don't show feedback that never landed
    }
  }

  return (
    <>
      <button
        aria-label="Thumbs up"
        aria-pressed={feedback === 1}
        onClick={() => void vote(1)}
        className={cn("btn-icon", feedback === 1 && "bg-success/15 text-success")}
      >
        <ThumbsUp className="h-4 w-4" aria-hidden />
      </button>
      <button
        aria-label="Thumbs down"
        aria-pressed={feedback === -1}
        onClick={() => void vote(-1)}
        className={cn("btn-icon", feedback === -1 && "bg-destructive/15 text-destructive")}
      >
        <ThumbsDown className="h-4 w-4" aria-hidden />
      </button>
    </>
  );
}

function RefusalView({ result }: { result: AskResponse }): JSX.Element {
  const [flagged, setFlagged] = useState(false);
  const [flagBusy, setFlagBusy] = useState(false);

  async function flag(): Promise<void> {
    if (!result.queryLogId || flagged || flagBusy) return;
    setFlagBusy(true);
    try {
      await flagMissingContent(result.queryLogId);
      setFlagged(true);
    } catch {
      // Leave the button active so the CSR can retry.
    } finally {
      setFlagBusy(false);
    }
  }

  // Refusal is a successful response (PRODUCT.md: "refusal is a feature") —
  // it gets the same calm card as any answer. The amber lives only in the
  // badge chip, so the state is legible without the card shouting.
  return (
    <article className="answer-surface refusal-surface motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-240 motion-safe:ease-out-quart">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-warning-foreground">
          Not found in these documents
        </span>
      </div>
      <p className="mt-2 text-sm leading-relaxed">{result.answer}</p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Search for the plan, form, or fee name used in the document.
      </p>
      <footer className="mt-4 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
        {result.queryLogId ? (
          <button
            type="button"
            onClick={() => void flag()}
            disabled={flagged || flagBusy}
            className="btn-whisper gap-1.5 px-2.5 py-1 text-xs"
          >
            <Flag className="h-3.5 w-3.5" aria-hidden />
            {flagged ? "Marked as missing" : "Mark as missing"}
          </button>
        ) : (
          <span aria-hidden />
        )}
        <div className="flex items-center gap-1">
          <FeedbackButtons result={result} />
        </div>
      </footer>
    </article>
  );
}
