import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { BookOpen, FolderCog, Info, Plus, Search, Tags, X } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import {
  EMPTY_FILTERS,
  KB_NUMBERED_PINS,
  buildLookup,
  docMatchesQuery,
  docPassesFilters,
  filtersActive,
  groupedRowCount,
  loadPrefs,
  myPins,
  recentlyOpened,
  savePrefs,
  sortForView,
  sortTags,
  teamPins,
  type KbFilters,
  type KbPrefs
} from "@/lib/kbLibrary";
import { KB_LIBRARY_COLORS } from "@/lib/kbLibraryColors";
import type { CurrentUser, KbDocumentListResponse } from "@/types/api";
import { KbCategoriesView, KbFoldersView, KbListView } from "./KbBrowseViews";
import { KbLibraryContext, type KbDialogState, type KbLibraryContextValue } from "./KbContext";
import { KbDialogs } from "./KbDialogs";
import { KbOrganizeTree } from "./KbOrganizeTree";
import { KbPinStrips, KbPinsDock, KbTeamPinsEditor } from "./KbPinStrips";
import { KbToolbar } from "./KbToolbar";
import { useKbLibrary } from "./useKbLibrary";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/**
 * The Sources library: search, view and filter controls, the pinned strips,
 * and the browse views. Managers get an Organize mode that swaps the browse
 * controls for drag-and-drop arrangement, so arranging never mixes with
 * looking things up. View, sort, filters and collapsed folders persist per
 * user in localStorage. Personal colors live on the server, not here.
 */
