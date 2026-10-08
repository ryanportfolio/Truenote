import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { BarChart3, ChevronDown } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { AtAGlance } from "@/components/admin/source-usage/AtAGlance";
import { AttentionCards } from "@/components/admin/source-usage/AttentionCards";
import { ColumnsMenu } from "@/components/admin/source-usage/ColumnsMenu";
import { NeverCitedList } from "@/components/admin/source-usage/NeverCitedList";
import { PeopleTable } from "@/components/admin/source-usage/PeopleTable";
import { MostUsedList } from "@/components/admin/source-usage/MostUsedList";
import {
  PersonFocus,
  PersonHeader,
  type TeamNumbers
} from "@/components/admin/source-usage/PersonFocus";
import { PersonPicker } from "@/components/admin/source-usage/PersonPicker";
import { SourceHeatmap } from "@/components/admin/source-usage/SourceHeatmap";
import {
  SourceQuestionsPanel,
  type PanelSource
} from "@/components/admin/source-usage/SourceQuestionsPanel";
import { SourcesTable } from "@/components/admin/source-usage/SourcesTable";
import { SourcesViewSwitch } from "@/components/admin/source-usage/SourcesViewSwitch";
import { TimeSelect } from "@/components/admin/source-usage/TimeSelect";
import { UsageHighlights } from "@/components/admin/source-usage/UsageHighlights";
import { UsageKpis } from "@/components/admin/source-usage/UsageKpis";
import { ErrorAlert } from "@/components/admin/source-usage/shared";
import { fetchSourceUsage, listKbDocuments } from "@/lib/api";
import {
  SELECTED_PROGRAM_CHANGED_EVENT,
  getSelectedProgramIdRaw
} from "@/lib/selectedProgram";
import {
  attentionCards,
  buildUsageHref,
  categoryPathsByDocument,
  formatCategoryPaths,
  heatmapModel,
  loadMoreDetailOpen,
  loadSourceColumns,
  loadSourceView,
  neverCitedDocuments,
  parseUsageQuery,
  personLabel,
  plural,
  roleLabel,
  saveMoreDetailOpen,
  saveSourceColumns,
  saveSourceView,
  shownSuggestions,
  type SourceColumn,
  type SourceView
} from "@/lib/sourceUsage";
import { cn } from "@/lib/utils";
import type {
  CurrentUser,
  KbCategory,
  KbDocumentListItem,
  SourceUsagePerson,
  SourceUsageResponse
} from "@/types/api";

interface AdminSourceUsagePageProps {
  user: CurrentUser;
}

/**
 * Source usage (/admin/sources, manager+): which sources answers cite, which
 * questions hit them, and who asks what. Managers use it for coaching
 * (one person's profile against the team) and curation (sources nobody
 * uses). Window and person live in the URL so a link to one person's view
 * can be shared.
 *
 * Wrapper + inner pattern matches AdminGapsPage: the role-gate early return
 * must not sit above hooks.
 */
export function AdminSourceUsagePage({ user }: AdminSourceUsagePageProps): JSX.Element {
  if (user.role === "csr") {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Forbidden</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Source usage is restricted to managers and above.
        </p>
      </div>
    );
  }
  return <AdminSourceUsageInner viewerId={user.id} />;
}

/** Everyone's numbers for one window, kept for the team comparison while a person is selected. */
interface TeamSnapshot extends TeamNumbers {
  key: string;
}

interface LibraryState {
  key: number;
  items: KbDocumentListItem[];
  categories: KbCategory[];
}

const NEVER_CITED_ID = "never-cited-sources";

/** Why the usage request failed: a person outside the program, or anything else. */
type FailureKind = "notFound" | "load";

/** Where the everyone view was when a person was opened, for "Back to everyone". */
interface ReturnPoint {
  scrollTop: number;
  /** The person was opened from a heatmap row header, not the By person table. */
  fromHeatmap: boolean;
}

/** Nearest ancestor that scrolls vertically (the app shell's main region). */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/** True when keyboard focus went nowhere (its element unmounted), so moving it steals nothing. */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

