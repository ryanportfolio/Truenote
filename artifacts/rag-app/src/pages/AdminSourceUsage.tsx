import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { BarChart3 } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ColumnsMenu } from "@/components/admin/source-usage/ColumnsMenu";
import { NeverCitedList } from "@/components/admin/source-usage/NeverCitedList";
import { PeopleTable } from "@/components/admin/source-usage/PeopleTable";
import { PersonFocus, type TeamNumbers } from "@/components/admin/source-usage/PersonFocus";
import { PersonPicker } from "@/components/admin/source-usage/PersonPicker";
import {
  SourceQuestionsPanel,
  type PanelSource
} from "@/components/admin/source-usage/SourceQuestionsPanel";
import { SourcesTable } from "@/components/admin/source-usage/SourcesTable";
import { UsageHighlights } from "@/components/admin/source-usage/UsageHighlights";
import { UsageKpis } from "@/components/admin/source-usage/UsageKpis";
import { ErrorAlert } from "@/components/admin/source-usage/shared";
import { fetchSourceUsage, listKbDocuments } from "@/lib/api";
import {
  SELECTED_PROGRAM_CHANGED_EVENT,
  getSelectedProgramIdRaw
} from "@/lib/selectedProgram";
import {
  USAGE_WINDOW_OPTIONS,
  buildUsageHref,
  categoryPathsByDocument,
  formatCategoryPaths,
  loadSourceColumns,
  parseUsageQuery,
  personLabel,
  saveSourceColumns,
  type SourceColumn
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

function AdminSourceUsageInner({ viewerId }: { viewerId: string }): JSX.Element {
  const search = useSearch();
  const [, navigate] = useLocation();
  const { days, userId } = useMemo(() => parseUsageQuery(search), [search]);

  const [reloadKey, setReloadKey] = useState(0);
  // Results and errors are keyed by the request that produced them, so a
  // window or person change never shows the previous filter's numbers.
  const requestKey = `${days}:${userId ?? ""}:${reloadKey}`;
  const [loaded, setLoaded] = useState<{ key: string; result: SourceUsageResponse } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const data = loaded?.key === requestKey ? loaded.result : null;
  const error = failure?.key === requestKey ? failure.message : null;
  const [team, setTeam] = useState<TeamSnapshot | null>(null);
  const [panel, setPanel] = useState<PanelSource | null>(null);
  const [library, setLibrary] = useState<LibraryState | null>(null);
  const [libraryError, setLibraryError] = useState<{ key: number; message: string } | null>(null);
  const [columns, setColumns] = useState<SourceColumn[]>(() => loadSourceColumns(viewerId));
  // The roster from the last response, so the picker stays filled while the next one loads.
  const [roster, setRoster] = useState<SourceUsagePerson[]>([]);
  // Names seen in any response, so a selected person keeps a label while loading.
  const knownNames = useRef(new Map<string, string>());

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
    Promise.all([
      fetchSourceUsage({ windowDays: days, userId }),
      needTeam ? fetchSourceUsage({ windowDays: days }) : Promise.resolve(null)
    ])
      .then(([result, everyone]) => {
        if (cancelled) return;
        for (const person of result.people ?? []) {
          knownNames.current.set(person.userId, person.name);
        }
        if (result.person) {
          knownNames.current.set(result.person.userId, personLabel(result.person));
        }
        setLoaded({ key: requestKey, result });
        if (result.people) setRoster(result.people);
        const snapshot = userId === null ? result : everyone;
        if (snapshot && !snapshot.noProgramSelected) {
          setTeam({ key: teamKey, users: snapshot.users, totals: snapshot.totals });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setFailure({
            key: requestKey,
            message: err instanceof Error ? err.message : "Could not load source usage."
          });
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
      if (id !== userId) go({ userId: id });
    },
    [go, userId]
  );

  const openSource = useCallback(
    (documentId: string, title: string | null) => {
      // Restricted sources are never openers; this guard keeps it that way.
      if (title === null) return;
      const ranked = data?.sources.find((source) => source.documentId === documentId);
      setPanel({
        documentId,
        title: ranked ? ranked.title : title,
        isLive: ranked ? ranked.isLive : true
      });
    },
    [data]
  );

  const closePanel = useCallback(() => setPanel(null), []);

  const changeColumns = useCallback(
    (next: SourceColumn[]) => {
      setColumns(next);
      saveSourceColumns(viewerId, next);
    },
    [viewerId]
  );

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

  const pickerPeople = data?.people ?? roster;
  const selectedRow =
    userId === null ? null : data?.users.find((person) => person.userId === userId) ?? null;
  const selectedName =
    userId === null
      ? null
      : data?.person
        ? personLabel(data.person)
        : knownNames.current.get(userId) ?? "This person";
  const noProgramSelected = data?.noProgramSelected === true;
  const panelStats = panel
    ? data?.sources.find((source) => source.documentId === panel.documentId) ?? null
    : null;
  const teamNumbers = team?.key === teamKey ? team : null;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-4">
        <div>
          <h1
            id="source-usage-title"
            tabIndex={-1}
            className="rounded-sm font-display text-3xl font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Source usage
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Which sources answer your team's questions, and who relies on them. Pick a person to
            coach from their exact questions; open a source to see what people asked.
          </p>
        </div>
        {noProgramSelected ? null : (
          <div className="flex flex-wrap items-center gap-3">
            <div
              role="group"
              aria-label="Time window"
              className="flex overflow-hidden rounded-lg border border-border"
            >
              {USAGE_WINDOW_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={days === option}
                  onClick={() => go({ days: option }, true)}
                  className={cn(
                    "relative whitespace-nowrap px-3 py-1.5 text-xs font-medium transition-colors duration-100",
                    days === option
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {/* Phones drop the visible "Last" so all three fit; the name stays "Last N days". */}
                  <span className="sr-only sm:not-sr-only">Last </span>
                  {option} days
                </button>
              ))}
            </div>
            <PersonPicker
              people={pickerPeople}
              selectedId={userId}
              selectedLabel={selectedName}
              onSelect={selectPerson}
            />
          </div>
        )}
      </header>

      {noProgramSelected ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Choose a program to see how its sources are used.
        </div>
      ) : error ? (
        <ErrorAlert message={error}>
          {userId !== null ? (
            <button
              type="button"
              onClick={() => selectPerson(null)}
              className="btn-whisper px-3 py-1 text-xs"
            >
              Show everyone
            </button>
          ) : null}
        </ErrorAlert>
      ) : !data ? (
        <LoadingSkeleton />
      ) : userId !== null ? (
        <PersonFocus
          key={userId}
          userId={userId}
          identity={data.person}
          name={selectedName ?? "Selected person"}
          row={selectedRow}
          totals={data.totals}
          sources={data.sources}
          team={teamNumbers}
          categoryPaths={categoryPaths}
          days={days}
          reloadKey={reloadKey}
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
        <div className="flex flex-col gap-6">
          <UsageKpis totals={data.totals} days={days} onShowNeverCited={showNeverCited} />
          <UsageHighlights
            sources={data.sources}
            users={data.users}
            answered={data.totals.answered}
            onOpenSource={openSource}
            onSelectPerson={(id) => selectPerson(id)}
          />

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
            <section aria-labelledby="most-cited-title" className="flex min-w-0 flex-col gap-3">
              <div>
                <div className="flex items-center justify-between gap-3">
                  <h2
                    id="most-cited-title"
                    className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Most-cited sources
                  </h2>
                  <ColumnsMenu columns={columns} onChange={changeColumns} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  A citation is an answer that quoted the source. Select a source to read the
                  questions behind it.
                </p>
              </div>
              {data.sources.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                  No answer cited a source in this window. Every question was refused.
                </p>
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
            />
          </div>

          <section aria-labelledby="by-person-title" className="flex flex-col gap-3">
            <div>
              <h2
                id="by-person-title"
                className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
              >
                By person
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Select a name for that person's coaching view: their numbers against the team,
                the sources they rely on, and their questions.
              </p>
            </div>
            <PeopleTable
              users={data.users}
              onSelectPerson={(id) => selectPerson(id)}
              onOpenPersonSource={(id, documentId, title) => {
                if (title === null) return;
                selectPerson(id);
                setPanel({ documentId, title, isLive: true });
              }}
            />
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
