import type {
  KbCategory,
  KbDocumentListItem,
  KbDocumentListResponse,
  KbLibraryColor,
  KbSourceUserState,
  KbTag
} from "@/types/api";
import { isKbLibraryColor } from "./kbLibraryColors";

/**
 * Pure helpers for the Sources page: category tree building, search, filter
 * and sort, per-user view preferences, and the optimistic state transforms
 * the page applies before the server confirms a change. Every transform
 * mirrors the server rule it anticipates (routes/kb-library.ts) so the
 * optimistic state matches what a reload would return.
 */

export type KbView = "folders" | "categories" | "list" | "cards";
export type KbSort = "manual" | "newest" | "updated" | "views" | "cited" | "title";

export interface KbFilters {
  newOnly: boolean;
  myPins: boolean;
  hasNote: boolean;
  tagIds: string[];
  /** The user's own source colors; a source matches any of them. */
  colors: KbLibraryColor[];
}

export interface KbPrefs {
  view: KbView;
  /** Sort chosen per view; a view without an entry uses defaultSort(view). */
  sortByView: Partial<Record<KbView, KbSort>>;
  filters: KbFilters;
  /** Folder-view categories the user collapsed. */
  collapsed: string[];
  /** My pins and Recently opened folded to one line above the library. */
  quickCollapsed: boolean;
  /**
   * Folders view category rail (wide screens): the category the list is
   * scoped to, KB_UNCATEGORIZED for sources in no category, null for all.
   */
  railScope: string | null;
  /** Cards view: the top-level category tab (null = All) and its subcategory chip. */
  cardsTab: string | null;
  cardsSub: string | null;
}

/** Scope key for "Not in a category" in the rail and the Cards tabs. */
export const KB_UNCATEGORIZED = "__uncategorized";

export const KB_MAX_CATEGORY_DEPTH = 4;
export const KB_NOTE_MAX = 4000;
export const KB_MAX_TEAM_PINS = 12;
export const KB_CATEGORY_NAME_MAX = 80;
export const KB_TAG_NAME_MAX = 40;

/** Drag settle and sortable shifts: DESIGN.md ease-out-quart, under the 250 ms bar. Off under reduced motion. */
export const KB_DRAG_MOTION = { duration: 200, easing: "cubic-bezier(0.25, 1, 0.5, 1)" } as const;

export const KB_VIEWS: readonly KbView[] = ["folders", "categories", "list", "cards"];

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
  myPins: false,
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
    sortByView: {},
    filters: EMPTY_FILTERS,
    collapsed: [],
    quickCollapsed: false,
    railScope: null,
    cardsTab: null,
    cardsSub: null
  };
}

export function sortForView(prefs: KbPrefs, view: KbView): KbSort {
  return prefs.sortByView[view] ?? defaultSort(view);
}

// ---------------------------------------------------------------------------
// Preferences (localStorage, keyed by user id)

const PREFS_PREFIX = "truenote:kb-library:v1:";

function isView(value: unknown): value is KbView {
  return typeof value === "string" && (KB_VIEWS as readonly string[]).includes(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
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
    return {
      view: isView(parsed.view) ? parsed.view : fallback.view,
      sortByView,
      filters: {
        newOnly: rawFilters.newOnly === true,
        myPins: rawFilters.myPins === true,
        hasNote: rawFilters.hasNote === true,
        tagIds: stringArray(rawFilters.tagIds),
        colors: Array.isArray(rawFilters.colors) ? rawFilters.colors.filter(isKbLibraryColor) : []
      },
      collapsed: stringArray(parsed.collapsed),
      quickCollapsed: parsed.quickCollapsed === true,
      railScope: stringOrNull(parsed.railScope),
      cardsTab: stringOrNull(parsed.cardsTab),
      cardsSub: stringOrNull(parsed.cardsSub)
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
    return "A category can't be moved inside itself.";
  }
  if (target.depth + subtreeHeight(moving) > KB_MAX_CATEGORY_DEPTH) {
    return `Categories can nest at most ${KB_MAX_CATEGORY_DEPTH} levels.`;
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

export function docPassesFilters(doc: KbDocumentListItem, filters: KbFilters): boolean {
  if (filters.newOnly && !doc.isNew) return false;
  if (filters.myPins && !doc.pinnedAt) return false;
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
    filters.myPins ||
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
