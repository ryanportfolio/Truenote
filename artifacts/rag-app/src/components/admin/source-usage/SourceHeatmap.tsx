import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { heatBin, heatBins, plural, type HeatmapModel } from "@/lib/sourceUsage";

interface SourceHeatmapProps {
  model: HeatmapModel;
  /** Applies the person filter (row header). */
  onSelectPerson: (userId: string) => void;
  /** Opens the source panel (column header). */
  onOpenSource: (documentId: string, title: string | null) => void;
  /** Opens one person's questions that cited one source (cell). */
  onOpenCell: (userId: string, documentId: string, title: string | null) => void;
}

/** Cell fill per legend tone: one hue (brand blue), darker means more answers. */
const TONE_CLASS = [
  "bg-card text-muted-foreground outline outline-1 -outline-offset-1 outline-border",
  "bg-primary/15 text-foreground",
  "bg-primary/35 text-foreground",
  "bg-primary/55 text-foreground",
  "bg-primary text-primary-foreground"
] as const;

const RESTRICTED = "Restricted source";

/**
 * Column labels slant up and to the right from the column's center, two
 * lines at most, so long titles stay readable without widening the columns.
 */
const LABEL_CLASS =
  "absolute bottom-1.5 left-1/2 w-36 origin-bottom-left -rotate-[55deg] rounded-sm text-left text-xs leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

type Position = readonly [row: number, col: number];

const key = (row: number, col: number): string => `${row}:${col}`;

/**
 * People x top sources: how many of each person's answers cited each source.
 * One tab stop; arrow keys move between headers and cells (grid pattern).
 * Each cell's accessible name and tooltip read "<name>, <source>: <n> answers".
 * Row headers apply the person filter; column headers open the source panel;
 * a cell with answers opens that person's questions for that source.
 */
