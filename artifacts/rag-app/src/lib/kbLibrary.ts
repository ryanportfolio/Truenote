import type {
  KbCategory,
  KbColorLabel,
  KbDocumentListItem,
  KbDocumentListResponse,
  KbLibraryColor,
  KbSourceUserState,
  KbTag
} from "@/types/api";
import { KB_LIBRARY_COLORS as KB_LABEL_ORDER, isKbLibraryColor, kbLabelText } from "./kbLibraryColors";

/**
 * Pure helpers for the Sources page: folder tree building (folders are
 * "categories" in the API), search, filter and sort, the shortcuts shelf,
 * per-user view preferences, and the optimistic state transforms the page
 * applies before the server confirms a change. Every transform mirrors the
 * server rule it anticipates (routes/kb-library.ts) so the optimistic state
 * matches what a reload would return.
 */

/** Folders: a cabinet of folder cards. Outline: the nested tree. List: one flat list. */
export type KbView = "folders" | "outline" | "list";
export type KbSort = "manual" | "newest" | "updated" | "views" | "cited" | "title";
/** All sources, or only the ones the user starred (My shortcuts). */
export type KbTab = "all" | "shortcuts";
export type KbOrganizeStep = "shortcuts" | "folders";

export interface KbFilters {
  /** Added or changed in the last 14 days (isNew). */
  newOnly: boolean;
  /** Changed in the last 14 days, but added earlier than that. */
  updatedOnly: boolean;
  hasNote: boolean;
  tagIds: string[];
  /** The user's own labels (colors); a source matches any of them. */
  colors: KbLibraryColor[];
}

export interface KbPrefs {
  view: KbView;
  tab: KbTab;
  /** Sort chosen per view; a view without an entry uses defaultSort(view). */
  sortByView: Partial<Record<KbView, KbSort>>;
  filters: KbFilters;
  /** Outline-view folders the user collapsed. */
  collapsed: string[];
  /** Last Organize step a manager used. */
  organizeStep: KbOrganizeStep;
}

/** Key for "Not in a folder" (sources in no folder), in the cabinet, the outline and the URL. */
export const KB_UNCATEGORIZED = "__uncategorized";
/** `?folder=` value for "Not in a folder". */
export const KB_NO_FOLDER_PARAM = "none";

export const KB_MAX_CATEGORY_DEPTH = 4;
export const KB_NOTE_MAX = 4000;
export const KB_MAX_TEAM_PINS = 12;
export const KB_CATEGORY_NAME_MAX = 80;
export const KB_TAG_NAME_MAX = 40;
export const KB_LABEL_NAME_MAX = 40;
/** isNew covers this window on the server (routes/kb-library.ts). */
export const KB_NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Drag settle and sortable shifts: DESIGN.md ease-out-quart, under the 250 ms bar. Off under reduced motion. */
export const KB_DRAG_MOTION = { duration: 200, easing: "cubic-bezier(0.25, 1, 0.5, 1)" } as const;

export const KB_VIEWS: readonly KbView[] = ["folders", "outline", "list"];

export const KB_VIEW_LABELS: Record<KbView, string> = {
  folders: "Folders",
  outline: "Outline",
  list: "List"
};

export const KB_SORT_LABELS: Record<KbSort, string> = {
  manual: "Manager's order",
  newest: "Newest",
  updated: "Recently updated",
  views: "Most viewed",
  cited: "Most cited",
  title: "A to Z"
};

export const EMPTY_FILTERS: KbFilters = {
  newOnly: false,
  updatedOnly: false,
  hasNote: false,
  tagIds: [],
  colors: []
};

export function defaultSort(view: KbView): KbSort {
  return view === "list" ? "newest" : "manual";
}

export function defaultPrefs(): KbPrefs {
  return {
    view: "folders",
    tab: "all",
    sortByView: {},
    filters: EMPTY_FILTERS,
    collapsed: [],
    organizeStep: "shortcuts"
  };
}

export function sortForView(prefs: KbPrefs, view: KbView): KbSort {
  return prefs.sortByView[view] ?? defaultSort(view);
}

// ---------------------------------------------------------------------------
// Preferences (localStorage, keyed by user id)

const PREFS_PREFIX = "truenote:kb-library:v1:";

