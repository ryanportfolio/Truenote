import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { BookOpen, Eye, FolderCog, Info, Link2, PanelRightOpen, Plus, Search, Tags, X } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import {
  EMPTY_FILTERS,
  KB_NUMBERED_PINS,
  KB_UNCATEGORIZED,
  buildLookup,
  docMatchesQuery,
  docPassesFilters,
  filtersActive,
  groupedRowCount,
  idsFromSearch,
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
import { cn } from "@/lib/utils";
import type { CurrentUser, KbDocumentListResponse } from "@/types/api";
import { KbCategoriesView, KbFoldersView, KbListView } from "./KbBrowseViews";
import { KbCardsView } from "./KbCardsView";
import { KbCategoryRail } from "./KbCategoryRail";
import { KbLibraryContext, type KbDialogState, type KbLibraryContextValue } from "./KbContext";
import { KbCsrPreview } from "./KbCsrPreview";
import { KbDialogs } from "./KbDialogs";
import { KbOrganizeTree } from "./KbOrganizeTree";
import { KbPinStrips, KbPinsDock, KbTeamPinsEditor } from "./KbPinStrips";
import { KbToolbar } from "./KbToolbar";
import { useKbLibrary } from "./useKbLibrary";
import { KB_QUICK_LOOK_QUERY, KB_WIDE_QUERY, useMediaQuery } from "./useMediaQuery";

// The quick-look pane renders source markdown; load that code only when a pane opens.
const KbQuickLookDoc = lazy(() => import("./KbQuickLookDoc"));

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/** The quick-look column before a source is chosen: says what the pane is and how to fill it. */
function QuickLookHint({ paneId }: { paneId: string }): JSX.Element {
  return (
    <aside
      id={paneId}
      aria-label="Quick look"
      data-kb-quicklook="empty"
      className="sticky top-4 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground"
    >
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <PanelRightOpen className="h-4 w-4" aria-hidden />
        Quick look
      </p>
      <p className="mt-1 text-xs leading-relaxed">
        Press the Quick look button (
        <PanelRightOpen className="inline h-3.5 w-3.5 align-text-bottom" aria-hidden />) on a row to read a source here
        and keep your place in the list. A title still opens the full page.
      </p>
    </aside>
  );
}

/**
 * The Sources library: search, view and filter controls, the pinned strips,
 * and the browse views. Managers get an Organize mode that swaps the browse
 * controls for drag-and-drop arrangement, so arranging never mixes with
 * looking things up. View, sort, filters, collapsed folders and the rail or
 * card scope persist per user in localStorage. Personal colors live on the
 * server, not here. Wide screens add a category rail (Folders), a quick-look
 * pane (List) and a CSR preview beside the Organize editor.
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
  const [query, setQuery] = useState("");
  const [organizing, setOrganizing] = useState(false);
  const [csrPreview, setCsrPreview] = useState(false);
  const [dialog, setDialog] = useState<KbDialogState | null>(null);
  const [quickLookId, setQuickLookId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const organizeHeadingRef = useRef<HTMLHeadingElement>(null);
  const myPinsRef = useRef<HTMLElement>(null);
  // The organizing value focus last followed; StrictMode's double effect run sees no change.
  const focusedForOrganizing = useRef(organizing);
  const [, navigate] = useLocation();
  const search = useSearch();
  const [pinsInView, setPinsInView] = useState(true);
  const wide = useMediaQuery(KB_WIDE_QUERY);
  const quickLookRoom = useMediaQuery(KB_QUICK_LOOK_QUERY);
  const paneId = useId();

  useEffect(() => {
    savePrefs(user.id, prefs);
  }, [user.id, prefs]);

  // Focus follows a switch into or out of Organize mode. Nothing is focused
  // on load, so the number keys open pins right away.
  useEffect(() => {
    if (focusedForOrganizing.current === organizing) return;
    focusedForOrganizing.current = organizing;
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

  // "/kb?ids=a,b&from=usage": only these sources. Unknown or hidden ids are ignored.
  const linked = useMemo(() => {
    const ids = idsFromSearch(search);
    if (!ids) return null;
    const known = new Set(data.items.map((d) => d.documentId));
    const kept = new Set(ids.filter((id) => known.has(id)));
    if (kept.size === 0) return null;
    return { ids: kept, fromUsage: new URLSearchParams(search).get("from") === "usage" };
  }, [search, data.items]);

  const active = filtersActive(filters, query) || linked !== null;
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
  const team = useMemo(() => teamPins(data.items), [data.items]);
  const mine = useMemo(() => myPins(data.items), [data.items]);
  const recent = useMemo(() => {
    const shown = new Set([...team, ...mine].map((d) => d.documentId));
    return recentlyOpened(data.items, 5, shown);
  }, [data.items, team, mine]);
  const grouped = useMemo(() => groupedRowCount(visible, lookup.tree), [visible, lookup.tree]);
  const showStrips = !organizing && !active && data.items.length > 0;

  // Rail scope only counts while the rail is on screen; a stale id means All.
  const railScope =
    prefs.railScope === KB_UNCATEGORIZED || (prefs.railScope && lookup.tree.byId.has(prefs.railScope))
      ? prefs.railScope
      : null;
  const showRail = wide && !organizing && prefs.view === "folders" && lookup.tree.roots.length > 0;
  const quickLookOn = quickLookRoom && !organizing && prefs.view === "list";
  const quickLookDoc = quickLookOn && quickLookId ? data.items.find((d) => d.documentId === quickLookId) ?? null : null;

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

  const closeQuickLook = useCallback(() => {
    const id = quickLookId;
    setQuickLookId(null);
    if (!id) return;
    // Back to the row that opened it (re-queried: the list may have re-rendered).
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-kb-quicklook-trigger="${CSS.escape(id)}"]`)?.focus()
    );
  }, [quickLookId]);

  const quickLook = useMemo(
    () =>
      quickLookOn
        ? {
            documentId: quickLookDoc?.documentId ?? null,
            paneId,
            toggle: (documentId: string) => setQuickLookId((cur) => (cur === documentId ? null : documentId))
          }
        : null,
    [quickLookOn, quickLookDoc, paneId]
  );

  const context = useMemo<KbLibraryContextValue>(
    () => ({ data, lookup, actions, canOrganize, openDialog: setDialog, quickLook }),
    [data, lookup, actions, canOrganize, quickLook]
  );

  function toggleCollapsed(key: string): void {
    setPrefs((p) => ({
      ...p,
      collapsed: p.collapsed.includes(key) ? p.collapsed.filter((k) => k !== key) : [...p.collapsed, key]
    }));
  }

  function clearLinked(): void {
    navigate("/kb", { replace: true });
  }

  function reset(): void {
    setQuery("");
    setPrefs((p) => ({ ...p, filters: EMPTY_FILTERS }));
    if (linked) clearLinked();
  }

  const searching = query.trim() !== "";
  const browse =
    visible.length === 0 ? (
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
        searching={searching}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        scope={showRail ? railScope : null}
        onShowAll={() => setPrefs((p) => ({ ...p, railScope: null }))}
      />
    ) : prefs.view === "categories" ? (
      <KbCategoriesView visible={visible} sort={sort} filtering={active} searching={searching} />
    ) : prefs.view === "cards" ? (
      <KbCardsView
        visible={visible}
        sort={sort}
        tab={prefs.cardsTab}
        sub={prefs.cardsSub}
        onScope={(cardsTab, cardsSub) => setPrefs((p) => ({ ...p, cardsTab, cardsSub }))}
      />
    ) : (
      <KbListView visible={visible} sort={sort} filtering={active} searching={searching} />
    );

  const editor = (
    <div className="flex min-w-0 flex-col gap-5">
      <KbTeamPinsEditor team={team} />
      <KbOrganizeTree collapsed={collapsed} onToggle={toggleCollapsed} />
    </div>
  );

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
              <button
                type="button"
                aria-pressed={csrPreview}
                data-kb-csr-preview-toggle
                onClick={() => setCsrPreview((v) => !v)}
                title="Preview the library as a CSR sees it, while you edit"
                className={cn(
                  "btn-whisper gap-1.5 px-3 py-1.5 text-sm",
                  csrPreview && "border-primary/40 bg-primary/10 text-primary hover:text-primary"
                )}
              >
                <Eye className="h-4 w-4" aria-hidden />
                What CSRs will see
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
          repeated={
            prefs.view === "list" || prefs.view === "cards" || lookup.tree.roots.length === 0 ? 0 : grouped.repeated
          }
          repeatedMax={grouped.maxRows}
          active={active}
          onReset={reset}
          canOrganize={canOrganize}
          onOrganize={() => setOrganizing(true)}
          searchRef={searchRef}
        />
      ) : null}

      {linked && !organizing ? (
        <div
          role="status"
          data-kb-ids-banner
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm"
        >
          <Link2 className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <p className="min-w-0 flex-1">
            Showing {linked.ids.size} {linked.ids.size === 1 ? "source" : "sources"}
            {linked.fromUsage ? " from Source usage" : " from a shared link"}.
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
        csrPreview ? (
          wide ? (
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,22rem)] items-start gap-5">
              {editor}
              <KbCsrPreview />
            </div>
          ) : (
            <KbCsrPreview onBack={() => setCsrPreview(false)} />
          )
        ) : (
          editor
        )
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
          {showStrips ? (
            <KbPinStrips
              ref={myPinsRef}
              team={team}
              mine={mine}
              recent={recent}
              collapsed={prefs.quickCollapsed}
              onToggleCollapsed={() => setPrefs((p) => ({ ...p, quickCollapsed: !p.quickCollapsed }))}
            />
          ) : null}
          {showRail ? (
            <div className="grid grid-cols-[13rem_minmax(0,1fr)] items-start gap-5">
              <KbCategoryRail
                visible={visible}
                scope={railScope}
                onScope={(scope) => setPrefs((p) => ({ ...p, railScope: scope }))}
              />
              <div className="min-w-0">{browse}</div>
            </div>
          ) : quickLookOn ? (
            <div className="grid grid-cols-[minmax(0,1fr)_24rem] items-start gap-5">
              <div className="min-w-0">{browse}</div>
              {quickLookDoc ? (
                <Suspense fallback={<QuickLookHint paneId={paneId} />}>
                  <KbQuickLookDoc
                    key={quickLookDoc.documentId}
                    doc={quickLookDoc}
                    paneId={paneId}
                    onClose={closeQuickLook}
                  />
                </Suspense>
              ) : (
                <QuickLookHint paneId={paneId} />
              )}
            </div>
          ) : (
            browse
          )}
        </>
      )}

      {!organizing && mine.length > 0 ? <KbPinsDock mine={mine} shown={showDock} /> : null}

      <KbDialogs dialog={dialog} onClose={() => setDialog(null)} onReturn={setDialog} />
    </KbLibraryContext.Provider>
  );
}
