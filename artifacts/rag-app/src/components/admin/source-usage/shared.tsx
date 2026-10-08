import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Lock, ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SortState } from "@/lib/sourceUsage";

/** Quiet-alert recipe from DESIGN.md, with an optional recovery action. */
export function ErrorAlert({
  message,
  children
}: {
  message: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <span>{message}</span>
      {children}
    </div>
  );
}

/**
 * A source's display name. Null titles mean the viewer's clearance is below
 * the document's classification: the server withholds the title, so the UI
 * says so instead of guessing.
 */
export function SourceName({
  title,
  isLive = true
}: {
  title: string | null;
  isLive?: boolean;
}): JSX.Element {
  return (
    <>
      {title === null ? (
        <span className="inline-flex items-center gap-1 italic text-muted-foreground">
          <Lock className="h-3 w-3 shrink-0" aria-hidden />
          Restricted source
        </span>
      ) : (
        <span>{title}</span>
      )}
      {!isLive ? (
        <span className="ml-2 inline-block rounded-full bg-muted px-2 py-0.5 align-middle text-xs font-medium not-italic text-muted-foreground">
          Removed
        </span>
      ) : null}
    </>
  );
}

/** Refused and feedback chips, same recipe as the Content gaps review queue. */
export function QuestionSignals({
  refused,
  feedback
}: {
  refused: boolean;
  feedback: number | null;
}): JSX.Element | null {
  const badges: JSX.Element[] = [];
  if (refused) {
    badges.push(
      <span
        key="refused"
        className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      >
        Refused
      </span>
    );
  }
  if (feedback === -1) {
    badges.push(
      <span
        key="down"
        className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
      >
        <ThumbsDown className="h-3 w-3" aria-hidden />
        Thumbs down
      </span>
    );
  }
  if (feedback === 1) {
    badges.push(
      <span
        key="up"
        className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success"
      >
        <ThumbsUp className="h-3 w-3" aria-hidden />
        Thumbs up
      </span>
    );
  }
  return badges.length > 0 ? <>{badges}</> : null;
}

/** Sortable column header: a real button inside the th, with aria-sort on the th. */
export function SortHeader<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
  className,
  title
}: {
  label: string;
  /** Plain meaning of the column, shown as a tooltip. */
  title?: string;
  sortKey: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  align?: "left" | "right";
  className?: string;
}): JSX.Element {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      title={title}
      className={cn(
        "whitespace-nowrap px-3 py-2 font-medium",
        align === "right" && "text-right",
        className
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 whitespace-nowrap rounded-sm uppercase tracking-wide transition-colors duration-100 ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          align === "right" && "flex-row-reverse",
          active && "text-foreground"
        )}
      >
        {label}
        <Icon className={cn("h-3 w-3", !active && "opacity-50")} aria-hidden />
      </button>
    </th>
  );
}

/** Thin horizontal bar for a count. Decorative: the number is always printed beside it. */
export function InlineBar({ width }: { width: string }): JSX.Element {
  return (
    <div className="mt-1.5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted" aria-hidden>
      <div className="h-full rounded-full bg-primary/50" style={{ width }} />
    </div>
  );
}

/** Shared look for a source title that opens the questions panel. */
const OPENER_CLASS =
  "rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

const RESTRICTED_HINT = "Your access level does not include this source or the questions that cited it.";

/**
 * A source title that opens its questions panel. Restricted sources (title
 * null) stay plain text: the viewer may not read the source or the questions
 * behind it, so there is nothing to open and no request is made.
 *
 * `data-usage-source` lets the panel find a stable element for the same
 * source when its opener unmounted (focus return).
 */
export function SourceOpener({
  documentId,
  title,
  isLive = true,
  label,
  onOpen,
  className,
  children
}: {
  documentId: string;
  title: string | null;
  isLive?: boolean;
  /** Accessible name; defaults to "<title>, show the questions that cited it". */
  label?: string;
  onOpen: (documentId: string, title: string | null) => void;
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  if (title === null) {
    return (
      <span className={cn("inline-block", className)} title={RESTRICTED_HINT}>
        <SourceName title={null} isLive={isLive} />
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={label ?? `${title}, show the questions that cited it`}
      data-usage-source={documentId}
      onClick={() => onOpen(documentId, title)}
      className={cn(OPENER_CLASS, className)}
    >
      <SourceName title={title} isLive={isLive} />
      {children}
    </button>
  );
}

/** Muted folder path line under a source title ("Billing / Refunds"). */
export function CategoryPath({ path }: { path: string | null }): JSX.Element | null {
  if (!path) return null;
  return <span className="block truncate text-xs text-muted-foreground">{path}</span>;
}

/** Role badge next to a name: neutral muted pill, the label carries the meaning. */
export function RoleBadge({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}