/** Views from earlier builds map onto today's: Categories and Cards became the folder cabinet. */
function parseView(value: unknown): KbView | null {
  if (typeof value !== "string") return null;
  if ((KB_VIEWS as readonly string[]).includes(value)) return value as KbView;
  if (value === "categories" || value === "cards") return "folders";
  return null;
}

function isSort(value: unknown): value is KbSort {
  return typeof value === "string" && value in KB_SORT_LABELS;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Parse stored prefs defensively; anything unrecognized falls back to defaults. */
export function parsePrefs(raw: string | null): KbPrefs {
  const fallback = defaultPrefs();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sortByView: Partial<Record<KbView, KbSort>> = {};
    const rawSorts = (parsed.sortByView ?? {}) as Record<string, unknown>;
    for (const view of KB_VIEWS) {
      if (isSort(rawSorts[view])) sortByView[view] = rawSorts[view] as KbSort;
    }
    const rawFilters = (parsed.filters ?? {}) as Record<string, unknown>;
    // The old "My pins" filter is the My shortcuts tab now.
    const tab: KbTab =
      parsed.tab === "shortcuts" || (parsed.tab === undefined && rawFilters.myPins === true) ? "shortcuts" : "all";
    return {
      view: parseView(parsed.view) ?? fallback.view,
      tab,
      sortByView,
      filters: {
        newOnly: rawFilters.newOnly === true,
        updatedOnly: rawFilters.updatedOnly === true,
        hasNote: rawFilters.hasNote === true,
        tagIds: stringArray(rawFilters.tagIds),
        colors: Array.isArray(rawFilters.colors) ? rawFilters.colors.filter(isKbLibraryColor) : []
      },
      collapsed: stringArray(parsed.collapsed),
      organizeStep: parsed.organizeStep === "folders" ? "folders" : "shortcuts"
    };
  } catch {
    return fallback;
  }
}

export function loadPrefs(userId: string): KbPrefs {
  if (typeof window === "undefined") return defaultPrefs();
  try {
    return parsePrefs(window.localStorage.getItem(PREFS_PREFIX + userId));
  } catch {
    return defaultPrefs();
  }
}

export function savePrefs(userId: string, prefs: KbPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFS_PREFIX + userId, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: preferences are a convenience, not state.
  }
}

// ---------------------------------------------------------------------------
// Category tree

export interface KbCategoryNode {
  category: KbCategory;
  /** 1 for top level. */
  depth: number;
  /** Names from the root down to this category. */
  path: string[];
  children: KbCategoryNode[];
}

export interface KbTree {
  roots: KbCategoryNode[];
  byId: Map<string, KbCategoryNode>;
  /** Depth-first order: the manager's reading order. */
  order: KbCategoryNode[];
}

function byPosition(a: KbCategory, b: KbCategory): number {
  return a.position - b.position || a.name.localeCompare(b.name);
}

export function buildCategoryTree(categories: KbCategory[]): KbTree {
  const ids = new Set(categories.map((c) => c.id));
  const childrenOf = new Map<string | null, KbCategory[]>();
  for (const category of categories) {
    // A parent the user cannot see (or a stale id) is treated as top level.
    const parent = category.parentId && ids.has(category.parentId) ? category.parentId : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(category);
    childrenOf.set(parent, list);
  }
  const byId = new Map<string, KbCategoryNode>();
  const order: KbCategoryNode[] = [];
  const visit = (parentId: string | null, depth: number, path: string[]): KbCategoryNode[] => {
    const siblings = (childrenOf.get(parentId) ?? []).slice().sort(byPosition);
    const nodes: KbCategoryNode[] = [];
    for (const category of siblings) {
      if (byId.has(category.id)) continue; // cycle guard
      const node: KbCategoryNode = {
        category,
        depth,
        path: [...path, category.name],
        children: []
      };
      byId.set(category.id, node);
      order.push(node);
      node.children = visit(category.id, depth + 1, node.path);
      nodes.push(node);
    }
    return nodes;
  };
  const roots = visit(null, 1, []);
  return { roots, byId, order };
}

export function categoryPathLabel(node: KbCategoryNode | undefined): string {
  return node ? node.path.join(" / ") : "";
}

/** Ids of the category and every category nested under it. */
export function subtreeIds(node: KbCategoryNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: KbCategoryNode): void => {
    ids.add(n.category.id);
    n.children.forEach(walk);
  };
  walk(node);
  return ids;
}

