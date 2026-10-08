import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { BookOpen, MessageSquareText, X } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { fetchSourceUsageQuestions } from "@/lib/api";
import { firstName, plural } from "@/lib/sourceUsage";
import type { SourceUsageQuestionsResponse, SourceUsageSource } from "@/types/api";
import { QuestionList } from "./QuestionList";
import { CategoryPath, ErrorAlert, SourceName } from "./shared";

export interface PanelSource {
  documentId: string;
  title: string | null;
  isLive: boolean;
}

interface SourceQuestionsPanelProps {
  source: PanelSource;
  /** Current numbers for this source, when it is in the ranked list. */
  stats: SourceUsageSource | null;
  /** "Billing / Refunds", or null when the source is in no category. */
  categoryPath: string | null;
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

/** Elements the page marks as focus targets when the opener is gone. */
const FALLBACK_FOCUS_IDS = ["person-focus-title", "source-usage-title"];

/**
 * Focus return after the panel closes. The opener may have unmounted (a
 * By person link applies the person filter, which replaces the table), so
 * fall back to another opener for the same source, then to the page heading.
 */
function restoreFocus(opener: HTMLElement | null, documentIds: readonly string[]): void {
  if (opener?.isConnected && !opener.closest("[data-usage-panel]")) {
    opener.focus();
    return;
  }
  for (const id of documentIds) {
    const match = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-usage-source="${CSS.escape(id)}"]`)
    ).find((el) => el.isConnected && !el.closest("[data-usage-panel]"));
    if (match) {
      match.focus();
      return;
    }
  }
  for (const id of FALLBACK_FOCUS_IDS) {
    const el = document.getElementById(id);
    if (el) {
      el.focus();
      return;
    }
  }
}

/**
 * Side panel: every question in the window whose answer cited one source.
 * Same keyboard contract as PreviewPanel: focus lands on Close, Escape or an
 * outside press closes, focus returns to the opener (or a stable stand-in).
 */
export function SourceQuestionsPanel({
  source,
  stats,
  categoryPath,
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
  const currentSourceRef = useRef(source.documentId);
  currentSourceRef.current = source.documentId;
  const restricted = source.title === null;

  useEffect(() => {
    // Body means the opener already unmounted in the same render that opened the panel.
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    const openerSource = opener?.dataset.usageSource ?? null;
    closeRef.current?.focus();
    return () => {
      const ids = [openerSource, currentSourceRef.current].filter(
        (id): id is string => typeof id === "string"
      );
      restoreFocus(opener, ids);
    };
  }, []);

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  useEffect(() => {
    // Restricted sources: the viewer may not read the questions, so nothing is requested.
    if (restricted) return;
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
  }, [restricted, source.documentId, days, userId, limit, reloadKey]);

  const canOpen = !restricted && source.isLive;
  const shown = data?.items.length ?? 0;
  const who = userId ? ` from ${personName ?? "this person"}` : "";
  // Person mode counts only that person's reader opens; the sentence names them.
  const viewer = userId ? (personName ? firstName(personName) : "This person") : null;
  const views = stats
    ? viewer
      ? stats.viewCount > 0
        ? `${viewer} opened it ${plural(stats.viewCount, "time", "times")} in the reader`
        : `${viewer} has not opened it in the reader`
      : `Asked by ${plural(stats.userCount, "person", "people")} · Opened ${plural(stats.viewCount, "time", "times")} in the reader`
    : null;
  const summary = !data
    ? null
    : !data.truncated
      ? `${plural(shown, "question", "questions")}${who} · Last ${days} days`
      : stats
        ? `${plural(stats.citationCount, "question", "questions")}${who} · Last ${days} days · showing the newest ${shown}`
        : `Showing the newest ${shown} questions${who} · Last ${days} days`;

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-labelledby="source-questions-title"
      data-usage-panel=""
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="fixed right-0 top-16 z-40 flex h-[calc(100vh-4rem)] w-[min(560px,90vw)] flex-col border-l border-border bg-card shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 motion-safe:duration-240 motion-safe:ease-out-quart"
    >
      <header className="flex flex-col gap-3 border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Source details
            </span>
            <h2 id="source-questions-title" className="text-xl font-semibold tracking-tight">
              <SourceName title={source.title} isLive={source.isLive} />
            </h2>
            <CategoryPath path={restricted ? null : categoryPath} />
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close source details"
            className="btn-icon shrink-0"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {canOpen ? (
            <Link
              href={`/kb/${encodeURIComponent(source.documentId)}`}
              className="btn-primary inline-flex items-center gap-1.5 px-4 py-1.5 text-sm"
            >
              <BookOpen className="h-4 w-4" aria-hidden />
              Open source
            </Link>
          ) : restricted ? null : (
            <span className="text-sm text-muted-foreground">
              This source was removed from the library.
            </span>
          )}
          {views && !restricted ? (
            <span className="text-xs text-muted-foreground">{views}</span>
          ) : null}
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {restricted ? (
          <p className="m-5 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            Your access level does not include this source or the questions that cited it.
          </p>
        ) : (
          <section aria-labelledby="source-questions-list-title">
            <div className="flex flex-col gap-1 px-5 pb-2 pt-4">
              <h3 id="source-questions-list-title" className="text-base font-semibold">
                Questions citing this source
              </h3>
              {summary ? (
                <p className="text-xs text-muted-foreground" data-panel-summary="">
                  {summary}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Each item is one time someone asked and the answer cited this source.
              </p>
              {userId ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
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
                </div>
              ) : null}
            </div>
            {error ? (
              <div className="p-5">
                <ErrorAlert message={error} />
              </div>
            ) : !data ? (
              <div role="status" className="flex flex-col gap-4 p-5">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex flex-col gap-2">
                    <div className="skeleton h-4 w-5/6" />
                    <div className="skeleton h-3 w-1/3" />
                  </div>
                ))}
                <span className="sr-only">Loading questions…</span>
              </div>
            ) : data.items.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  icon={MessageSquareText}
                  title="No questions cited this source in this window"
                  hint="Try a longer time window, or show everyone."
                />
              </div>
            ) : (
              <div className="border-t border-border">
                <QuestionList
                  items={data.items}
                  currentDocumentId={source.documentId}
                  onSelectPerson={(id) => onSelectPerson(id)}
                  onOpenSource={onOpenSource}
                />
                {data.truncated ? (
                  <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3 text-xs text-muted-foreground">
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
              </div>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}
