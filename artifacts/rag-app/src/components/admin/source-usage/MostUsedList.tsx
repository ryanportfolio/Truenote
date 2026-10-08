import { useState } from "react";
import { barWidth } from "@/lib/sourceUsage";
import { cn } from "@/lib/utils";
import type { SourceUsageSource } from "@/types/api";
import { SourceOpener } from "./shared";

const TOP_ROWS = 10;

function usedTimes(count: number): string {
  return count === 1 ? "used 1 time" : `used ${count} times`;
}

/**
 * The simple ranked list on the everyone view: title, a bar against the top
 * source, and "used <n> times" (answers that quoted it). Selecting a title
 * opens the source drawer. The full table with more columns lives in More
 * detail.
 */
export function MostUsedList({
  sources,
  days,
  activeDocumentId,
  onOpen
}: {
  /** Ranked by citations, as the server sends them. */
  sources: readonly SourceUsageSource[];
  days: number;
  activeDocumentId: string | null;
  onOpen: (documentId: string, title: string | null) => void;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const max = sources.reduce((top, source) => Math.max(top, source.citationCount), 0);
  const rows = showAll ? sources : sources.slice(0, TOP_ROWS);
  return (
    <section aria-labelledby="most-used-title" className="flex flex-col gap-3">
      <div>
        <h2 id="most-used-title" className="text-xl font-semibold tracking-tight">
          Most-used sources
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          How often answers quoted each source in the last {days} days. Select a source to see the
          questions behind it.
        </p>
      </div>
      {sources.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          No answer used a source in this period. Every question went without an answer.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
          <ol className="divide-y divide-border" data-most-used="">
            {rows.map((source) => (
              <li
                key={source.documentId}
                data-most-used-row={source.documentId}
                data-count={source.citationCount}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-3 transition-colors duration-100 ease-out hover:bg-muted/40 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_7rem]",
                  activeDocumentId === source.documentId && "bg-primary/5"
                )}
              >
                {/* Below sm the title takes the full width and the count sits on the bar's line. */}
                <SourceOpener
                  documentId={source.documentId}
                  title={source.title}
                  isLive={source.isLive}
                  onOpen={onOpen}
                  className="col-span-2 min-w-0 text-sm font-medium sm:col-span-1"
                />
                <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div
                    data-bar=""
                    className="h-full rounded-full bg-primary/60"
                    style={{ width: barWidth(source.citationCount, max) }}
                  />
                </div>
                <span
                  className="whitespace-nowrap text-sm tabular-nums text-muted-foreground"
                  data-used-count=""
                >
                  {usedTimes(source.citationCount)}
                </span>
              </li>
            ))}
          </ol>
          {sources.length > TOP_ROWS ? (
            <div className="border-t border-border px-5 py-3">
              <button
                type="button"
                aria-expanded={showAll}
                onClick={() => setShowAll((value) => !value)}
                className="btn-whisper px-3 py-1 text-xs"
              >
                {showAll ? `Show the top ${TOP_ROWS}` : `Show all ${sources.length}`}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