/** Levels in this subtree, counting the node itself (a leaf is 1). */
export function subtreeHeight(node: KbCategoryNode): number {
  return 1 + Math.max(0, ...node.children.map(subtreeHeight));
}

/** Siblings under parentId in display order. */
export function siblingIds(categories: KbCategory[], parentId: string | null): string[] {
  return categories
    .filter((c) => (c.parentId ?? null) === parentId)
    .sort(byPosition)
    .map((c) => c.id);
}

/**
 * Why a category cannot move under targetParentId, or null when it can.
 * Mirrors the server's depth and cycle triggers so menus can disable
 * impossible choices instead of failing after the fact.
 */
export function nestBlockReason(
  tree: KbTree,
  movingId: string,
  targetParentId: string | null
): string | null {
  const moving = tree.byId.get(movingId);
  if (!moving || targetParentId === null) return null;
  const target = tree.byId.get(targetParentId);
  if (!target) return null;
  if (subtreeIds(moving).has(targetParentId)) {
    return "A folder can't be moved inside itself.";
  }
  if (target.depth + subtreeHeight(moving) > KB_MAX_CATEGORY_DEPTH) {
    return `Folders can nest at most ${KB_MAX_CATEGORY_DEPTH} levels.`;
  }
  return null;
}

/** Documents in the category or any category nested under it. */
export function subtreeDocumentIds(node: KbCategoryNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: KbCategoryNode): void => {
    n.category.documentIds.forEach((id) => ids.add(id));
    n.children.forEach(walk);
  };
  walk(node);
  return ids;
}

// ---------------------------------------------------------------------------
// Search, filter, sort

export interface KbLookup {
  tree: KbTree;
  tagsById: Map<string, KbTag>;
}

export function buildLookup(data: Pick<KbDocumentListResponse, "categories" | "tags">): KbLookup {
  return {
    tree: buildCategoryTree(data.categories),
    tagsById: new Map(data.tags.map((t) => [t.id, t]))
  };
}

/** Title, private note, tag names and category names all count as a match. */
export function docMatchesQuery(doc: KbDocumentListItem, query: string, lookup: KbLookup): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (doc.title.toLowerCase().includes(q)) return true;
  if (doc.note?.toLowerCase().includes(q)) return true;
  for (const tagId of doc.tagIds) {
    if (lookup.tagsById.get(tagId)?.name.toLowerCase().includes(q)) return true;
  }
  for (const categoryId of doc.categoryIds) {
    if (lookup.tree.byId.get(categoryId)?.category.name.toLowerCase().includes(q)) return true;
  }
  return false;
}

export function docPassesFilters(doc: KbDocumentListItem, filters: KbFilters, now = Date.now()): boolean {
  if (filters.newOnly && !doc.isNew) return false;
  if (filters.updatedOnly && docStatus(doc, now) !== "updated") return false;
  if (filters.hasNote && !doc.note) return false;
  // Tags narrow with OR inside the tag set: "Billing or Refunds".
  if (filters.tagIds.length > 0 && !filters.tagIds.some((id) => doc.tagIds.includes(id))) {
    return false;
  }
  if (filters.colors.length > 0 && !(doc.myColor && filters.colors.includes(doc.myColor))) {
    return false;
  }
  return true;
}

export function filtersActive(filters: KbFilters, query: string): boolean {
  return (
    query.trim() !== "" ||
    filters.newOnly ||
    filters.updatedOnly ||
    filters.hasNote ||
    filters.tagIds.length > 0 ||
    filters.colors.length > 0
  );
}

function time(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function byTitle(a: KbDocumentListItem, b: KbDocumentListItem): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
}

/**
 * Sort a copy of docs. "manual" follows manualOrder (ids not in it go last,
 * A to Z); every other sort breaks ties by title so the order is stable.
 */
export function sortDocs(
  docs: KbDocumentListItem[],
  sort: KbSort,
  manualOrder?: Map<string, number>
): KbDocumentListItem[] {
  const copy = docs.slice();
  const compare = (a: KbDocumentListItem, b: KbDocumentListItem): number => {
    switch (sort) {
      case "newest":
        return time(b.createdAt ?? b.updatedAt) - time(a.createdAt ?? a.updatedAt);
      case "updated":
        return time(b.updatedAt) - time(a.updatedAt);
      case "views":
        return b.viewCount - a.viewCount;
      case "cited":
        return b.citationCount - a.citationCount;
      case "manual": {
        const ai = manualOrder?.get(a.documentId) ?? Number.MAX_SAFE_INTEGER;
        const bi = manualOrder?.get(b.documentId) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
      }
      default:
        return 0;
    }
  };
  copy.sort((a, b) => compare(a, b) || byTitle(a, b));
  return copy;
}