export function KbLibrary({
  user,
  initial
}: {
  user: CurrentUser;
  initial: KbDocumentListResponse;
}): JSX.Element {
  const { data, actionError, clearActionError, announcement, actions } = useKbLibrary(initial);
  const [prefs, setPrefs] = useState<KbPrefs>(() => loadPrefs(user.id));
  const [query, setQuery] = useState("");
  const [organizing, setOrganizing] = useState(false);
  const [dialog, setDialog] = useState<KbDialogState | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const organizeHeadingRef = useRef<HTMLHeadingElement>(null);
  const myPinsRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  const [, navigate] = useLocation();
  const [pinsInView, setPinsInView] = useState(true);

  useEffect(() => {
    savePrefs(user.id, prefs);
  }, [user.id, prefs]);


  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (organizing) organizeHeadingRef.current?.focus();
    else searchRef.current?.focus();
  }, [organizing]);

  const lookup = useMemo(
    () => buildLookup({ categories: data.categories, tags: data.tags }),
    [data.categories, data.tags]
  );
  const canOrganize = data.canOrganize;

  // Drop stored tag filters for tags that no longer exist.
  const filters: KbFilters = useMemo(
    () => ({ ...prefs.filters, tagIds: prefs.filters.tagIds.filter((id) => lookup.tagsById.has(id)) }),
    [prefs.filters, lookup]
  );
  const active = filtersActive(filters, query);
  const sort = sortForView(prefs, prefs.view);
  const visible = useMemo(
    () => data.items.filter((d) => docPassesFilters(d, filters) && docMatchesQuery(d, query, lookup)),
    [data.items, filters, query, lookup]
  );
  const collapsed = useMemo(() => new Set(prefs.collapsed), [prefs.collapsed]);
  const team = useMemo(() => teamPins(data.items), [data.items]);
  const mine = useMemo(() => myPins(data.items), [data.items]);
  const recent = useMemo(() => recentlyOpened(data.items), [data.items]);
  const grouped = useMemo(() => groupedRowCount(visible, lookup.tree), [visible, lookup.tree]);
  const showStrips = !organizing && !active && data.items.length > 0;

  // "/" jumps to search from anywhere on the page, the same shortcut as /chat.
  // 1 to 9 open that numbered pin, unless focus is in a field or a menu is open.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || organizing || dialog) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (!/^[1-9]$/.test(event.key) || document.querySelector("[role=\"menu\"]")) return;
      const pin = mine[Number(event.key) - 1];
      if (!pin || Number(event.key) > KB_NUMBERED_PINS) return;
      event.preventDefault();
      navigate(`/kb/${pin.documentId}`);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [organizing, dialog, mine, navigate]);

  // The pins dock appears once the My pins strip has scrolled out of view.
  useEffect(() => {
    const el = myPinsRef.current;
    if (!showStrips || !el) {
      setPinsInView(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setPinsInView(Boolean(entry?.isIntersecting)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [showStrips, mine.length > 0]);
  const showDock = !organizing && mine.length > 0 && !pinsInView;
  const tags = useMemo(() => sortTags(data.tags), [data.tags]);
  // Offer only colors in use; a selected color stays listed so it can be cleared.
  const colors = useMemo(
    () =>
      KB_LIBRARY_COLORS.filter(
        (c) => filters.colors.includes(c) || data.items.some((d) => d.myColor === c)
      ),
    [data.items, filters.colors]
  );

  const context = useMemo<KbLibraryContextValue>(
    () => ({ data, lookup, actions, canOrganize, openDialog: setDialog }),
    [data, lookup, actions, canOrganize]
  );

  function toggleCollapsed(key: string): void {
    setPrefs((p) => ({
      ...p,
      collapsed: p.collapsed.includes(key) ? p.collapsed.filter((k) => k !== key) : [...p.collapsed, key]
    }));
  }

  function reset(): void {
    setQuery("");
    setPrefs((p) => ({ ...p, filters: EMPTY_FILTERS }));
  }

  return (
    <KbLibraryContext.Provider value={context}>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {organizing ? (
        <div data-kb-organize-bar className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2
              ref={organizeHeadingRef}
              tabIndex={-1}
              className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/5 px-3 py-1 text-sm font-medium text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <FolderCog className="h-4 w-4" aria-hidden />
              Organize mode
            </h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setDialog({ kind: "category-create", parentId: null })}
                className="btn-whisper gap-1.5 px-3 py-1.5 text-sm"
              >
                <Plus className="h-4 w-4" aria-hidden />
                New category
              </button>
              <button
                type="button"
                onClick={() => setDialog({ kind: "manage-tags" })}
                className="btn-whisper gap-1.5 px-3 py-1.5 text-sm"
              >
                <Tags className="h-4 w-4" aria-hidden />
                Manage tags
              </button>
              <button type="button" onClick={() => setOrganizing(false)} className="btn-primary px-4 py-1.5 text-sm">
                Done organizing
              </button>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <p className="min-w-0">
              <span className="font-medium text-foreground">Drag to move. Changes save automatically.</span>{" "}
              <span className="text-muted-foreground">
                Everyone in this program sees categories, sources and team pins in this order. Each item&apos;s menu
                has the same moves. Search and filters are paused until you finish.
              </span>
            </p>
          </div>
        </div>
      ) : data.items.length > 0 ? (
        <KbToolbar
          query={query}
          onQuery={setQuery}
          view={prefs.view}
          onView={(view) => setPrefs((p) => ({ ...p, view }))}
          sort={sort}
          onSort={(next) => setPrefs((p) => ({ ...p, sortByView: { ...p.sortByView, [p.view]: next } }))}
          filters={filters}
          onFilters={(next) => setPrefs((p) => ({ ...p, filters: next }))}
          tags={tags}
          colors={colors}
          shown={visible.length}
          total={data.items.length}
          repeated={prefs.view === "list" || lookup.tree.roots.length === 0 ? 0 : grouped.repeated}
          repeatedMax={grouped.maxRows}
          active={active}
          onReset={reset}
          canOrganize={canOrganize}
          onOrganize={() => setOrganizing(true)}
          searchRef={searchRef}
        />
      ) : null}

      {actionError ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>{actionError}</span>
          <button
            type="button"
            onClick={clearActionError}
            aria-label="Dismiss"
            className="btn-icon -my-0.5 h-6 w-6 shrink-0 text-destructive hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      {organizing ? (
        <>
          <KbTeamPinsEditor team={team} />
          <KbOrganizeTree collapsed={collapsed} onToggle={toggleCollapsed} />
        </>
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No source documents yet"
          hint={
            canOrganize
              ? "Upload documents under Documents. Once processed, they show up here for everyone in the program."
              : "When your team adds documents, they show up here."
          }
        />
      ) : (
        <>
          {showStrips ? <KbPinStrips
              ref={myPinsRef}
              team={team}
              mine={mine}
              recent={recent}
              collapsed={prefs.quickCollapsed}
              onToggleCollapsed={() => setPrefs((p) => ({ ...p, quickCollapsed: !p.quickCollapsed }))}
            /> : null}
          {visible.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No sources match"
              hint={
                query.trim()
                  ? `Nothing matches "${query.trim()}" with the current filters.`
                  : "No sources match the current filters."
              }
            >
              <button type="button" onClick={reset} className="btn-whisper px-3 py-1.5 text-sm">
                Clear search and filters
              </button>
            </EmptyState>
          ) : prefs.view === "folders" ? (
            <KbFoldersView
              visible={visible}
              sort={sort}
              filtering={active}
              searching={query.trim() !== ""}
              collapsed={collapsed}
              onToggle={toggleCollapsed}
            />
          ) : prefs.view === "categories" ? (
            <KbCategoriesView visible={visible} sort={sort} filtering={active} searching={query.trim() !== ""} />
          ) : (
            <KbListView visible={visible} sort={sort} filtering={active} searching={query.trim() !== ""} />
          )}
        </>
      )}

      {!organizing && mine.length > 0 ? <KbPinsDock mine={mine} shown={showDock} /> : null}

      <KbDialogs dialog={dialog} onClose={() => setDialog(null)} onReturn={setDialog} />
    </KbLibraryContext.Provider>
  );
}
