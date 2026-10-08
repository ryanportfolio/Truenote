import { RelativeTime } from "@/components/RelativeTime";
import { personLabel } from "@/lib/sourceUsage";
import type { SourceUsageQuestion } from "@/types/api";
import { QuestionSignals, SourceName } from "./shared";

interface QuestionListProps {
  items: readonly SourceUsageQuestion[];
  /** Show who asked, as a button that applies the person filter. */
  onSelectPerson?: (userId: string) => void;
  /** Cited sources render as buttons that open that source's questions. */
  onOpenSource: (documentId: string, title: string | null) => void;
  /** The source the list is about; it is left out of each item's source chips. */
  currentDocumentId?: string | null;
}

/**
 * Exact question text with who asked, when, the outcome, and the sources the
 * answer cited. Managers read the question verbatim: that is the coaching
 * material.
 */
export function QuestionList({
  items,
  onSelectPerson,
  onOpenSource,
  currentDocumentId = null
}: QuestionListProps): JSX.Element {
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => {
        const otherSources = item.sources.filter(
          (source) => source.documentId !== currentDocumentId
        );
        return (
          <li key={item.queryLogId} className="flex flex-col gap-1.5 px-4 py-3">
            <p className="whitespace-pre-wrap break-words text-sm font-medium">{item.question}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {onSelectPerson ? (
                item.userId ? (
                  <button
                    type="button"
                    onClick={() => item.userId && onSelectPerson(item.userId)}
                    className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {personLabel({ name: item.userName })}
                    <span className="sr-only">, show all their questions</span>
                  </button>
                ) : (
                  <span>{personLabel({ name: item.userName })}</span>
                )
              ) : null}
              <RelativeTime iso={item.askedAt} />
              <QuestionSignals refused={item.refused} feedback={item.feedback} />
            </div>
            {otherSources.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">
                  {currentDocumentId ? "Also cited:" : "Cited:"}
                </span>
                {otherSources.map((source) => (
                  <button
                    key={source.documentId}
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => onOpenSource(source.documentId, source.title)}
                    className="max-w-full truncate rounded-full border border-border bg-secondary px-2 py-0.5 text-left transition-colors duration-100 ease-out hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    title={source.title ?? "Restricted source"}
                  >
                    <SourceName title={source.title} />
                    <span className="sr-only">, show the questions that cited it</span>
                  </button>
                ))}
              </div>
            ) : item.sources.length === 0 ? (
              <p className="text-xs text-muted-foreground">No source cited.</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