/** Order map for a category's own documents (its manager order). */
export function memberOrder(category: KbCategory): Map<string, number> {
  return new Map(category.documentIds.map((id, i) => [id, i]));
}

/** Manager's order across the whole library: first appearance walking the tree. */
export function libraryOrder(tree: KbTree): Map<string, number> {
  const order = new Map<string, number>();
  for (const node of tree.order) {
    for (const id of node.category.documentIds) {
      if (!order.has(id)) order.set(id, order.size);
    }
  }
  return order;
}

export function teamPins(items: KbDocumentListItem[]): KbDocumentListItem[] {
  return items
    .filter((d) => d.featuredPosition !== null)
    .sort((a, b) => (a.featuredPosition ?? 0) - (b.featuredPosition ?? 0));
}

/**
 * My pins, oldest pin first. A new pin goes to the end, so the number key a
 * user has learned for a pin never changes when they pin something else.
 */
export function myPins(items: KbDocumentListItem[]): KbDocumentListItem[] {
  return items
    .filter((d) => d.pinnedAt !== null)
    .sort((a, b) => time(a.pinnedAt) - time(b.pinnedAt) || byTitle(a, b));
}

/** My pins that get a number key (1 to 9), in strip order. */
export const KB_NUMBERED_PINS = 9;

/**
 * Sources this user opened, newest open first. Sources in `exclude` (already
 * in My pins or Team pins above) are left out so the strip adds new ones.
 */
export function recentlyOpened(
  items: KbDocumentListItem[],
  limit = 5,
  exclude: ReadonlySet<string> = new Set()
): KbDocumentListItem[] {
  return items
    .filter((d) => d.lastViewedByMeAt !== null && time(d.lastViewedByMeAt) > 0 && !exclude.has(d.documentId))
    .sort((a, b) => time(b.lastViewedByMeAt) - time(a.lastViewedByMeAt) || byTitle(a, b))
    .slice(0, limit);
}

/**
 * Document ids from a `?ids=a,b,c` link (Source usage links its Never cited
 * list this way). Returns null when the link has no ids.
 */
export function idsFromSearch(search: string): string[] | null {
  const raw = new URLSearchParams(search).get("ids");
  if (!raw) return null;
  const ids = Array.from(new Set(raw.split(",").map((id) => id.trim()).filter(Boolean)));
  return ids.length > 0 ? ids : null;
}

// ---------------------------------------------------------------------------
// Status, shortcuts shelf, "Used often", search panel, filter sentence

/**
 * The one status a row shows: "updated" when the source changed in the last
 * 14 days but was added before that, "new" when it was added in that window,
 * else null. Mirrors the server's isNew window.
 */
export function docStatus(
  doc: Pick<KbDocumentListItem, "isNew" | "createdAt">,
  now = Date.now()
): "new" | "updated" | null {
  if (!doc.isNew) return null;
  const created = time(doc.createdAt);
  return created > 0 && now - created > KB_NEW_WINDOW_MS ? "updated" : "new";
}

export type KbShortcutSource = "team" | "mine" | "recent";

export interface KbShortcut {
  doc: KbDocumentListItem;
  /** Why it is on the shelf: a team shortcut, starred by this user, or opened recently. */
  source: KbShortcutSource;
}

/**
 * The "Your shortcuts" shelf: team shortcuts in the manager's order, then the
 * user's own (oldest first, so a number never changes when they star
 * another), then recently opened sources that are in neither. No source
 * twice; at most `limit` (the 1 to 9 number keys follow this order).
 */
export function shortcutShelf(items: KbDocumentListItem[], limit = KB_NUMBERED_PINS): KbShortcut[] {
  const shelf: KbShortcut[] = [];
  const seen = new Set<string>();
  const add = (doc: KbDocumentListItem, source: KbShortcutSource): void => {
    if (shelf.length >= limit || seen.has(doc.documentId)) return;
    seen.add(doc.documentId);
    shelf.push({ doc, source });
  };
  teamPins(items).forEach((doc) => add(doc, "team"));
  myPins(items).forEach((doc) => add(doc, "mine"));
  recentlyOpened(items, limit, seen).forEach((doc) => add(doc, "recent"));
  return shelf;
}

