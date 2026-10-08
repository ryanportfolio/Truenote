import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  SOURCE_COLUMN_OPTIONS,
  barWidth,
  nextSort,
  plural,
  sortSources,
  type SortState,
  type SourceColumn,
  type SourceSortKey
} from "@/lib/sourceUsage";
import type { SourceUsageSource } from "@/types/api";
import { InlineBar, SortHeader, SourceOpener } from "./shared";

const TEXT_KEYS: readonly SourceSortKey[] = ["title"];
const INITIAL_ROWS = 10;

interface SourcesTableProps {
  sources: readonly SourceUsageSource[];
  /** Optional columns the manager turned on, in menu order. Citations always shows. */
  columns: readonly SourceColumn[];
  activeDocumentId: string | null;
  onOpen: (documentId: string, title: string | null) => void;
}

function columnUnit(key: SourceColumn, value: number): string {
  switch (key) {
    case "userCount":
      return plural(value, "person", "people");
    case "questionCount":
      return plural(value, "distinct question", "distinct questions");
    case "viewCount":
      return plural(value, "view", "views");
    case "negativeCount":
      return `${value} thumbs down`;
  }
}

/**
 * Ranked sources with an inline citation bar. The title is the one control
 * per row: it opens the side panel with the questions behind the numbers.
 * Restricted sources show their numbers but cannot be opened.
 */
export function SourcesTable({
  sources,
  columns,
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
  const optional = SOURCE_COLUMN_OPTIONS.filter((option) => columns.includes(option.key));
  // Narrow screens fold optional columns into the title cell: People below
  // sm, the rest below md. Tighter padding lets every column fit at 1024px.
  const columnClass = (key: SourceColumn): string =>
    cn("px-2", key === "userCount" ? "hidden sm:table-cell" : "hidden md:table-cell");

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
        {/* Every column on can outgrow a narrow card: scroll inside it, never clip. */}
        <div data-usage-scroll="" className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Sources ranked by how often answers cited them. Select a source to see its questions.
            </caption>
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <SortHeader
                  label="Source"
                  sortKey="title"
                  sort={sort}
                  onSort={onSort}
                  className="md:min-w-[9rem]"
                />
                <SortHeader
                  label="Citations"
                  title="Answers that cited the source"
                  sortKey="citationCount"
                  sort={sort}
                  onSort={onSort}
                  align="right"
                />
                {optional.map((option) => (
                  <SortHeader
                    key={option.key}
                    label={option.label}
                    title={option.hint}
                    sortKey={option.key}
                    sort={sort}
                    onSort={onSort}
                    align="right"
                    className={columnClass(option.key)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((source) => {
                const active = source.documentId === activeDocumentId;
                return (
                  <tr
                    key={source.documentId}
                    data-source-row={source.documentId}
                    className={cn(
                      "border-t border-border align-top transition-colors duration-100 ease-out hover:bg-muted/40",
                      active && "bg-primary/5"
                    )}
                  >
                    <td className="w-full max-w-md px-3 py-2 md:min-w-[9rem]">
                      <SourceOpener
                        documentId={source.documentId}
                        title={source.title}
                        isLive={source.isLive}
                        onOpen={onOpen}
                        className={cn("font-medium", active && "text-primary")}
                      />
                      <InlineBar width={barWidth(source.citationCount, maxCitations)} />
                      {optional.length > 0 ? (
                        <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground md:hidden">
                          {optional.map((option) => (
                            <span
                              key={option.key}
                              className={option.key === "userCount" ? "sm:hidden" : undefined}
                            >
                              {columnUnit(option.key, source[option.key])}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                      {source.citationCount}
                    </td>
                    {optional.map((option) => (
                      <td
                        key={option.key}
                        className={cn(
                          "whitespace-nowrap py-2 text-right tabular-nums text-muted-foreground",
                          columnClass(option.key)
                        )}
                      >
                        {source[option.key]}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {sorted.length > INITIAL_ROWS ? (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          aria-expanded={showAll}
          className="btn-whisper self-start px-3 py-1 text-xs"
        >
          {showAll ? `Show the top ${INITIAL_ROWS}` : `Show all ${sorted.length} sources`}
        </button>
      ) : null}
    </div>
  );
}
