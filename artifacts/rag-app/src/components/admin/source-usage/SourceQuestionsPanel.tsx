import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { BookOpen, ChevronDown, MessageSquareText, ThumbsDown, X } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { fetchSourceUsageQuestions } from "@/lib/api";
import {
  firstName,
  groupQuestions,
  initials,
  plural,
  scopeCopy,
  type QuestionGroup,
  type UsageScope
} from "@/lib/sourceUsage";
import { cn } from "@/lib/utils";
import type { SourceUsageQuestionsResponse, SourceUsageSource } from "@/types/api";
import { CategoryPath, ErrorAlert, QuestionSignals, SourceName, SourceOpener } from "./shared";

export interface PanelSource {
  documentId: string;
  title: string | null;
  isLive: boolean;
  /**
   * Shows only this person's questions in the drawer while the page keeps its
   * own view (a heatmap cell). Without it the drawer follows the page's person.
   */
  person?: { userId: string; name: string | null };
}

interface SourceQuestionsPanelProps {
  source: PanelSource;
  /** Current numbers for this source, when it is in the ranked list. */
  stats: SourceUsageSource | null;
  /** "Billing / Refunds", or null when the source is in no folder. */
  categoryPath: string | null;
  days: number;
  userId: string | null;
  personName: string | null;
  /** Bumps when the super_user switches program. */
  reloadKey: number;
  /** "Everyone" for the program, "your team" for a supervisor. */
  scope: UsageScope;
  onClose: () => void;
  onSelectPerson: (userId: string | null) => void;
  onOpenSource: (documentId: string, title: string | null) => void;
}

/** One request covers a source's window for nearly every source; the server caps at 200. */
const PAGE_LIMIT = 200;
const GROUPS_PER_STEP = 10;

type TabKey = "all" | "negative" | "refused";

/** Controls that take focus themselves when pressed. */
const FOCUSABLE_SELECTOR = "a[href], button, input, select, textarea, summary, [tabindex]";

/**
 * Focus return after the panel closes. The opener may have unmounted (a
 * By person link applies the person filter, which replaces the table), so
 * fall back to another opener for the same source, then to the page heading.
 * Never scrolls: a jump between the press and the release that closed the
 * drawer would send the click to whatever moved under the pointer.
 */