/** The (at most) three most opened sources of a list, by views; sources nobody opened never count. */
export function usedOftenIds(docs: KbDocumentListItem[], count = 3): Set<string> {
  return new Set(
    docs
      .filter((d) => d.viewCount > 0)
      .sort((a, b) => b.viewCount - a.viewCount || byTitle(a, b))
      .slice(0, count)
      .map((d) => d.documentId)
  );
}

/** Most opened first; ties by citations, then title. */
export function mostUsed(docs: KbDocumentListItem[], limit: number): KbDocumentListItem[] {
  return docs
    .slice()
    .sort((a, b) => b.viewCount - a.viewCount || b.citationCount - a.citationCount || byTitle(a, b))
    .slice(0, limit);
}

/** Sources in the folder or any folder inside it, from `docs`. */
export function docsInFolder(docs: KbDocumentListItem[], node: KbCategoryNode): KbDocumentListItem[] {
  const ids = subtreeDocumentIds(node);
  return docs.filter((d) => ids.has(d.documentId));
}

/** Sources in no folder the user can see. */
export function docsWithoutFolder(docs: KbDocumentListItem[], tree: KbTree): KbDocumentListItem[] {
  return docs.filter((d) => !d.categoryIds.some((id) => tree.byId.has(id)));
}

/** `?folder=` value for a folder id (KB_UNCATEGORIZED becomes "none"). */
export function folderParam(scope: string): string {
  return scope === KB_UNCATEGORIZED ? KB_NO_FOLDER_PARAM : scope;
}

/** The open folder from `?folder=`: a folder id, KB_UNCATEGORIZED, or null for the cabinet. */
export function folderFromSearch(search: string, tree: KbTree): string | null {
  const raw = new URLSearchParams(search).get("folder");
  if (!raw) return null;
  if (raw === KB_NO_FOLDER_PARAM) return KB_UNCATEGORIZED;
  return tree.byId.has(raw) ? raw : null;
}

export interface KbFolderMatch {
  node: KbCategoryNode;
  /** Sources in it (and the folders inside it) among the searched set. */
  count: number;
}

export interface KbSearchResults {
  best: KbDocumentListItem | null;
  others: KbDocumentListItem[];
  folders: KbFolderMatch[];
  /** Every source that matches (the list below shows them all). */
  total: number;
}

function wordStart(text: string, q: string): boolean {
  return text.split(/[^a-z0-9]+/).some((word) => word.startsWith(q));
}

/** How well a source matches: title beats folder name, which beats tag and note. 0 = no match. */
function matchScore(doc: KbDocumentListItem, q: string, lookup: KbLookup): number {
  const title = doc.title.toLowerCase();
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (wordStart(title, q)) return 60;
  if (title.includes(q)) return 50;
  for (const id of doc.categoryIds) {
    if (lookup.tree.byId.get(id)?.category.name.toLowerCase().includes(q)) return 30;
  }
  for (const id of doc.tagIds) {
    if (lookup.tagsById.get(id)?.name.toLowerCase().includes(q)) return 25;
  }
  return doc.note?.toLowerCase().includes(q) ? 20 : 0;
}

/**
 * The grouped search panel: the best match, up to `limit` other sources,
 * and folders whose name matches. Searches only `docs` (already filtered),
 * so the panel agrees with the list below. Ties go to the most opened.
 */
