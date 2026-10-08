import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  barWidth,
  nextSort,
  plural,
  sortSources,
  type SortState,
  type SourceSortKey
} from "@/lib/sourceUsage";
import type { SourceUsageSource } from "@/types/api";
import { InlineBar, SortHeader, SourceName } from "./shared";

const TEXT_KEYS: readonly SourceSortKey[] = ["title"];
const INITIAL_ROWS = 25;

interface SourcesTableProps {
  sources: readonly SourceUsageSource[];
  /** One person selected: the People column always reads 1, so it hides. */
  personMode: boolean;
  activeDocumentId: string | null;
  onOpen: (source: SourceUsageSource) => void;
}

/**
 * Ranked sources with an inline citation bar. The title is the one control
 * per row: it opens the side panel with the questions behind the numbers.
 */
export function SourcesTable({
  sources,
  personMode,
  activeDocumentId,
  onOpen
}: SourcesTableProps): JSX.Element {
  const [sort, setSort] = useState<SortState<SourceSortKey>>({
    key: "citationCount",
    direction: "desc"
  });
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(() => sortSources(sources, sort), [sources, sort]);
  const maxCitations = useMemo(
    () => sources.reduce((max, source) => Math.max(max, source.citationCount), 0),
    [sources]
  );
  const rows = showAll ? sorted : sorted.slice(0, INITIAL_ROWS);
  const onSort = (key: SourceSortKey): void => setSort((current) => nextSort(current, key, TEXT_KEYS));

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Sources ranked by how often answers cited them. Select a source to see its questions.
          </caption>
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <SortHeader label="Source" sortKey="title" sort={sort} onSort={onSort} />
              <SortHeader
                label="Citations"
                sortKey="citationCount"
                sort={sort}
                onSort={onSort}
                align="right"
              />
              <SortHeader
                label="Questions"
                sortKey="questionCount"
                sort={sort}
                onSort={onSort}
                align="right"
                className="hidden md:table-cell"
              />
              {personMode ? null : (
                <SortHeader
                  label="People"
                  sortKey="userCount"
                  sort={sort}
                  onSort={onSort}
                  align="right"
                  className="hidden md:table-cell"
                />
              )}
              <SortHeader
                label="Views"
                sortKey="viewCount"
                sort={sort}
                onSort={onSort}
                align="right"
                className="hidden sm:table-cell"
              />
              <SortHeader
                label="Thumbs down"
                sortKey="negativeCount"
                sort={sort}
                onSort={onSort}
                align="right"
                className="hidden lg:table-cell"
              />
            </tr>
          </thead>
          <tbody>
            {rows.map((source) => {
              const active = source.documentId === activeDocumentId;
              return (
                <tr
                  key={source.documentId}
                  className={cn(
                    "border-t border-border align-top transition-colors duration-100 ease-out hover:bg-muted/40",
                    active && "bg-primary/5"
                  )}
                >
                  <td className="max-w-md px-3 py-2">
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      onClick={() => onOpen(source)}
                      className={cn(
                        "rounded-sm text-left font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        active && "text-primary"
                      )}
                    >
                      <SourceName title={source.title} isLive={source.isLive} />
                      <span className="sr-only">, show the questions that cited it</span>
                    </button>
                    <InlineBar width={barWidth(source.citationCount, maxCitations)} />
                    {/* Narrow screens fold the hidden columns into one line. */}
                    <span className="mt-1 block text-xs text-muted-foreground md:hidden">
                      {plural(source.questionCount, "question", "questions")}
                      {personMode ? "" : ` · ${plural(source.userCount, "person", "people")}`}
                      {` · ${plural(source.viewCount, "view", "views")}`}
                    </span>
                    {source.negativeCount > 0 ? (
                      <span className="mt-1 block text-xs text-destructive lg:hidden">
                        {source.negativeCount} thumbs down
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {source.citationCount}
                  </td>
                  <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground md:table-cell">
                    {source.questionCount}
                  </td>
                  {personMode ? null : (
                    <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground md:table-cell">
                      {source.userCount}
                    </td>
                  )}
                  <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground sm:table-cell">
                    {source.viewCount}
                  </td>
                  <td className="hidden px-3 py-2 text-right tabular-nums lg:table-cell">
                    {source.negativeCount > 0 ? (
                      <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                        {source.negativeCount}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length > INITIAL_ROWS ? (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="btn-whisper self-start px-3 py-1 text-xs"
        >
          {showAll ? `Show the top ${INITIAL_ROWS}` : `Show all ${sorted.length} sources`}
        </button>
      ) : null}
    </div>
  );
}
