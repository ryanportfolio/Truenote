import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useLocation, useSearch } from "wouter";
import { BookOpen, FolderClosed, FolderCog, Link2, List, ListTree, Search, X } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import {
  EMPTY_FILTERS,
  KB_VIEWS,
  KB_VIEW_LABELS,
  buildLookup,
  defaultSort,
  docMatchesQuery,
  docPassesFilters,
  filterSentence,
  filtersActive,
  folderFromSearch,
  idsFromSearch,
  loadPrefs,
  savePrefs,
  searchLibrary,
  shortcutShelf,
  sortForView,
  sortTags,
  usedOftenIds,
  type KbFilters,
  type KbPrefs,
  type KbTab,
  type KbView
} from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import type { CurrentUser, KbDocumentListResponse, KbLibraryColor } from "@/types/api";
import { KbFoldersView, KbListView, KbMyShortcuts, KbOutlineView, folderHref, myShortcutGroups } from "./KbBrowseViews";
import { KbLibraryContext, type KbDialogState, type KbLibraryContextValue } from "./KbContext";
import { KbDialogs } from "./KbDialogs";
import { KbFilterSentence, KbFiltersButton } from "./KbFilters";
import { KbLabels } from "./KbLabels";
import { KbOrganize } from "./KbOrganize";
import { AskTruenoteLink, KbSearch } from "./KbSearch";
import { KbShortcutDock, KbShortcutShelf } from "./KbShelf";
import { useKbLibrary } from "./useKbLibrary";
import { KB_LABELS_QUERY, KB_WIDE_QUERY, useMediaQuery } from "./useMediaQuery";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

const TABS: Array<{ id: KbTab; label: string }> = [
  { id: "all", label: "All sources" },
  { id: "shortcuts", label: "My shortcuts" }
];

const VIEW_ICONS: Record<KbView, typeof List> = { folders: FolderClosed, outline: ListTree, list: List };
const VIEW_DETAILS: Record<KbView, string> = {
  folders: "Folder cards",
  outline: "Nested folders",
  list: "One list"
};

/**
 * The Sources library: the shortcuts shelf, the search box with its results
 * panel and Filters, the All sources / My shortcuts tabs with the View menu
 * (Folders, Outline, List), and the browse views. Managers get Organize,
 * which swaps all of that for a two-step editor so arranging never mixes
 * with looking things up. View, tab, sort, filters and collapsed folders
 * persist per user in localStorage; the open folder lives in the URL
 * (`?folder=<id>`); labels, notes and shortcuts live on the server.
 */