export function searchLibrary(
  docs: KbDocumentListItem[],
  query: string,
  lookup: KbLookup,
  limit = 5
): KbSearchResults {
  const q = query.trim().toLowerCase();
  if (!q) return { best: null, others: [], folders: [], total: 0 };
  const ranked = docs
    .map((doc) => ({ doc, score: matchScore(doc, q, lookup) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.doc.viewCount - a.doc.viewCount || byTitle(a.doc, b.doc))
    .map((x) => x.doc);
  const folders = lookup.tree.order
    .filter((node) => node.category.name.toLowerCase().includes(q))
    .map((node) => ({ node, count: docsInFolder(docs, node).length }))
    .filter((match) => match.count > 0)
    .slice(0, 3);
  return { best: ranked[0] ?? null, others: ranked.slice(1, 1 + limit), folders, total: ranked.length };
}

function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The active filters as one plain sentence, for example "Showing 4 sources
 * labeled Red: Read before quoting fees." Null when nothing narrows the list.
 */
export function filterSentence({
  shown,
  query,
  filters,
  tagsById,
  labels
}: {
  shown: number;
  query: string;
  filters: KbFilters;
  tagsById: Map<string, KbTag>;
  labels: KbColorLabel[];
}): string | null {
  const parts: string[] = [];
  if (filters.colors.length > 0) parts.push(`labeled ${joinOr(filters.colors.map((c) => kbLabelText(c, labels)))}`);
  if (filters.newOnly) parts.push("that are new or changed");
  if (filters.updatedOnly) parts.push("updated recently");
  if (filters.hasNote) parts.push("with your notes");
  const tags = filters.tagIds.map((id) => tagsById.get(id)?.name).filter((n): n is string => Boolean(n));
  if (tags.length > 0) parts.push(`tagged ${joinOr(tags)}`);
  const q = query.trim();
  if (q) parts.push(`matching "${q}"`);
  if (parts.length === 0) return null;
  return `Showing ${shown} ${shown === 1 ? "source" : "sources"} ${joinAnd(parts)}.`;
}

/** Sources in the category or any category nested under it, or in no category for KB_UNCATEGORIZED. */
export function docsInScope(
  docs: KbDocumentListItem[],
  scope: string | null,
  tree: KbTree
): KbDocumentListItem[] {
  if (scope === null) return docs;
  if (scope === KB_UNCATEGORIZED) {
    return docs.filter((d) => !d.categoryIds.some((id) => tree.byId.has(id)));
  }
  const node = tree.byId.get(scope);
  if (!node) return docs;
  const ids = subtreeDocumentIds(node);
  return docs.filter((d) => ids.has(d.documentId));
}

/** Full paths ("Billing / Refunds") of every category the source is in, in library order. */
export function docCategoryPaths(doc: Pick<KbDocumentListItem, "categoryIds">, tree: KbTree): string[] {
  const known = new Set(doc.categoryIds);
  return tree.order.filter((node) => known.has(node.category.id)).map((node) => categoryPathLabel(node));
}

/**
 * Rows the Folders and Categories views render for these sources: one per
 * category membership (a source in two categories is listed twice), or one
 * for a source in no category. `repeated` counts sources listed more than
 * once; `maxRows` is the most rows any one source gets.
 */
export function groupedRowCount(
  docs: KbDocumentListItem[],
  tree: KbTree
): { rows: number; repeated: number; maxRows: number } {
  let rows = 0;
  let repeated = 0;
  let maxRows = 0;
  for (const doc of docs) {
    const memberships = doc.categoryIds.filter((id) => tree.byId.has(id)).length;
    rows += Math.max(1, memberships);
    maxRows = Math.max(maxRows, memberships);
    if (memberships > 1) repeated += 1;
  }
  return { rows, repeated, maxRows };
}

/**
 * How close two categories sit in the tree: the same category scores most,
 * a parent, child or sibling (same parent) less, anything else 0. Deeper
 * categories are narrower, so sharing one says more than sharing a broad
 * top-level one: "Billing / Refunds" beside "Billing / Refunds / Annual
 * plans" outranks two sources that only share "Retention".
 */
function categoryCloseness(a: KbCategoryNode, b: KbCategoryNode): number {
  if (a.category.id === b.category.id) return 2 * a.depth;
  const aParent = a.category.parentId ?? null;
  const bParent = b.category.parentId ?? null;
  const related =
    aParent === b.category.id || bParent === a.category.id || (aParent !== null && aParent === bParent);
  return related ? 2 * Math.min(a.depth, b.depth) - 1 : 0;
}

/**
 * Sources related to this one, closest first: each shared or nearby
 * category adds its closeness (categoryCloseness) and each shared tag adds
 * 1. Ties go to the most cited. Never includes the source itself.
 */
export function relatedSources(
  doc: Pick<KbDocumentListItem, "documentId" | "categoryIds" | "tagIds">,
  items: KbDocumentListItem[],
  tree: KbTree,
  limit = 5
): KbDocumentListItem[] {
  const mine = doc.categoryIds
    .map((id) => tree.byId.get(id))
    .filter((n): n is KbCategoryNode => Boolean(n));
  const tags = new Set(doc.tagIds);
  if (mine.length === 0 && tags.size === 0) return [];
  const score = (d: KbDocumentListItem): number => {
    let total = d.tagIds.filter((id) => tags.has(id)).length;
    for (const id of d.categoryIds) {
      const node = tree.byId.get(id);
      if (!node) continue;
      total += Math.max(0, ...mine.map((m) => categoryCloseness(m, node)));
    }
    return total;
  };
  return items
    .filter((d) => d.documentId !== doc.documentId)
    .map((d) => ({ d, score: score(d) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.d.citationCount - a.d.citationCount || byTitle(a.d, b.d))
    .slice(0, limit)
    .map((x) => x.d);
}

/** Move one entry of a list to a new index (copy). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const copy = list.slice();
  if (from < 0 || from >= copy.length) return copy;
  const [entry] = copy.splice(from, 1);
  copy.splice(Math.max(0, Math.min(to, copy.length)), 0, entry as T);
  return copy;
}

/** Insert id into list before or after anchorId (or at the end), removing any earlier copy. */
export function insertRelative(
  list: string[],
  id: string,
  anchorId: string | null,
  place: "before" | "after"
): string[] {
  const without = list.filter((x) => x !== id);
  if (anchorId === null) return [...without, id];
  const index = without.indexOf(anchorId);
  if (index === -1) return [...without, id];
  without.splice(place === "before" ? index : index + 1, 0, id);
  return without;
}

// ---------------------------------------------------------------------------
// Optimistic transforms. Each returns a new response object.

type Data = KbDocumentListResponse;

function mapItem(data: Data, documentId: string, fn: (d: KbDocumentListItem) => KbDocumentListItem): Data {
  return {
    ...data,
    items: data.items.map((d) => (d.documentId === documentId ? fn(d) : d))
  };
}

export function applyUserState(data: Data, state: KbSourceUserState): Data {
  return mapItem(data, state.documentId, (d) => ({
    ...d,
    pinnedAt: state.pinnedAt,
    note: state.note,
    noteUpdatedAt: state.noteUpdatedAt,
    myColor: state.color
  }));
}

/** The user just opened this source in the reader. */
export function applyOpened(data: Data, documentId: string, at: string): Data {
  return mapItem(data, documentId, (d) => ({ ...d, lastViewedByMeAt: at }));
}

export function applySourceColor(data: Data, documentId: string, color: KbLibraryColor | null): Data {
  return mapItem(data, documentId, (d) => ({ ...d, myColor: color }));
}

/** The user's private category color (null falls back to the team color). */
export function applyCategoryMyColor(data: Data, categoryId: string, color: KbLibraryColor | null): Data {
  return {
    ...data,
    categories: data.categories.map((c) => (c.id === categoryId ? { ...c, myColor: color } : c))
  };
}

/** The user's name for one of their label colors; null removes the name. Kept in palette order. */
export function applyColorLabel(data: Data, color: KbLibraryColor, name: string | null): Data {
  const rest = (data.labels ?? []).filter((l) => l.color !== color);
  const next = name ? [...rest, { color, name }] : rest;
  const order = (c: KbLibraryColor): number => KB_LABEL_ORDER.indexOf(c);
  return { ...data, labels: next.sort((a, b) => order(a.color) - order(b.color)) };
}

export function applyPin(data: Data, documentId: string, pinned: boolean): Data {
  return mapItem(data, documentId, (d) => ({
    ...d,
    pinnedAt: pinned ? d.pinnedAt ?? new Date().toISOString() : null
  }));
}

export function applyFeatured(data: Data, documentIds: string[]): Data {
  const position = new Map(documentIds.map((id, i) => [id, i]));
  return {
    ...data,
    items: data.items.map((d) => {
      const next = position.get(d.documentId) ?? null;
      return d.featuredPosition === next ? d : { ...d, featuredPosition: next };
    })
  };
}

/** Replace one category's ordered members and keep each item's categoryIds in step. */
export function applyCategoryMembers(data: Data, categoryId: string, documentIds: string[]): Data {
  const members = new Set(documentIds);
  return {
    ...data,
    categories: data.categories.map((c) =>
      c.id === categoryId ? { ...c, documentIds: documentIds.slice() } : c
    ),
    items: data.items.map((d) => {
      const has = d.categoryIds.includes(categoryId);
      const should = members.has(d.documentId);
      if (has === should) return d;
      return {
        ...d,
        categoryIds: should
          ? [...d.categoryIds, categoryId]
          : d.categoryIds.filter((id) => id !== categoryId)
      };
    })
  };
}

/** Set one document's categories; new memberships append, existing ones keep their place. */
export function applyDocumentCategories(data: Data, documentId: string, categoryIds: string[]): Data {
  const wanted = new Set(categoryIds);
  return {
    ...data,
    categories: data.categories.map((c) => {
      const has = c.documentIds.includes(documentId);
      if (wanted.has(c.id) && !has) return { ...c, documentIds: [...c.documentIds, documentId] };
      if (!wanted.has(c.id) && has) {
        return { ...c, documentIds: c.documentIds.filter((id) => id !== documentId) };
      }
      return c;
    }),
    items: data.items.map((d) =>
      d.documentId === documentId ? { ...d, categoryIds: categoryIds.slice() } : d
    )
  };
}

export function applyDocumentTags(data: Data, documentId: string, tagIds: string[]): Data {
  return mapItem(data, documentId, (d) => ({ ...d, tagIds: tagIds.slice() }));
}

export function applyCategoryOrder(data: Data, orderedIds: string[]): Data {
  const position = new Map(orderedIds.map((id, i) => [id, i]));
  return {
    ...data,
    categories: data.categories.map((c) =>
      position.has(c.id) ? { ...c, position: position.get(c.id) as number } : c
    )
  };
}

function nextPosition(categories: KbCategory[], parentId: string | null, excludeId?: string): number {
  const positions = categories
    .filter((c) => (c.parentId ?? null) === parentId && c.id !== excludeId)
    .map((c) => c.position);
  return positions.length === 0 ? 0 : Math.max(...positions) + 1;
}

/** Move a category under a new parent, appended after its new siblings. */
export function applyCategoryParent(data: Data, categoryId: string, parentId: string | null): Data {
  return {
    ...data,
    categories: data.categories.map((c) =>
      c.id === categoryId
        ? { ...c, parentId, position: nextPosition(data.categories, parentId, categoryId) }
        : c
    )
  };
}

/** Insert or replace a category returned by the server. */
export function applyCategoryUpsert(data: Data, category: KbCategory): Data {
  const exists = data.categories.some((c) => c.id === category.id);
  return {
    ...data,
    categories: exists
      ? data.categories.map((c) => (c.id === category.id ? category : c))
      : [...data.categories, category]
  };
}

/** Delete a category: its children move up to its parent (appended), members are dropped. */
export function applyCategoryDelete(data: Data, categoryId: string): Data {
  const deleted = data.categories.find((c) => c.id === categoryId);
  if (!deleted) return data;
  const parentId = deleted.parentId ?? null;
  const remaining = data.categories.filter((c) => c.id !== categoryId);
  let position = nextPosition(remaining, parentId);
  const children = remaining
    .filter((c) => c.parentId === categoryId)
    .sort(byPosition)
    .map((c) => c.id);
  const moved = new Map(children.map((id) => [id, position++]));
  return {
    ...data,
    categories: remaining.map((c) =>
      moved.has(c.id) ? { ...c, parentId, position: moved.get(c.id) as number } : c
    ),
    items: data.items.map((d) =>
      d.categoryIds.includes(categoryId)
        ? { ...d, categoryIds: d.categoryIds.filter((id) => id !== categoryId) }
        : d
    )
  };
}

export function applyTagUpsert(data: Data, tag: KbTag): Data {
  const exists = data.tags.some((t) => t.id === tag.id);
  return {
    ...data,
    tags: exists ? data.tags.map((t) => (t.id === tag.id ? tag : t)) : [...data.tags, tag]
  };
}

export function applyTagDelete(data: Data, tagId: string): Data {
  return {
    ...data,
    tags: data.tags.filter((t) => t.id !== tagId),
    items: data.items.map((d) =>
      d.tagIds.includes(tagId) ? { ...d, tagIds: d.tagIds.filter((id) => id !== tagId) } : d
    )
  };
}

export function sortTags(tags: KbTag[]): KbTag[] {
  return tags.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
