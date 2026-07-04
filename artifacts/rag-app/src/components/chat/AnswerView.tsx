import { useState } from "react";
import { Check, Copy, Flag, ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { answerForClipboard } from "@/lib/citation-rendering";
import { submitFeedback, flagMissingContent } from "@/lib/api";
import type { AskResponse } from "@/types/api";
import { AnswerMarkdown } from "./AnswerMarkdown";
import { CitationPanel } from "./CitationPanel";

interface AnswerViewProps {
  result: AskResponse;
  /** Manager-and-above pipeline telemetry (scores, latency, chunk ids). */
  showDebug: boolean;
}

export function AnswerView({ result, showDebug }: AnswerViewProps): JSX.Element {
  const [openChunkId, setOpenChunkId] = useState<string | null>(null);

  if (result.refused) {
    return <RefusalView result={result} showDebug={showDebug} />;
  }

  const openSource = openChunkId
    ? result.sources.find((s) => s.chunk_id === openChunkId) ?? null
    : null;

  return (
    <>
      <article className="rounded-lg border border-border bg-card p-4 shadow-card motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-240 motion-safe:ease-out-quart">
        <AnswerMarkdown
          answer={result.answer}
          sources={result.sources}
          onChipClick={setOpenChunkId}
        />
        <footer className="mt-4 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
          {showDebug ? (
            <div className="flex items-center gap-3">
              <span>Confidence: {result.confidence}</span>
              {result.topScore !== null ? <span>Top score: {result.topScore.toFixed(2)}</span> : null}
              <span>{result.latencyMs} ms</span>
            </div>
          ) : (
            <span aria-hidden />
          )}
          <div className="flex items-center gap-1">
            <CopyAnswerButton result={result} />
            <FeedbackButtons result={result} />
          </div>
        </footer>
      </article>

      {openSource ? (
        <CitationPanel
          source={openSource}
          onClose={() => setOpenChunkId(null)}
          showDebug={showDebug}
        />
      ) : null}
    </>
  );
}

function CopyAnswerButton({ result }: { result: AskResponse }): JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(answerForClipboard(result.answer, result.sources));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied (permissions/insecure context): nothing to recover.
    }
  }

  return (
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

function RefusalView({
  result,
  showDebug
}: {
  result: AskResponse;
  showDebug: boolean;
}): JSX.Element {
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
    <article className="rounded-lg border border-border bg-card p-4 shadow-card motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-240 motion-safe:ease-out-quart">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-warning-foreground">
          Not in knowledge base
        </span>
      </div>
      <p className="mt-2 text-sm leading-relaxed">{result.answer}</p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Try rephrasing with the exact term the docs use (plan name, form number, fee name).
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
            {flagged ? "Flagged — admins will review this gap" : "Flag as missing content"}
          </button>
        ) : (
          <span aria-hidden />
        )}
        <div className="flex items-center gap-1">
          {showDebug ? <span className="mr-2">{result.latencyMs} ms</span> : null}
          <FeedbackButtons result={result} />
        </div>
      </footer>
    </article>
  );
}
