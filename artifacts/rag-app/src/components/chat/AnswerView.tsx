import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { tokenizeAnswer, type CitationToken } from "@/lib/citation-rendering";
import { submitFeedback } from "@/lib/api";
import type { AskResponse } from "@/types/api";
import { CitationPanel } from "./CitationPanel";

interface AnswerViewProps {
  result: AskResponse;
}

export function AnswerView({ result }: AnswerViewProps): JSX.Element {
  const [openChunkId, setOpenChunkId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<-1 | 0 | 1>(0);

  if (result.refused) {
    return <RefusalView result={result} />;
  }

  const tokens = tokenizeAnswer(result.answer, result.sources);
  const openSource = openChunkId
    ? result.sources.find((s) => s.chunk_id === openChunkId) ?? null
    : null;

  async function vote(value: 1 | -1): Promise<void> {
    if (!result.queryLogId) return;
    const next = feedback === value ? 0 : value;
    setFeedback(next);
    await submitFeedback(result.queryLogId, next);
  }

  return (
    <>
      <article className="rounded border border-border bg-card p-4">
        <div className="prose prose-sm max-w-none whitespace-pre-wrap leading-relaxed">
          {tokens.map((tok, idx) => (
            <TokenView key={idx} token={tok} onChipClick={setOpenChunkId} />
          ))}
        </div>
        <footer className="mt-4 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span>Confidence: {result.confidence}</span>
            {result.topScore !== null ? <span>Top score: {result.topScore.toFixed(2)}</span> : null}
            <span>{result.latencyMs} ms</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              aria-label="Thumbs up"
              onClick={() => void vote(1)}
              className={cn(
                "rounded p-1 hover:bg-secondary",
                feedback === 1 && "bg-emerald-500/20 text-emerald-700 dark:text-emerald-200"
              )}
            >
              <ThumbsUp className="h-4 w-4" aria-hidden />
            </button>
            <button
              aria-label="Thumbs down"
              onClick={() => void vote(-1)}
              className={cn(
                "rounded p-1 hover:bg-secondary",
                feedback === -1 && "bg-destructive/20 text-destructive"
              )}
            >
              <ThumbsDown className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </footer>
      </article>

      {openSource ? (
        <CitationPanel source={openSource} onClose={() => setOpenChunkId(null)} />
      ) : null}
    </>
  );
}

function TokenView({
  token,
  onChipClick
}: {
  token: CitationToken;
  onChipClick: (chunkId: string) => void;
}): JSX.Element {
  if (token.kind === "text") return <span>{token.text}</span>;
  if (token.kind === "chip") {
    return (
      <button
        onClick={() => onChipClick(token.chunkId)}
        className="mx-0.5 inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0 align-baseline text-xs font-medium text-primary hover:bg-primary/20"
        aria-label={`Citation ${token.ordinal} — ${token.source.doc_title}`}
      >
        [{token.ordinal}]
      </button>
    );
  }
  // unknown-chip: render raw text in destructive color so model drift is visible.
  return <span className="rounded bg-destructive/10 px-1 text-destructive">{token.raw}</span>;
}

function RefusalView({ result }: { result: AskResponse }): JSX.Element {
  const [feedback, setFeedback] = useState<-1 | 0 | 1>(0);

  async function vote(value: 1 | -1): Promise<void> {
    if (!result.queryLogId) return;
    const next = feedback === value ? 0 : value;
    setFeedback(next);
    await submitFeedback(result.queryLogId, next);
  }

  return (
    <article className="rounded border border-warning/40 bg-warning/10 p-4 text-warning-foreground">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
        <span className="rounded bg-warning/30 px-2 py-0.5">Not in knowledge base</span>
      </div>
      <p className="mt-2 text-sm leading-relaxed">{result.answer}</p>
      <footer className="mt-4 flex items-center justify-between border-t border-warning/30 pt-3 text-xs">
        <span>{result.latencyMs} ms</span>
        <div className="flex items-center gap-1">
          <button
            aria-label="Thumbs up"
            onClick={() => void vote(1)}
            className={cn(
              "rounded p-1 hover:bg-warning/20",
              feedback === 1 && "bg-emerald-500/30"
            )}
          >
            <ThumbsUp className="h-4 w-4" aria-hidden />
          </button>
          <button
            aria-label="Thumbs down"
            onClick={() => void vote(-1)}
            className={cn(
              "rounded p-1 hover:bg-warning/20",
              feedback === -1 && "bg-destructive/30"
            )}
          >
            <ThumbsDown className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </footer>
    </article>
  );
}
