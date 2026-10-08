import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCategoryPaths, neverCitedDocuments, neverCitedHref } from "@/lib/sourceUsage";
import type { KbDocumentListItem, SourceUsageSource } from "@/types/api";
import { CategoryPath, ErrorAlert } from "./shared";

interface NeverCitedListProps {
  id: string;
  days: number;
  cited: readonly SourceUsageSource[];
  /** The program's library as this manager sees it; null while loading. */
  library: readonly KbDocumentListItem[] | null;
  libraryError: string | null;
  categoryPaths: ReadonlyMap<string, string[]>;
  /** Full-width placement below the sources (wide table or heatmap): the list flows in columns. */
  wide?: boolean;
}

const INITIAL_ITEMS = 8;

/**
 * Side card: live sources no answer cited in the window. The usage endpoint
 * returns only the count, so the list is the library minus the cited sources.
 */
export function NeverCitedList({
  id,
  days,
  cited,
  library,
  libraryError,
  categoryPaths,
  wide = false
}: NeverCitedListProps): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const result = useMemo(
    () => (library ? neverCitedDocuments(library, cited) : null),
    [library, cited]
  );
  const items = result ? (showAll ? result.items : result.items.slice(0, INITIAL_ITEMS)) : [];

  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5 shadow-card"
    >
      <div>
        <h2
          id={`${id}-title`}
          tabIndex={-1}
          className="rounded-sm text-base font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Never cited{result ? ` (${result.items.length})` : ""}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Live sources no answer used in the last {days} days. They may be out of date, hard to
          match, or not needed.
        </p>
      </div>

      {libraryError ? (
        <ErrorAlert message={libraryError} />
      ) : !result ? (
        <div role="status" className="flex flex-col gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-4 w-full" />
          ))}
          <span className="sr-only">Loading sources…</span>
        </div>
      ) : result.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Every source you can see was cited at least once.
        </p>
      ) : (
        <>
          {!result.complete ? (
            <p className="text-xs text-muted-foreground">
              The ranked list stops at 100 sources, so a source cited only rarely may also appear
              here.
            </p>
          ) : null}
          <ul
            className={cn(
              "border-t border-border",
              wide ? "grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3" : "flex flex-col"
            )}
          >
            {items.map((doc) => (
              <li key={doc.documentId} className="min-w-0 border-b border-border py-2 text-sm">
                <Link
                  href={`/kb/${encodeURIComponent(doc.documentId)}`}
                  className="block rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {doc.title}
                </Link>
                <CategoryPath path={formatCategoryPaths(categoryPaths.get(doc.documentId))} />
              </li>
            ))}
          </ul>
          {result.items.length > INITIAL_ITEMS ? (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((value) => !value)}
              className="btn-whisper self-start px-3 py-1 text-xs"
            >
              {showAll ? `Show the first ${INITIAL_ITEMS}` : `Show all ${result.items.length}`}
            </button>
          ) : null}
        </>
      )}
      <Link
        href={neverCitedHref(result?.items.map((doc) => doc.documentId) ?? [])}
        className="inline-flex items-center gap-1 self-start rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Review in Sources
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </section>
  );
}