export function SourceHeatmap({
  model,
  onSelectPerson,
  onOpenSource,
  onOpenCell
}: SourceHeatmapProps): JSX.Element {
  const { columns, rows, max } = model;
  const bins = useMemo(() => heatBins(max), [max]);
  const tableRef = useRef<HTMLTableElement>(null);
  const [active, setActive] = useState<Position>([1, 1]);
  const [hovered, setHovered] = useState<Position | null>(null);
  const [focused, setFocused] = useState<Position | null>(null);
  const lastRow = rows.length;
  const lastCol = columns.length;
  // The grid can shrink (window change); keep the tab stop on a real position.
  const activeRow = Math.min(active[0], lastRow);
  const activeCol = Math.min(active[1], lastCol);
  const tip = hovered ?? focused;

  const columnName = (col: number): string => columns[col - 1]?.title ?? RESTRICTED;
  const cellLabel = (row: number, col: number): string => {
    const person = rows[row - 1];
    const count = person?.counts[col - 1] ?? 0;
    return `${person?.name ?? "Unknown person"}, ${columnName(col)}: ${plural(count, "answer", "answers")}`;
  };

  function focusAt(row: number, col: number): void {
    tableRef.current?.querySelector<HTMLElement>(`[data-hm="${key(row, col)}"]`)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-hm]");
    if (!target) return;
    const [row, col] = (target.dataset.hm ?? "1:1").split(":").map(Number) as [number, number];
    let next: Position | null = null;
    switch (event.key) {
      case "ArrowRight":
        next = [row, Math.min(col + 1, lastCol)];
        break;
      case "ArrowLeft":
        next = [row, Math.max(col - 1, row === 0 ? 1 : 0)];
        break;
      case "ArrowDown":
        next = [Math.min(row + 1, lastRow), col];
        break;
      case "ArrowUp":
        next = [Math.max(row - 1, col === 0 ? 1 : 0), col];
        break;
      case "Home":
        next = event.ctrlKey ? [1, 1] : [row, row === 0 ? 1 : 0];
        break;
      case "End":
        next = event.ctrlKey ? [lastRow, lastCol] : [row, lastCol];
        break;
      case "Enter":
      case " ":
        // Header buttons handle these natively; cells open their questions.
        if (row > 0 && col > 0) {
          event.preventDefault();
          openCell(row, col);
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    focusAt(next[0], next[1]);
  }

  function openCell(row: number, col: number): void {
    const person = rows[row - 1];
    const column = columns[col - 1];
    if (!person || !column || column.title === null) return;
    if ((person.counts[col - 1] ?? 0) === 0) return;
    onOpenCell(person.userId, column.documentId, column.title);
  }

  /** Roving tab stop plus focus tracking for one grid position. */
  const gridProps = (row: number, col: number) => ({
    "data-hm": key(row, col),
    tabIndex: row === activeRow && col === activeCol ? 0 : -1,
    onFocus: () => {
      setActive([row, col]);
      setFocused([row, col]);
    },
    onBlur: () => setFocused(null)
  });

  // Tooltips sit above the cell; near the edges they align to the cell's side so they stay in view.
  const tipAlign = (col: number): string =>
    col <= 2 ? "left-0" : col > lastCol - 3 ? "right-0" : "left-1/2 -translate-x-1/2";

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
        {/* Right padding leaves room for the last column's slanted label. */}
        <div data-usage-scroll="" className="overflow-x-auto py-3 pl-3 pr-16">
          <table
            ref={tableRef}
            role="grid"
            aria-labelledby="most-cited-title"
            aria-describedby="heatmap-help"
            onKeyDown={onKeyDown}
            onMouseLeave={() => setHovered(null)}
            className="w-full border-separate border-spacing-0.5 text-sm"
          >
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-20 bg-card px-2 align-bottom">
                  <span className="sr-only">Person</span>
                </th>
                {columns.map((column, i) => {
                  const col = i + 1;
                  const restricted = column.title === null;
                  const label = column.title ?? RESTRICTED;
                  return (
                    <th
                      key={column.documentId}
                      scope="col"
                      className="relative h-36 min-w-[2.75rem] p-0 align-bottom font-medium"
                    >
                      {restricted ? (
                        <span
                          {...gridProps(0, col)}
                          aria-label={`${RESTRICTED}. Your access level does not include this source.`}
                          className={cn(LABEL_CLASS, "inline-flex items-center gap-1 italic text-muted-foreground")}
                        >
                          <Lock className="h-3 w-3 shrink-0" aria-hidden />
                          {RESTRICTED}
                        </span>
                      ) : (
                        <button
                          type="button"
                          {...gridProps(0, col)}
                          aria-haspopup="dialog"
                          aria-label={`${label}, show the questions that cited it`}
                          data-usage-source={column.documentId}
                          title={label}
                          onClick={() => onOpenSource(column.documentId, column.title)}
                          className={cn(
                            LABEL_CLASS,
                            "line-clamp-2 text-foreground underline-offset-2 transition-colors duration-100 ease-out hover:text-primary hover:underline"
                          )}
                        >
                          {label}
                        </button>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((person, i) => {
                const row = i + 1;
                return (
                  <tr key={person.userId}>
                    <th
                      scope="row"
                      className="sticky left-0 z-20 max-w-[11rem] bg-card py-0 pl-1 pr-3 text-left font-normal"
                    >
                      <button
                        type="button"
                        {...gridProps(row, 0)}
                        aria-label={`${person.name}, show their questions`}
                        data-hm-person={person.userId}
                        onClick={() => onSelectPerson(person.userId)}
                        className="block max-w-full truncate whitespace-nowrap rounded-sm text-left underline-offset-2 transition-colors duration-100 ease-out hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {person.name}
                      </button>
                    </th>
                    {person.counts.map((count, j) => {
                      const col = j + 1;
                      const bin = heatBin(count, bins);
                      const canOpen = count > 0 && columns[j]?.title !== null;
                      const showTip = tip !== null && tip[0] === row && tip[1] === col;
                      return (
                        <td
                          key={columns[j]?.documentId ?? j}
                          role="gridcell"
                          {...gridProps(row, col)}
                          aria-label={cellLabel(row, col)}
                          data-heat-tone={bin.tone}
                          onMouseEnter={() => setHovered([row, col])}
                          onClick={() => openCell(row, col)}
                          className={cn(
                            "relative h-10 min-w-[2.75rem] rounded-md text-center text-xs font-medium tabular-nums focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                            TONE_CLASS[bin.tone] ?? TONE_CLASS[0],
                            canOpen && "cursor-pointer"
                          )}
                        >
                          <span aria-hidden>{count}</span>
                          {showTip ? (
                            <span
                              aria-hidden
                              className={cn(
                                "pointer-events-none absolute bottom-full z-30 mb-1.5 w-max max-w-[16rem] rounded-md bg-foreground px-2 py-1 text-left text-xs font-normal text-background shadow-panel",
                                tipAlign(col)
                              )}
                            >
                              {cellLabel(row, col)}
                            </span>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Inside the card: the swatches blend over the same surface as the cells. */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span id="heatmap-legend-title" className="font-medium">
              Answers per cell
            </span>
            <ul aria-labelledby="heatmap-legend-title" className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {bins.map((bin) => (
                <li key={bin.label} className="inline-flex items-center gap-1.5 tabular-nums">
                  <span
                    aria-hidden
                    className={cn("h-3.5 w-5 rounded-sm", TONE_CLASS[bin.tone])}
                  />
                  {bin.label}
                </li>
              ))}
            </ul>
          </div>
          <span className="tabular-nums">
            {plural(rows.length, "person", "people")} · {plural(columns.length, "source", "sources")}
          </span>
        </div>
      </div>
    </div>
  );
}
