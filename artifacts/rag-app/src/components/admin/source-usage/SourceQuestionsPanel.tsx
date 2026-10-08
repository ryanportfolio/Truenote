import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { BookOpen, MessageSquareText, X } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { fetchSourceUsageQuestions } from "@/lib/api";
import { plural } from "@/lib/sourceUsage";
import type { SourceUsageQuestionsResponse, SourceUsageSource } from "@/types/api";
import { QuestionList } from "./QuestionList";
import { ErrorAlert, SourceName } from "./shared";

export interface PanelSource {
  documentId: string;
  title: string | null;
  isLive: boolean;
}

interface SourceQuestionsPanelProps {
  source: PanelSource;
  /** Current numbers for this source, when it is in the ranked list. */
  stats: SourceUsageSource | null;
  days: number;
  userId: string | null;
  personName: string | null;
  /** Bumps when the super_user switches program. */
  reloadKey: number;
  onClose: () => void;
  onSelectPerson: (userId: string | null) => void;
  onOpenSource: (documentId: string, title: string | null) => void;
}

const FIRST_PAGE = 50;
const MAX_PAGE = 200;

/**
 * Side panel: every question in the window whose answer cited one source.
 * Same keyboard contract as PreviewPanel: focus lands on Close, Escape or an
 * outside press closes, focus returns to the opener.
 */
export function SourceQuestionsPanel({
  source,
  stats,
  days,
  userId,
  personName,
  reloadKey,
  onClose,
  onSelectPerson,
  onOpenSource
}: SourceQuestionsPanelProps): JSX.Element {
  // "Load more" belongs to one source and filter; any change starts from the first page.
  const pageKey = `${source.documentId}:${days}:${userId ?? ""}`;
  const [page, setPage] = useState({ key: pageKey, limit: FIRST_PAGE });
  const limit = page.key === pageKey ? page.limit : FIRST_PAGE;
  const [data, setData] = useState<SourceUsageQuestionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => restoreRef.current?.focus();
  }, []);

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData((current) => (limit > FIRST_PAGE ? current : null));
    fetchSourceUsageQuestions({ windowDays: days, userId, documentId: source.documentId, limit })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load the questions.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source.documentId, days, userId, limit, reloadKey]);

  const canOpen = source.title !== null && source.isLive;

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-labelledby="source-questions-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="fixed right-0 top-14 z-40 flex h-[calc(100vh-3.5rem)] w-[min(560px,90vw)] flex-col border-l border-border bg-card shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 motion-safe:duration-240 motion-safe:ease-out-quart"
    >
      <header className="flex flex-col gap-3 border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Questions that cited
            </span>
            <h2 id="source-questions-title" className="text-base font-semibold">
              <SourceName title={source.title} isLive={source.isLive} />
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close questions"
            className="btn-icon shrink-0"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {stats ? (
          <p className="text-xs text-muted-foreground">
            {plural(stats.citationCount, "citation", "citations")} ·{" "}
            {plural(stats.questionCount, "question", "questions")}
            {userId ? "" : ` · ${plural(stats.userCount, "person", "people")}`} ·{" "}
            {plural(stats.viewCount, "view", "views")} in the last {days} days
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {canOpen ? (
            <Link
              href={`/kb/${encodeURIComponent(source.documentId)}`}
              className="btn-whisper inline-flex items-center gap-1.5 px-3 py-1 text-xs"
            >
              <BookOpen className="h-3.5 w-3.5" aria-hidden />
              Open source
            </Link>
          ) : null}
          {userId ? (
            <>
              <span className="text-xs text-muted-foreground">
                Only {personName ?? "this person"}'s questions.
              </span>
              <button
                type="button"
                onClick={() => onSelectPerson(null)}
                className="btn-whisper px-3 py-1 text-xs"
              >
                Show everyone's
              </button>
            </>
          ) : null}
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="p-4">
            <ErrorAlert message={error} />
          </div>
        ) : !data ? (
          <div role="status" className="flex flex-col gap-4 p-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <div className="skeleton h-4 w-5/6" />
                <div className="skeleton h-3 w-1/3" />
              </div>
            ))}
            <span className="sr-only">Loading questions…</span>
          </div>
        ) : data.items.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={MessageSquareText}
              title="No questions cited this source in this window"
              hint="Try a longer time window, or show everyone."
            />
          </div>
        ) : (
          <>
            <QuestionList
              items={data.items}
              currentDocumentId={source.documentId}
              onSelectPerson={(id) => onSelectPerson(id)}
              onOpenSource={onOpenSource}
            />
            {data.truncated ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
                <span>Showing the newest {data.items.length}.</span>
                {limit < MAX_PAGE ? (
                  <button
                    type="button"
                    onClick={() => setPage({ key: pageKey, limit: MAX_PAGE })}
                    className="btn-whisper px-3 py-1 text-xs"
                  >
                    Load up to {MAX_PAGE}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