function AdminSourceUsageInner({ viewerId }: { viewerId: string }): JSX.Element {
  const search = useSearch();
  const [, navigate] = useLocation();
  const { days, userId } = useMemo(() => parseUsageQuery(search), [search]);

  const [reloadKey, setReloadKey] = useState(0);
  // Results and errors are keyed by the request that produced them, so a
  // window or person change never shows the previous filter's numbers.
  const requestKey = `${days}:${userId ?? ""}:${reloadKey}`;
  const [loaded, setLoaded] = useState<{ key: string; result: SourceUsageResponse } | null>(null);
  const [failure, setFailure] = useState<{ key: string; kind: FailureKind } | null>(null);
  const data = loaded?.key === requestKey ? loaded.result : null;
  const failureKind = failure?.key === requestKey ? failure.kind : null;
  const [team, setTeam] = useState<TeamSnapshot | null>(null);
  const [panel, setPanel] = useState<PanelSource | null>(null);
  const [library, setLibrary] = useState<LibraryState | null>(null);
  const [libraryError, setLibraryError] = useState<{ key: number; message: string } | null>(null);
  const [columns, setColumns] = useState<SourceColumn[]>(() => loadSourceColumns(viewerId));
  const [view, setView] = useState<SourceView>(() => loadSourceView(viewerId));
  const [moreOpen, setMoreOpen] = useState<boolean>(() => loadMoreDetailOpen(viewerId));
  // The roster from the last response, so the picker stays filled while the next one loads.
  const [roster, setRoster] = useState<SourceUsagePerson[]>([]);
  const rosterRef = useRef<SourceUsagePerson[]>([]);
  // Names seen in any response, so a selected person keeps a label while loading.
  const knownNames = useRef(new Map<string, string>());
  const rootRef = useRef<HTMLDivElement>(null);
  // Focus handoffs across the loading state between everyone and one person.
  const returnPoint = useRef<ReturnPoint | null>(null);
  const pendingFocus = useRef<"person" | "everyone" | null>(null);

  const go = useCallback(
    (next: { days?: number; userId?: string | null }, replace = false) => {
      navigate(
        buildUsageHref({
          days: next.days ?? days,
          userId: next.userId === undefined ? userId : next.userId
        }),
        { replace }
      );
    },
    [navigate, days, userId]
  );

  const teamKey = `${days}:${reloadKey}`;

  useEffect(() => {
    let cancelled = false;
    const needTeam = userId !== null && team?.key !== teamKey;
    void Promise.allSettled([
      fetchSourceUsage({ windowDays: days, userId }),
      needTeam ? fetchSourceUsage({ windowDays: days }) : Promise.resolve(null)
    ]).then(([outcome, everyoneOutcome]) => {
      if (cancelled) return;
      const everyone = everyoneOutcome.status === "fulfilled" ? everyoneOutcome.value : null;
      const keepRoster = (people: SourceUsagePerson[] | undefined): void => {
        if (!people) return;
        for (const person of people) knownNames.current.set(person.userId, person.name);
        rosterRef.current = people;
        setRoster(people);
      };
      keepRoster(everyone?.people);
      if (everyone && !everyone.noProgramSelected) {
        setTeam({ key: teamKey, users: everyone.users, totals: everyone.totals });
      }
      if (outcome.status === "rejected") {
        // A person missing from the program's roster is a stale or foreign
        // link, not an outage; the roster comes from the everyone request.
        const people = rosterRef.current;
        const missing =
          userId !== null && people.length > 0 && !people.some((p) => p.userId === userId);
        setFailure({ key: requestKey, kind: missing ? "notFound" : "load" });
        return;
      }
      const result = outcome.value;
      keepRoster(result.people);
      if (result.person) {
        knownNames.current.set(result.person.userId, personLabel(result.person));
      }
      setLoaded({ key: requestKey, result });
      if (userId === null && !result.noProgramSelected) {
        setTeam({ key: teamKey, users: result.users, totals: result.totals });
      }
    });
    return () => {
      cancelled = true;
    };
    // `team` is read only to skip a duplicate team request; reading it must
    // not trigger a refetch, so it stays out of the dependencies.
  }, [days, userId, requestKey, teamKey]);

  // The library supplies category paths and the never-cited list. One
  // request per program; sources the viewer cannot see are not in it.
  useEffect(() => {
    let cancelled = false;
    listKbDocuments()
      .then((result) => {
        if (!cancelled) {
          setLibrary({ key: reloadKey, items: result.items, categories: result.categories ?? [] });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLibraryError({
            key: reloadKey,
            message: err instanceof Error ? err.message : "Could not load the sources."
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // A super_user switching program (this tab or another) reloads the page
  // data. The person filter is cleared because people belong to one program.
  const lastProgram = useRef(getSelectedProgramIdRaw());
  useEffect(() => {
    function onProgramMaybeChanged(): void {
      const current = getSelectedProgramIdRaw();
      if (current === lastProgram.current) return;
      lastProgram.current = current;
      setPanel(null);
      setTeam(null);
      setRoster([]);
      rosterRef.current = [];
      returnPoint.current = null;
      knownNames.current.clear();
      setReloadKey((key) => key + 1);
      if (userId !== null) go({ userId: null }, true);
    }
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, onProgramMaybeChanged);
    window.addEventListener("storage", onProgramMaybeChanged);
    return () => {
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, onProgramMaybeChanged);
      window.removeEventListener("storage", onProgramMaybeChanged);
    };
  }, [go, userId]);

  const selectPerson = useCallback(
    (id: string | null) => {
      if (id === userId) return;
      if (id !== null && userId === null) {
        const active = document.activeElement;
        returnPoint.current = {
          scrollTop: scrollParent(rootRef.current)?.scrollTop ?? 0,
          fromHeatmap: active instanceof HTMLElement && active.dataset.hmPerson !== undefined
        };
      }
      pendingFocus.current = id === null ? "everyone" : "person";
      go({ userId: id });
    },
    [go, userId]
  );

  // The opener unmounts while the next view loads. Once it renders: a person
  // view focuses its heading; the everyone view returns to where the manager
  // left it and focuses that person's row. Focus that landed somewhere real
  // (the picker trigger, an open panel) is left alone.
  const lastPersonId = useRef<string | null>(null);
  if (userId !== null) lastPersonId.current = userId;
  useEffect(() => {
    if (!data || pendingFocus.current === null) return;
    const target = pendingFocus.current;
    if ((target === "person") !== (userId !== null)) return;
    pendingFocus.current = null;
    if (target === "person") {
      if (focusIsLost()) document.getElementById("person-focus-title")?.focus();
      return;
    }
    const personId = lastPersonId.current;
    const point = returnPoint.current;
    returnPoint.current = null;
    // One frame so the restored layout has its full height before scrolling.
    // Not cancelled on cleanup: StrictMode's second effect pass finds no
    // pending focus and must not undo the first.
    requestAnimationFrame(() => {
      const scroller = scrollParent(rootRef.current);
      if (scroller && point) scroller.scrollTop = point.scrollTop;
      if (!focusIsLost() || !personId) return;
      const id = CSS.escape(personId);
      const row =
        (point?.fromHeatmap
          ? document.querySelector<HTMLElement>(`[data-hm-person="${id}"]`)
          : null) ??
        document.querySelector<HTMLElement>(`[data-person-row="${id}"]`) ??
        document.querySelector<HTMLElement>(`[data-coach-person="${id}"]`) ??
        document.querySelector<HTMLElement>(`[data-coach-name="${id}"]`);
      if (row) {
        row.focus({ preventScroll: point !== null });
        if (!point) row.scrollIntoView({ block: "center" });
      } else {
        document.getElementById("source-usage-title")?.focus({ preventScroll: true });
      }
    });
  }, [data, userId]);

  const retry = useCallback(() => {
    (
      document.getElementById("source-usage-title") ??
      document.getElementById("person-focus-title")
    )?.focus({ preventScroll: true });
    setReloadKey((current) => current + 1);
  }, []);

  const changeView = useCallback(
    (next: SourceView) => {
      setView(next);
      saveSourceView(viewerId, next);
    },
    [viewerId]
  );

  const openSource = useCallback(
    (documentId: string, title: string | null) => {
      // Restricted sources are never openers; this guard keeps it that way.
      if (title === null) return;
      const ranked = data?.sources.find((source) => source.documentId === documentId);
      setPanel((current) => ({
        documentId,
        title: ranked ? ranked.title : title,
        isLive: ranked ? ranked.isLive : true,
        // A source opened from inside the drawer keeps the drawer's person.
        person: current?.person
      }));
    },
    [data]
  );

  const closePanel = useCallback(() => setPanel(null), []);

  /** One person's questions that cited one source: their view plus the source panel. */
  const openPersonSource = useCallback(
    (id: string, documentId: string, title: string | null) => {
      if (title === null) return;
      selectPerson(id);
      setPanel({ documentId, title, isLive: true });
    },
    [selectPerson]
  );

  /**
   * A heatmap cell: that person's questions for that source in the drawer,
   * while the page stays on the heatmap so closing returns to the cell.
   */
  const openCell = useCallback(
    (id: string, documentId: string, title: string | null) => {
      if (title === null) return;
      const ranked = data?.sources.find((source) => source.documentId === documentId);
      setPanel({
        documentId,
        title,
        isLive: ranked ? ranked.isLive : true,
        person: { userId: id, name: knownNames.current.get(id) ?? null }
      });
    },
    [data]
  );

  const changeColumns = useCallback(
    (next: SourceColumn[]) => {
      setColumns(next);
      saveSourceColumns(viewerId, next);
    },
    [viewerId]
  );

  const toggleMore = useCallback(() => {
    setMoreOpen((current) => {
      saveMoreDetailOpen(viewerId, !current);
      return !current;
    });
  }, [viewerId]);

  const showNeverCited = useCallback(() => {
    const heading = document.getElementById(`${NEVER_CITED_ID}-title`);
    heading?.scrollIntoView({ block: "center" });
    heading?.focus({ preventScroll: true });
  }, []);

  const currentLibrary = library?.key === reloadKey ? library : null;
  const currentLibraryError = libraryError?.key === reloadKey ? libraryError.message : null;
  const categoryPaths = useMemo(
    () => categoryPathsByDocument(currentLibrary?.categories ?? []),
    [currentLibrary]
  );
  const heatmap = useMemo(
    () =>
      data
        ? heatmapModel(
            data.matrix ?? { documentIds: [], rows: [] },
            data.sources,
            data.people ?? [],
            data.users
          )
        : null,
    [data]
  );

  const notFound = failureKind === "notFound";
  const pickerPeople = data?.people ?? roster;
  const selectedRow =
    userId === null ? null : data?.users.find((person) => person.userId === userId) ?? null;
  const selectedName =
    userId === null
      ? null
      : data?.person
        ? personLabel(data.person)
        : knownNames.current.get(userId) ?? null;
  const noProgramSelected = data?.noProgramSelected === true;
  const panelStats = panel
    ? data?.sources.find((source) => source.documentId === panel.documentId) ?? null
    : null;
  const teamNumbers = team?.key === teamKey ? team : null;
  // The heatmap and a table with several extra columns need the full width;
  // the Never cited card then moves below them.
  const wide = view === "heatmap" || columns.length > 1;
  const heatmapEmpty = !heatmap || heatmap.columns.length === 0 || heatmap.rows.length === 0;
  const attention = useMemo(() => {
    if (!data || userId !== null) return [];
    // The library (what this manager can see) names the unused sources. When
    // the cited list was capped it cannot prove a source unused, so the card
    // keeps the server count and links to the whole library, as it does
    // without the library.
    const unused = currentLibrary ? neverCitedDocuments(currentLibrary.items, data.sources) : null;
    return attentionCards({
      sources: data.sources,
      users: data.users,
      answered: data.totals.answered,
      neverUsed:
        unused && unused.complete
          ? { count: unused.items.length, documentIds: unused.items.map((doc) => doc.documentId) }
          : unused || currentLibraryError
            ? { count: data.totals.sourcesNeverCited, documentIds: [] }
            : null
    });
  }, [data, userId, currentLibrary, currentLibraryError]);

  const controls = (
    <>
      <TimeSelect days={days} onChange={(next) => go({ days: next }, true)} />
      <PersonPicker
        people={pickerPeople}
        selectedId={notFound ? null : userId}
        selectedLabel={selectedName}
        onSelect={selectPerson}
        triggerLabel={userId !== null ? "Change person" : undefined}
      />
    </>
  );

  const status = noProgramSelected ? (
    <div className="rounded-lg border border-dashed border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
      Choose a program to see how its sources are used.
    </div>
  ) : notFound ? (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
      <span>This person isn't in this program or no longer has an account.</span>
      <button
        type="button"
        onClick={() => selectPerson(null)}
        className="btn-whisper px-3 py-1 text-xs"
      >
        Show everyone
      </button>
    </div>
  ) : failureKind === "load" ? (
    <ErrorAlert message="Source usage didn't load.">
      <span className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={retry}
          className="rounded-full border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive transition-colors duration-100 ease-out hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Try again
        </button>
        {userId !== null ? (
          <button
            type="button"
            onClick={() => selectPerson(null)}
            className="btn-whisper px-3 py-1 text-xs"
          >
            Show everyone
          </button>
        ) : null}
      </span>
    </ErrorAlert>
  ) : !data ? (
    <LoadingSkeleton />
  ) : null;

  // A person view that has its data renders its own header (with the copy action).
  const personReady = userId !== null && status === null && data !== null;

  return (
    <div ref={rootRef} className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      {userId !== null && !noProgramSelected && !notFound ? (
        personReady ? null : (
          <PersonHeader
            name={selectedName ?? "Selected person"}
            role={data?.person ? roleLabel(data.person.role) : null}
            controls={controls}
            onBack={() => selectPerson(null)}
          />
        )
      ) : (
        <header className="flex flex-col gap-4">
          {/* The sidebar already says where you are; the heading stays for
              screen readers and as the focus target when leaving a person. */}
          <h1 id="source-usage-title" tabIndex={-1} className="sr-only">
            Source usage
          </h1>
          {noProgramSelected ? null : (
            <div className="flex flex-wrap items-center gap-3">{controls}</div>
          )}
        </header>
      )}

      {status !== null || !data ? (
        status
      ) : userId !== null ? (
        <PersonFocus
          key={userId}
          userId={userId}
          identity={data.person}
          name={selectedName ?? "Selected person"}
          row={selectedRow}
          totals={data.totals}
          sources={data.sources}
          suggestions={shownSuggestions(data.suggestions ?? [])}
          team={teamNumbers}
          categoryPaths={categoryPaths}
          days={days}
          reloadKey={reloadKey}
          controls={controls}
          onClear={() => selectPerson(null)}
          onOpenSource={openSource}
          onWiderWindow={days < 90 ? () => go({ days: 90 }, true) : null}
        />
      ) : data.totals.questions === 0 ? (
        <EmptyState
          icon={BarChart3}
          title={`No questions in the last ${days} days`}
          hint="Usage appears after people ask questions in Ask."
        >
          {days < 90 ? (
            <button
              type="button"
              onClick={() => go({ days: 90 }, true)}
              className="btn-whisper px-3 py-1 text-xs"
            >
              Show the last 90 days
            </button>
          ) : null}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-8">
          <AtAGlance totals={data.totals} days={days} />
          <AttentionCards
            cards={attention}
            days={days}
            onSelectPerson={(id) => selectPerson(id)}
          />
          <MostUsedList
            sources={data.sources}
            days={days}
            activeDocumentId={panel?.documentId ?? null}
            onOpen={openSource}
          />

          <section aria-labelledby="more-detail-title" className="flex flex-col gap-6 border-t border-border pt-6">
            <div>
              <h2 id="more-detail-title" className="text-xl font-semibold tracking-tight">
                <button
                  type="button"
                  aria-expanded={moreOpen}
                  aria-controls="more-detail-body"
                  onClick={toggleMore}
                  className="inline-flex items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  More detail
                  <ChevronDown
                    className={cn(
                      "h-5 w-5 text-muted-foreground transition-transform duration-100 ease-out motion-reduce:transition-none",
                      moreOpen && "rotate-180"
                    )}
                    aria-hidden
                  />
                </button>
              </h2>
            </div>

            {moreOpen ? (
              <div id="more-detail-body" className="flex flex-col gap-6">
                <UsageKpis totals={data.totals} days={days} onShowNeverCited={showNeverCited} />
                <UsageHighlights
                  sources={data.sources}
                  users={data.users}
                  answered={data.totals.answered}
                  onOpenSource={openSource}
                  onSelectPerson={(id) => selectPerson(id)}
                />

                <div
                  className={cn(
                    "grid items-start gap-6",
                    !wide && "lg:grid-cols-[minmax(0,1fr)_17rem]"
                  )}
                >
                  <section aria-labelledby="most-cited-title" className="flex min-w-0 flex-col gap-3">
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h3
                          id="most-cited-title"
                          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
                        >
                          {view === "heatmap" ? "Answers by person and source" : "All sources"}
                        </h3>
                        <div className="flex flex-wrap items-center gap-2">
                          <SourcesViewSwitch view={view} onChange={changeView} />
                          {view === "table" ? (
                            <ColumnsMenu columns={columns} onChange={changeColumns} />
                          ) : null}
                        </div>
                      </div>
                      {view === "heatmap" ? (
                        <p id="heatmap-help" className="mt-1 text-sm text-muted-foreground">
                          Answers from each person that cited each of the{" "}
                          {plural(
                            heatmap?.columns.length ?? 0,
                            "most-cited source",
                            "most-cited sources"
                          )}
                          . Select a name for their coaching guide, a source for its questions, or a
                          cell for that person's questions about that source.
                        </p>
                      ) : (
                        <p className="mt-1 text-sm text-muted-foreground">
                          A citation is an answer that quoted the source. Select a source to read
                          the questions behind it.
                        </p>
                      )}
                    </div>
                    {data.sources.length === 0 || (view === "heatmap" && heatmapEmpty) ? (
                      <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                        No answer cited a source in this window. Every question was refused.
                      </p>
                    ) : view === "heatmap" && heatmap ? (
                      <SourceHeatmap
                        model={heatmap}
                        onSelectPerson={(id) => selectPerson(id)}
                        onOpenSource={openSource}
                        onOpenCell={openCell}
                      />
                    ) : (
                      <SourcesTable
                        sources={data.sources}
                        columns={columns}
                        activeDocumentId={panel?.documentId ?? null}
                        onOpen={openSource}
                      />
                    )}
                  </section>

                  <NeverCitedList
                    id={NEVER_CITED_ID}
                    days={days}
                    cited={data.sources}
                    library={currentLibrary?.items ?? null}
                    libraryError={currentLibraryError}
                    categoryPaths={categoryPaths}
                    wide={wide}
                  />
                </div>

                <section aria-labelledby="by-person-title" className="flex flex-col gap-3">
                  <div>
                    <h3
                      id="by-person-title"
                      className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      By person
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Select a name for that person's coaching guide: their numbers against the
                      team, the sources they rely on, and their questions.
                    </p>
                  </div>
                  <PeopleTable
                    users={data.users}
                    onSelectPerson={(id) => selectPerson(id)}
                    onOpenPersonSource={openPersonSource}
                  />
                </section>
              </div>
            ) : null}
          </section>
        </div>
      )}

      {panel && !noProgramSelected ? (
        <SourceQuestionsPanel
          source={panel}
          stats={panelStats}
          categoryPath={formatCategoryPaths(categoryPaths.get(panel.documentId))}
          days={days}
          userId={userId}
          personName={selectedName}
          reloadKey={reloadKey}
          onClose={closePanel}
          onSelectPerson={selectPerson}
          onOpenSource={openSource}
        />
      ) : null}
    </div>
  );
}

function LoadingSkeleton(): JSX.Element {
  return (
    <div role="status" className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton h-24 rounded-lg" />
        ))}
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-4 border-t border-border px-3 py-3 first:border-t-0"
          >
            <div className="flex w-full max-w-sm flex-col gap-2">
              <div className="skeleton h-4 w-3/4" />
              <div className="skeleton h-1.5 w-full rounded-full" />
            </div>
            <div className="skeleton h-4 w-10" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading source usage…</span>
    </div>
  );
}