function restoreFocus(opener: HTMLElement | null, documentIds: readonly string[]): void {
  const options = { preventScroll: true };
  if (opener?.isConnected && !opener.closest("[data-usage-panel]")) {
    opener.focus(options);
    return;
  }
  for (const id of documentIds) {
    const match = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-usage-source="${CSS.escape(id)}"]`)
    ).find((el) => el.isConnected && !el.closest("[data-usage-panel]"));
    if (match) {
      match.focus(options);
      return;
    }
  }
  // The overview's title is screen-reader-only, so its first control (which
  // shows a focus ring) comes before it.
  const control = document.querySelector<HTMLElement>(
    "[data-usage-controls] button, [data-usage-controls] select, [data-usage-controls] a[href]"
  );
  const fallback = [
    document.getElementById("person-focus-title"),
    control,
    document.getElementById("source-usage-title")
  ].find((el): el is HTMLElement => el !== null);
  fallback?.focus(options);
}

/**
 * Side drawer for one source: its folder path, how often answers used it and
 * by how many people, and the questions behind those answers. Identical
 * questions (case and punctuation ignored) are one item with every asker.
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
  scope,
  onClose,
  onSelectPerson,
  onOpenSource
}: SourceQuestionsPanelProps): JSX.Element {
  const copy = scopeCopy(scope);
  const [data, setData] = useState<SourceUsageQuestionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The drawer's own person filter: a cell's person, else the page's person.
  // "Show everyone's" widens only this list; the page stays where it is.
  const person = source.person ?? (userId ? { userId, name: personName } : null);
  const [widenedFor, setWidenedFor] = useState<string | null>(null);
  const widened = person !== null && widenedFor === person.userId;
  const listUserId = widened ? null : (person?.userId ?? null);
  const listPersonName = widened ? null : (person?.name ?? null);
  // Tab and "Show more" belong to one source and filter; any change starts over.
  const viewKey = `${source.documentId}:${days}:${listUserId ?? ""}`;
  const [view, setView] = useState<{ key: string; tab: TabKey; shown: number }>({
    key: viewKey,
    tab: "all",
    shown: GROUPS_PER_STEP
  });
  const tab = view.key === viewKey ? view.tab : "all";
  const shown = view.key === viewKey ? view.shown : GROUPS_PER_STEP;
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const currentSourceRef = useRef(source.documentId);
  // Set when an outside press on a control closed the drawer: that control
  // takes focus itself, so focus is not moved back to the opener.
  const pressedOutsideRef = useRef(false);
  currentSourceRef.current = source.documentId;
  const restricted = source.title === null;
  const tabsId = useId();

  useEffect(() => {
    // Body means the opener already unmounted in the same render that opened the panel.
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    const openerSource = opener?.dataset.usageSource ?? null;
    closeRef.current?.focus();
    return () => {
      if (pressedOutsideRef.current) return;
      const ids = [openerSource, currentSourceRef.current].filter(
        (id): id is string => typeof id === "string"
      );
      restoreFocus(opener, ids);
    };
  }, []);

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      pressedOutsideRef.current =
        target instanceof Element && target.closest(FOCUSABLE_SELECTOR) !== null;
      onClose();
    }
    // On document, so Escape still closes after the focused control inside the
    // drawer unmounted (focus fell to the body). Keys meant for other open
    // layers, or already handled, are left alone.
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      const inPanel = target instanceof Node && panelRef.current?.contains(target);
      if (inPanel || target === document.body || target === document.documentElement) onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  // "Show more questions" unmounts once every group is shown; focus then moves
  // to the first group it revealed instead of falling to the page.
  const focusGroupAt = useRef<number | null>(null);
  useEffect(() => {
    const index = focusGroupAt.current;
    if (index === null) return;
    focusGroupAt.current = null;
    panelRef.current
      ?.querySelectorAll<HTMLElement>("[data-question-group]")
      [index]?.focus();
  });

  useEffect(() => {
    // Restricted sources: the viewer may not read the questions, so nothing is requested.
    if (restricted) return;
    let cancelled = false;
    setError(null);
    setData(null);
    fetchSourceUsageQuestions({
      windowDays: days,
      userId: listUserId,
      documentId: source.documentId,
      limit: PAGE_LIMIT
    })
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
  }, [restricted, source.documentId, days, listUserId, reloadKey]);

  const lists = useMemo(() => {
    const items = data?.items ?? [];
    const negative = items.filter((item) => item.feedback === -1);
    const refused = items.filter((item) => item.refused);
    return {
      all: { count: items.length, groups: groupQuestions(items) },
      negative: { count: negative.length, groups: groupQuestions(negative) },
      refused: { count: refused.length, groups: groupQuestions(refused) },
      people: new Set(items.map((item) => item.userId ?? `name:${item.userName ?? ""}`)).size
    };
  }, [data]);

  const canOpen = !restricted && source.isLive;
  const personFirst = listUserId
    ? listPersonName
      ? firstName(listPersonName)
      : "this person"
    : null;
  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: "all", label: "All", count: lists.all.count },
    { key: "negative", label: "Thumbs down", count: lists.negative.count },
    ...(lists.refused.count > 0
      ? [{ key: "refused" as const, label: "Refused", count: lists.refused.count }]
      : [])
  ];
  const activeTab = tabs.some((item) => item.key === tab) ? tab : "all";
  const active = lists[activeTab];
  const visibleGroups = active.groups.slice(0, shown);

  // One sentence; counts come from the listed items so they match the tabs.
  // When the list stopped at the limit, the server's totals are used and the
  // sentence says the list shows only the newest.
  const summary = !data
    ? null
    : (() => {
        const answers = data.truncated && stats ? stats.citationCount : lists.all.count;
        const people = data.truncated && stats ? stats.userCount : lists.people;
        const negatives = data.truncated && stats ? stats.negativeCount : lists.negative.count;
        const who = personFirst
          ? ` by ${personFirst}`
          : ` by ${plural(people, "person", "people")}`;
        return (
          `Used in ${plural(answers, "answer", "answers")}${who} in the last ${days} days` +
          (negatives > 0 ? `; ${negatives} thumbs down` : "") +
          (data.truncated ? `. The list shows the newest ${data.items.length}.` : "")
        );
      })();

  function selectTab(next: TabKey): void {
    setView({ key: viewKey, tab: next, shown: GROUPS_PER_STEP });
  }

  function onTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    const keys = tabs.map((item) => item.key);
    const index = keys.indexOf(activeTab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % keys.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + keys.length) % keys.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = keys.length - 1;
    if (next === null) return;
    event.preventDefault();
    const key = keys[next];
    if (!key) return;
    selectTab(key);
    document.getElementById(`${tabsId}-tab-${key}`)?.focus();
  }

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-labelledby="source-questions-title"
      data-usage-panel=""
      className="fixed right-0 top-16 z-40 flex h-[calc(100vh-4rem)] w-[min(560px,92vw)] flex-col border-l border-border bg-card shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 motion-safe:duration-240 motion-safe:ease-out-quart"
    >
      <div className="flex-1 overflow-auto">
        <header className="flex flex-col gap-3 px-5 pb-4 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Source details
              </span>
              <h2
                id="source-questions-title"
                className="mt-1 break-words font-display text-2xl font-semibold tracking-tight"
              >
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
          {canOpen ? (
            <Link
              href={`/kb/${encodeURIComponent(source.documentId)}`}
              className="btn-primary inline-flex items-center gap-2 self-start px-5 py-2 text-base"
            >
              <BookOpen className="h-4 w-4" aria-hidden />
              Open source
            </Link>
          ) : restricted ? null : (
            <span className="text-sm text-muted-foreground">
              This source was removed from the library.
            </span>
          )}
          {summary && !restricted ? (
            <p
              className="rounded-lg bg-muted px-4 py-3 text-sm text-foreground"
              data-panel-summary=""
            >
              {summary}
            </p>
          ) : null}
          {person ? (
            <div className="flex flex-wrap items-center gap-2" data-panel-scope={widened ? "everyone" : "person"}>
              <span className="text-sm text-muted-foreground">
                {widened
                  ? copy.everyonesQuestions
                  : `Only ${person.name ?? "this person"}'s questions.`}
              </span>
              <button
                type="button"
                onClick={() => setWidenedFor(widened ? null : person.userId)}
                className="btn-whisper px-3 py-1 text-xs"
              >
                {widened
                  ? `Show only ${person.name ? firstName(person.name) : "this person"}'s`
                  : copy.showEveryones}
              </button>
            </div>
          ) : null}
        </header>

        {restricted ? (
          <p className="mx-5 mb-5 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            Your access level does not include this source or the questions that cited it.
          </p>
        ) : error ? (
          <div className="px-5 pb-5">
            <ErrorAlert message={error} />
          </div>
        ) : !data ? (
          <div role="status" className="flex flex-col gap-4 px-5 pb-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <div className="skeleton h-4 w-5/6" />
                <div className="skeleton h-3 w-1/3" />
              </div>
            ))}
            <span className="sr-only">Loading questions…</span>
          </div>
        ) : data.items.length === 0 ? (
          <div className="px-5 pb-5">
            <EmptyState
              icon={MessageSquareText}
              title="No answer used this source in this period"
              hint={copy.noQuestionsHint}
            />
          </div>
        ) : (
          <div className="flex flex-col">
            <div
              role="tablist"
              aria-label="Which questions to show"
              className="mx-5 flex gap-1 border-b border-border"
            >
              {tabs.map((item) => {
                const selected = item.key === activeTab;
                return (
                  <button
                    key={item.key}
                    id={`${tabsId}-tab-${item.key}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`${tabsId}-panel`}
                    tabIndex={selected ? 0 : -1}
                    data-tab={item.key}
                    onClick={() => selectTab(item.key)}
                    onKeyDown={onTabKeyDown}
                    className={cn(
                      "-mb-px inline-flex items-center gap-2 rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      selected
                        ? "border-primary font-medium text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {item.label}
                    <span
                      className={cn(
                        "rounded-full px-1.5 text-xs tabular-nums",
                        selected ? "bg-primary/10" : "bg-muted"
                      )}
                      data-tab-count=""
                    >
                      {item.count}
                    </span>
                  </button>
                );
              })}
            </div>
            <section
              id={`${tabsId}-panel`}
              role="tabpanel"
              aria-labelledby={`${tabsId}-tab-${activeTab}`}
              className="flex flex-col"
            >
              <h3 className="px-5 pb-1 pt-4 text-base font-semibold">Questions</h3>
              {active.groups.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-muted-foreground">
                  {activeTab === "negative"
                    ? "No answer that used this source was marked thumbs down."
                    : "No questions here."}
                </p>
              ) : (
                <ul className="divide-y divide-border border-y border-border" data-question-groups="">
                  {visibleGroups.map((group) => (
                    <GroupItem
                      key={group.key}
                      group={group}
                      currentDocumentId={source.documentId}
                      onSelectPerson={(id) => onSelectPerson(id)}
                      onOpenSource={onOpenSource}
                    />
                  ))}
                </ul>
              )}
              {active.groups.length > shown ? (
                <div className="flex justify-center px-5 py-3">
                  <button
                    type="button"
                    onClick={() => {
                      // The button stays while more remain; focus moves only when it goes.
                      if (active.groups.length <= shown + GROUPS_PER_STEP) focusGroupAt.current = shown;
                      setView({ key: viewKey, tab: activeTab, shown: shown + GROUPS_PER_STEP });
                    }}
                    className="btn-whisper inline-flex items-center gap-1.5 px-4 py-1.5 text-sm"
                  >
                    Show more questions
                    <ChevronDown className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              ) : null}
            </section>
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * One question as worded (identical asks merged): how many times, who asked
 * (initials chip and name, each a button to that person's coaching guide),
 * and when. The other sources the answers used stay hidden until expanded.
 */
function GroupItem({
  group,
  currentDocumentId,
  onSelectPerson,
  onOpenSource
}: {
  group: QuestionGroup;
  currentDocumentId: string;
  onSelectPerson: (userId: string) => void;
  onOpenSource: (documentId: string, title: string | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const times = group.items.length;
  return (
    <li
      tabIndex={-1}
      className="flex flex-col gap-2 px-5 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      data-question-group=""
      data-asked={times}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-sm font-medium">{group.question}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {times > 1 ? `Asked ${times} times, most recently ` : "Asked "}
            <RelativeTime iso={group.latestAt} />
          </p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={`${open ? "Hide" : "Show"} details for "${group.question}"`}
          onClick={() => setOpen((value) => !value)}
          className="btn-icon shrink-0"
        >
          <ChevronDown
            className={cn(
              "h-4 w-4 transition-transform duration-100 ease-out motion-reduce:transition-none",
              open && "rotate-180"
            )}
            aria-hidden
          />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {group.askers.map((asker) => (
          <AskerChip
            key={asker.userId ?? asker.name}
            name={asker.name}
            userId={asker.userId}
            negativeCount={asker.negativeCount}
            onSelectPerson={onSelectPerson}
          />
        ))}
        {group.refusedCount > 0 ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Refused
          </span>
        ) : null}
      </div>
      <div id={detailsId} hidden={!open}>
        {open ? (
          <GroupDetails
            group={group}
            currentDocumentId={currentDocumentId}
            onOpenSource={onOpenSource}
          />
        ) : null}
      </div>
    </li>
  );
}

/**
 * Who asked: initials and name. A thumbs-down from this person shows as a
 * small icon inside their own chip, so the signal sits with the person who
 * gave it.
 */
function AskerChip({
  name,
  userId,
  negativeCount,
  onSelectPerson
}: {
  name: string;
  userId: string | null;
  negativeCount: number;
  onSelectPerson: (userId: string) => void;
}): JSX.Element {
  const content = (
    <>
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-card text-xs font-semibold text-foreground ring-1 ring-border"
        aria-hidden
      >
        {initials(name)}
      </span>
      <span className="truncate">{name}</span>
      {negativeCount > 0 ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-destructive" data-asker-negative={negativeCount}>
          <ThumbsDown className="h-3 w-3" aria-hidden />
          {negativeCount > 1 ? <span aria-hidden>{negativeCount}</span> : null}
          <span className="sr-only">
            {negativeCount > 1 ? `, ${negativeCount} thumbs down` : ", thumbs down"}
          </span>
        </span>
      ) : null}
    </>
  );
  const chipClass =
    "inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted py-0.5 pl-0.5 pr-2.5 text-xs font-medium text-foreground";
  if (!userId) return <span className={chipClass}>{content}</span>;
  return (
    <button
      type="button"
      onClick={() => onSelectPerson(userId)}
      title={`Open ${name}'s coaching guide`}
      className={cn(
        chipClass,
        "transition-colors duration-100 ease-out hover:bg-muted/60 hover:ring-1 hover:ring-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      )}
    >
      {content}
    </button>
  );
}

/** Each ask (who, when, outcome) and the other sources its answer used. */
function GroupDetails({
  group,
  currentDocumentId,
  onOpenSource
}: {
  group: QuestionGroup;
  currentDocumentId: string;
  onOpenSource: (documentId: string, title: string | null) => void;
}): JSX.Element {
  const others = new Map<string, string | null>();
  for (const item of group.items) {
    for (const cited of item.sources) {
      if (cited.documentId !== currentDocumentId) others.set(cited.documentId, cited.title);
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs">
      <ul className="flex flex-col gap-1">
        {group.items.map((item) => (
          <li key={item.queryLogId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-foreground">{item.userName ?? "Unknown person"}</span>
            <RelativeTime iso={item.askedAt} />
            <QuestionSignals refused={item.refused} feedback={item.feedback} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground">Also cited:</span>
        {others.size === 0 ? (
          <span className="text-muted-foreground">No other source.</span>
        ) : (
          [...others.entries()].map(([documentId, title]) => (
            <SourceOpener
              key={documentId}
              documentId={documentId}
              title={title}
              onOpen={onOpenSource}
              className="max-w-full truncate rounded-full border border-border bg-card px-2 py-0.5 transition-colors duration-100 ease-out hover:border-foreground/30 hover:no-underline"
            />
          ))
        )}
      </div>
    </div>
  );
}
