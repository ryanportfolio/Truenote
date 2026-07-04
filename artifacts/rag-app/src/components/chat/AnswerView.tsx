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
      <article className="rounded border border-border bg-card p-4">
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
      className="rounded p-1 hover:bg-secondary"
    >
      {copied ? (
        <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-300" aria-hidden />
      ) : (
        <Copy className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}

function FeedbackButtons({
  result,
  hoverClass = "hover:bg-secondary"
}: {
  result: AskResponse;
  hoverClass?: string;
}): JSX.Element {
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
        className={cn(
          "rounded p-1",
          hoverClass,
          feedback === 1 && "bg-emerald-500/20 text-emerald-700 dark:text-emerald-200"
        )}
      >
        <ThumbsUp className="h-4 w-4" aria-hidden />
      </button>
      <button
        aria-label="Thumbs down"
        aria-pressed={feedback === -1}
        onClick={() => void vote(-1)}
        className={cn(
          "rounded p-1",
          hoverClass,
          feedback === -1 && "bg-destructive/20 text-destructive"
        )}
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

  return (
    <article className="rounded border border-warning/40 bg-warning/10 p-4 text-warning-foreground">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
        <span className="rounded bg-warning/30 px-2 py-0.5">Not in knowledge base</span>
      </div>
      <p className="mt-2 text-sm leading-relaxed">{result.answer}</p>
      <p className="mt-2 text-xs leading-relaxed opacity-80">
        Try rephrasing with the exact term the docs use (plan name, form number, fee name).
      </p>
      <footer className="mt-4 flex items-center justify-between border-t border-warning/30 pt-3 text-xs">
        {result.queryLogId ? (
          <button
            type="button"
            onClick={() => void flag()}
            disabled={flagged || flagBusy}
            className={cn(
              "inline-flex items-center gap-1.5 rounded border border-warning/40 px-2 py-1 font-medium",
              flagged ? "opacity-70" : "hover:bg-warning/20"
            )}
          >
            <Flag className="h-3.5 w-3.5" aria-hidden />
            {flagged ? "Flagged — admins will review this gap" : "Flag as missing content"}
          </button>
        ) : (
          <span aria-hidden />
        )}
        <div className="flex items-center gap-1">
          {showDebug ? <span className="mr-2 text-warning-foreground/70">{result.latencyMs} ms</span> : null}
          <FeedbackButtons result={result} hoverClass="hover:bg-warning/20" />
        </div>
      </footer>
    </article>
  );
}
