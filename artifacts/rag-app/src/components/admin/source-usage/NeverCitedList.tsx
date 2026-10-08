import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { RelativeTime } from "@/components/RelativeTime";
import { listKbDocuments } from "@/lib/api";
import { neverCitedDocuments, plural } from "@/lib/sourceUsage";
import type { KbDocumentListItem, SourceUsageSource } from "@/types/api";
import { ErrorAlert } from "./shared";

interface NeverCitedListProps {
  id: string;
  days: number;
  personMode: boolean;
  cited: readonly SourceUsageSource[];
  reloadKey: number;
}

/**
 * Live sources no answer cited in the window. The usage endpoint returns
 * only the count, so the list is the library minus the cited sources; the
 * library request runs only when a manager opens this list.
 */
export function NeverCitedList({
  id,
  days,
  personMode,
  cited,
  reloadKey
}: NeverCitedListProps): JSX.Element {
  const [library, setLibrary] = useState<KbDocumentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLibrary(null);
    setError(null);
    listKbDocuments()
      .then((result) => {
        if (!cancelled) setLibrary(result.items);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load the sources.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const result = useMemo(
    () => (library ? neverCitedDocuments(library, cited) : null),
    [library, cited]
  );

  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <div>
        <h2
          id={`${id}-title`}
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Never cited
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {personMode
            ? `None of this person's answers in the last ${days} days used these sources.`
            : `No answer in the last ${days} days used these sources.`}{" "}
          They may be out of date, hard to match, or not needed.
        </p>
      </div>

      {error ? (
        <ErrorAlert message={error} />
      ) : !result ? (
        <div role="status" className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-4 border-t border-border px-3 py-3 first:border-t-0"
            >
              <div className="skeleton h-4 w-64" />
              <div className="skeleton h-4 w-24" />
            </div>
          ))}
          <span className="sr-only">Loading sources…</span>
        </div>
      ) : result.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
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
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card">
            {result.items.map((doc) => (
              <li
                key={doc.documentId}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm"
              >
                <Link
                  href={`/kb/${encodeURIComponent(doc.documentId)}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {doc.title}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {doc.createdAt ? (
                    <>
                      Added <RelativeTime iso={doc.createdAt} />
                      {" · "}
                    </>
                  ) : null}
                  {plural(doc.viewCount, "view", "views")} in 30 days
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