export function KbLibrary({
  user,
  initial,
  cacheKey
}: {
  user: CurrentUser;
  initial: KbDocumentListResponse;
  /** Shared library cache slot (lib/kbLibraryCache) this page writes its changes to. */
  cacheKey: string;
}): JSX.Element {
  const { data, actionError, clearActionError, announcement, actions } = useKbLibrary(initial, cacheKey);
  const [prefs, setPrefs] = useState<KbPrefs>(() => loadPrefs(user.id));
  // The search lives in the URL (`?q=`), so browser back to /kb brings back the text and its results.
  const [query, setQueryState] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const [organizing, setOrganizing] = useState(false);
  const [dialog, setDialog] = useState<KbDialogState | null>(null);
  const [lastMoved, setLastMoved] = useState<{ key: string; at: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const shelfRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const organizeButtonRef = useRef<HTMLButtonElement>(null);
  // The organizing value focus last followed; StrictMode's double effect run sees no change.
  const focusedForOrganizing = useRef(organizing);
  const [, navigate] = useLocation();
  const search = useSearch();
  const [shelfInView, setShelfInView] = useState(true);
  const wide = useMediaQuery(KB_WIDE_QUERY);
  const labelsBeside = useMediaQuery(KB_LABELS_QUERY);
  const tabsId = useId();

  // Typing replaces the history entry (one entry per search, not per key);
  // a `?q=` that changes some other way (back, forward) updates the box.
  const urlQuery = new URLSearchParams(search).get("q") ?? "";
  const writtenQuery = useRef(urlQuery);
  useEffect(() => {
    if (urlQuery === writtenQuery.current) return;
    writtenQuery.current = urlQuery;
    setQueryState(urlQuery);
  }, [urlQuery]);

  const setQuery = useCallback(
    (next: string, params = new URLSearchParams(window.location.search)) => {
      setQueryState(next);
      if (next.trim()) params.set("q", next);
      else params.delete("q");
      writtenQuery.current = params.get("q") ?? "";
      const qs = params.toString();
      navigate(qs ? `/kb?${qs}` : "/kb", { replace: true });
    },
    [navigate]
  );

  useEffect(() => {
    savePrefs(user.id, prefs);
  }, [user.id, prefs]);

  // Leaving Organize puts focus back on its button. Nothing is focused on
  // load, so the number keys open shortcuts right away.
  useEffect(() => {
    if (focusedForOrganizing.current === organizing) return;
    focusedForOrganizing.current = organizing;
    if (!organizing) requestAnimationFrame(() => organizeButtonRef.current?.focus());
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

  // "/kb?ids=a,b&from=usage": only these sources. Unknown or hidden ids are ignored.
  const linked = useMemo(() => {
    const ids = idsFromSearch(search);
    if (!ids) return null;
    const known = new Set(data.items.map((d) => d.documentId));
    const kept = new Set(ids.filter((id) => known.has(id)));
    if (kept.size === 0) return null;
    const params = new URLSearchParams(search);
    // Source usage passes its time window (`&days=7`) with its never-used sources.
    const days = Number(params.get("days"));
    return {
      ids: kept,
      fromUsage: params.get("from") === "usage",
      days: Number.isInteger(days) && days > 0 ? days : null
    };
  }, [search, data.items]);

  const active = filtersActive(filters, query);
  const sort = sortForView(prefs, prefs.view);
  const visible = useMemo(
    () =>
      data.items.filter(
        (d) =>
          (!linked || linked.ids.has(d.documentId)) && docPassesFilters(d, filters) && docMatchesQuery(d, query, lookup)
      ),
    [data.items, filters, query, lookup, linked]
  );
  const collapsed = useMemo(() => new Set(prefs.collapsed), [prefs.collapsed]);
  const shelf = useMemo(() => shortcutShelf(data.items), [data.items]);
  const results = useMemo(() => searchLibrary(visible, query, lookup), [visible, query, lookup]);
  const tags = useMemo(() => sortTags(data.tags), [data.tags]);
  const scope = prefs.tab === "all" && prefs.view === "folders" ? folderFromSearch(search, lookup.tree) : null;
  const shortcutGroups = myShortcutGroups(visible);
  const shownCount = prefs.tab === "shortcuts" ? shortcutGroups.team.length + shortcutGroups.mine.length : visible.length;
  const sentence = filterSentence({ shown: shownCount, query, filters, tagsById: lookup.tagsById, labels: data.labels });
  // A sort other than the view's own is named beside the filters, with Reset.
  const sortChanged = prefs.tab === "all" && sort !== defaultSort(prefs.view);
  // A Source usage link (?ids=) narrows the list like a filter does.
  const narrowed = active || linked !== null;

  // Opening or leaving a folder moves focus to what replaced the link that was used.
  const lastScope = useRef(scope);
  useEffect(() => {
    const before = lastScope.current;
    lastScope.current = scope;
    if (before === scope) return;
    requestAnimationFrame(() => {
      if (scope !== null) {
        document.querySelector<HTMLElement>("[data-kb-folder-title]")?.focus({ preventScroll: false });
      } else if (before !== null) {
        document.querySelector<HTMLElement>(`[data-kb-folder-card="${CSS.escape(before)}"] a`)?.focus();
      }
    });
  }, [scope]);

  // "/" jumps to search from anywhere on the page, the same shortcut as /chat.
  // 1 to 9 open that shortcut, unless focus is in a field or a menu or dialog is open.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || organizing || dialog) return;
      if (event.key !== "/" && !/^[1-9]$/.test(event.key)) return;
      // An open menu or panel keeps the keys, so focus never leaves it behind.
      if (document.querySelector('[role="menu"], [role="dialog"]')) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      const shortcut = shelf[Number(event.key) - 1];
      if (!shortcut) return;
      event.preventDefault();
      navigate(`/kb/${shortcut.doc.documentId}`);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [organizing, dialog, shelf, navigate]);

  // The dock appears once the shelf has scrolled out of view.
  const showShelf = !organizing && data.items.length > 0;
  useEffect(() => {
    const el = shelfRef.current;
    if (!showShelf || !el) {
      setShelfInView(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setShelfInView(Boolean(entry?.isIntersecting)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [showShelf]);
  const showDock = showShelf && shelf.length > 0 && !shelfInView;

  const markMoved = useCallback((key: string) => setLastMoved({ key, at: Date.now() }), []);
  // Over the whole library, not the filtered list, so a short list does not mark every row.
  const usedOften = useMemo(() => usedOftenIds(data.items), [data.items]);
  const context = useMemo<KbLibraryContextValue>(
    () => ({ data, lookup, actions, canOrganize, openDialog: setDialog, markMoved, usedOften }),
    [data, lookup, actions, canOrganize, markMoved, usedOften]
  );

  function toggleCollapsed(key: string): void {
    setPrefs((p) => ({
      ...p,
      collapsed: p.collapsed.includes(key) ? p.collapsed.filter((k) => k !== key) : [...p.collapsed, key]
    }));
  }

  function setFilters(next: KbFilters): void {
    setPrefs((p) => ({ ...p, filters: next }));
  }

  function toggleLabel(color: KbLibraryColor): void {
    setFilters({
      ...filters,
      colors: filters.colors.includes(color) ? filters.colors.filter((c) => c !== color) : [...filters.colors, color]
    });
  }

  function clearLinked(): void {
    // Keeps the search (`?q=`); drops the Source usage link and any open folder.
    const params = new URLSearchParams();
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) params.set("q", q);
    const qs = params.toString();
    navigate(qs ? `/kb?${qs}` : "/kb", { replace: true });
  }

  function clearFilters(): void {
    setQuery("");
    setPrefs((p) => ({ ...p, filters: EMPTY_FILTERS }));
  }

  function reset(): void {
    setPrefs((p) => ({ ...p, filters: EMPTY_FILTERS }));
    // One URL change: no search, no Source usage link.
    const params = new URLSearchParams(window.location.search);
    if (linked) {
      params.delete("ids");
      params.delete("from");
      params.delete("days");
      params.delete("folder");
    }
    setQuery("", params);
  }

  function setTab(tab: KbTab, focus = false): void {
    setPrefs((p) => ({ ...p, tab }));
    if (focus) requestAnimationFrame(() => document.getElementById(`${tabsId}-${tab}`)?.focus());
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = TABS.findIndex((t) => t.id === prefs.tab);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    setTab(TABS[next]!.id, true);
  }

  function openFolder(folderId: string): void {
    setPrefs((p) => ({ ...p, tab: "all", view: "folders" }));
    // Leave the search on the current history entry, so back returns to it, then open the folder.
    setQueryState("");
    const params = new URLSearchParams(search);
    params.delete("q");
    writtenQuery.current = "";
    navigate(folderHref(params.toString(), folderId));
  }

  function seeAll(): void {
    setPrefs((p) => ({ ...p, tab: "all" }));
    requestAnimationFrame(() => listRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }

  function editShortcuts(): void {
    setTab("shortcuts", true);
    requestAnimationFrame(() => listRef.current?.scrollIntoView({ block: "nearest" }));
  }

  const browse =
    prefs.tab === "shortcuts" ? (
      <KbMyShortcuts visible={visible} filtering={narrowed} />
    ) : visible.length === 0 ? (
      <EmptyState
        icon={Search}
        title="No sources match"
        hint={query.trim() ? `Nothing matches "${query.trim()}" with the current filters.` : "No sources match the current filters."}
      >
        <div className="flex flex-wrap items-center justify-center gap-2">
          {query.trim() ? <AskTruenoteLink /> : null}
          <button type="button" onClick={reset} className="btn-whisper px-3 py-1.5 text-sm">
            Clear search and filters
          </button>
        </div>
      </EmptyState>
    ) : prefs.view === "folders" ? (
      <KbFoldersView visible={visible} sort={sort} filtering={narrowed} scope={scope} search={search} />
    ) : prefs.view === "outline" ? (
      <KbOutlineView visible={visible} sort={sort} filtering={narrowed} collapsed={collapsed} onToggle={toggleCollapsed} />
    ) : (
      <KbListView visible={visible} sort={sort} filtering={narrowed} />
    );

  const errorBanner = actionError ? (
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
  ) : null;

  return (
    <KbLibraryContext.Provider value={context}>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {organizing ? (
        <>
          {errorBanner}
          <KbOrganize
            step={prefs.organizeStep}
            onStep={(organizeStep) => setPrefs((p) => ({ ...p, organizeStep }))}
            onDone={() => setOrganizing(false)}
            wide={wide}
            collapsed={collapsed}
            onToggle={toggleCollapsed}
            lastMoved={lastMoved}
          />
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
          <KbShortcutShelf ref={shelfRef} shelf={shelf} onEdit={editShortcuts} />

          <div className="flex flex-col gap-2">
            <KbSearch
              query={query}
              onQuery={setQuery}
              results={results}
              searchRef={searchRef}
              onOpenDoc={(id) => navigate(`/kb/${id}`)}
              onOpenFolder={openFolder}
              onSeeAll={seeAll}
              trailing={
                <KbFiltersButton
                  filters={filters}
                  onFilters={setFilters}
                  sort={sort}
                  onSort={(next) => setPrefs((p) => ({ ...p, sortByView: { ...p.sortByView, [p.view]: next } }))}
                  sortChanged={sortChanged}
                  tags={tags}
                  showLabels={!labelsBeside}
                />
              }
            />
            {sentence || sortChanged ? (
              <KbFilterSentence
                sentence={sentence}
                onClear={clearFilters}
                sort={sortChanged ? sort : null}
                onResetSort={() => setPrefs((p) => ({ ...p, sortByView: { ...p.sortByView, [p.view]: undefined } }))}
              />
            ) : null}
          </div>

          {linked ? (
            <div
              role="status"
              data-kb-ids-banner
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm"
            >
              <Link2 className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              <p className="min-w-0 flex-1">
                Showing {linked.ids.size} {linked.ids.size === 1 ? "source" : "sources"}
                {linked.fromUsage && linked.days !== null
                  ? ` no answer used in the last ${linked.days} ${linked.days === 1 ? "day" : "days"}`
                  : linked.fromUsage
                    ? " from Source usage"
                    : " from a shared link"}
                .
              </p>
              <button type="button" onClick={clearLinked} className="btn-whisper px-3 py-1 text-xs">
                Show all sources
              </button>
              <button
                type="button"
                onClick={clearLinked}
                aria-label="Dismiss and show all sources"
                title="Dismiss"
                className="btn-icon -my-1 h-7 w-7"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : null}

          {errorBanner}

          <div className={cn("grid items-start gap-5", labelsBeside && "grid-cols-[minmax(0,1fr)_15rem] min-[1440px]:grid-cols-[minmax(0,1fr)_18rem]")}>
            <section ref={listRef} aria-label="Sources list" className="flex min-w-0 scroll-mt-4 flex-col gap-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div role="tablist" aria-label="Which sources" className="flex gap-2">
                  {TABS.map((t) => {
                    const selected = prefs.tab === t.id;
                    return (
                      <button
                        key={t.id}
                        id={`${tabsId}-${t.id}`}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-controls={`${tabsId}-panel`}
                        tabIndex={selected ? 0 : -1}
                        data-kb-tab={t.id}
                        onClick={() => setTab(t.id)}
                        onKeyDown={onTabKeyDown}
                        className={cn(
                          "btn-base px-4 py-1.5 text-sm",
                          selected
                            ? "border border-primary bg-primary font-medium text-primary-foreground"
                            : "border border-border bg-secondary text-foreground hover:border-foreground/20"
                        )}
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
                  {prefs.tab === "all" ? (
                    <div
                      role="group"
                      aria-label="View"
                      data-kb-view={prefs.view}
                      className="flex overflow-hidden rounded-lg border border-border bg-card"
                    >
                      {KB_VIEWS.map((view) => {
                        const Icon = VIEW_ICONS[view];
                        const selected = prefs.view === view;
                        return (
                          <button
                            key={view}
                            type="button"
                            aria-pressed={selected}
                            data-kb-view-option={view}
                            title={VIEW_DETAILS[view]}
                            onClick={() => {
                              if (selected) return;
                              setPrefs((p) => ({ ...p, view }));
                              if (new URLSearchParams(search).has("folder")) navigate(folderHref(search, null), { replace: true });
                            }}
                            className={cn(
                              "flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              selected
                                ? "bg-primary/10 font-medium text-primary"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            )}
                          >
                            <Icon className="h-4 w-4" aria-hidden />
                            {KB_VIEW_LABELS[view]}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {canOrganize ? (
                    <button
                      ref={organizeButtonRef}
                      type="button"
                      data-kb-organize-button
                      onClick={() => setOrganizing(true)}
                      className="btn-whisper gap-1.5 px-3 py-1.5 text-sm"
                      title="Arrange folders, tags and team shortcuts for everyone"
                    >
                      <FolderCog className="h-4 w-4" aria-hidden />
                      Organize
                    </button>
                  ) : null}
                </div>
              </div>
              <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${prefs.tab}`} className="min-w-0">
                {browse}
              </div>
            </section>
            {labelsBeside ? (
              <aside aria-label="My labels" className="sticky top-4">
                <KbLabels variant="card" selected={filters.colors} onToggle={toggleLabel} />
              </aside>
            ) : null}
          </div>

          {shelf.length > 0 ? <KbShortcutDock shelf={shelf} shown={showDock} /> : null}
        </>
      )}

      <KbDialogs dialog={dialog} onClose={() => setDialog(null)} onReturn={setDialog} />
    </KbLibraryContext.Provider>
  );
}
