import type {
  KbCategory,
  KbDocumentListItem,
  SourceUsageSource,
  SourceUsageUser
} from "@/types/api";

/**
 * Pure helpers for the Source usage page (/admin/sources): URL state,
 * table sorting, and the small derived numbers the page shows. Kept out of
 * the components so the page stays readable and the logic stays testable.
 */

export const USAGE_WINDOW_OPTIONS = [7, 30, 90] as const;
export const DEFAULT_USAGE_WINDOW = 30;

export interface UsageQueryState {
  days: number;
  userId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads `?days=30&user=<id>`. Unknown windows fall back to 30; a malformed id is dropped. */
export function parseUsageQuery(search: string): UsageQueryState {
  const params = new URLSearchParams(search);
  const rawDays = Number(params.get("days"));
  const days = (USAGE_WINDOW_OPTIONS as readonly number[]).includes(rawDays)
    ? rawDays
    : DEFAULT_USAGE_WINDOW;
  const rawUser = params.get("user");
  const userId = rawUser && UUID_RE.test(rawUser) ? rawUser : null;
  return { days, userId };
}

/** Builds the page URL for a state. The default window is left out so plain links stay short. */
export function buildUsageHref(state: UsageQueryState): string {
  const params = new URLSearchParams();
  if (state.days !== DEFAULT_USAGE_WINDOW) params.set("days", String(state.days));
  if (state.userId) params.set("user", state.userId);
  const query = params.toString();
  return query ? `/admin/sources?${query}` : "/admin/sources";
}

export type SortDirection = "asc" | "desc";

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

export type SourceSortKey =
  | "title"
  | "citationCount"
  | "questionCount"
  | "userCount"
  | "viewCount"
  | "negativeCount";

export type UserSortKey =
  | "name"
  | "questionCount"
  | "answeredRate"
  | "refusedCount"
  | "negativeCount";

/** Text columns start A to Z; number columns start highest first. */
export function nextSort<K extends string>(
  current: SortState<K>,
  key: K,
  textKeys: readonly K[]
): SortState<K> {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: textKeys.includes(key) ? "asc" : "desc" };
}

function compareText(a: string | null, b: string | null): number {
  // Restricted titles (null) sort after every readable title in either direction.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

export function sortSources(
  sources: readonly SourceUsageSource[],
  sort: SortState<SourceSortKey>
): SourceUsageSource[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...sources].sort((a, b) => {
    if (sort.key === "title") {
      if (a.title === null || b.title === null) return compareText(a.title, b.title);
      return sign * compareText(a.title, b.title);
    }
    const diff = a[sort.key] - b[sort.key];
    // Ties keep the server's ranking (citations, then most recent).
    return diff !== 0 ? sign * diff : b.citationCount - a.citationCount;
  });
}

/** Share of questions that got a cited answer, 0..1. Null when the person asked nothing. */
export function answeredRate(answered: number, questions: number): number | null {
  return questions > 0 ? answered / questions : null;
}

export function formatPercent(rate: number | null): string {
  return rate === null ? "No questions" : `${Math.round(rate * 100)}%`;
}

export function sortUsers(
  users: readonly SourceUsageUser[],
  sort: SortState<UserSortKey>
): SourceUsageUser[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...users].sort((a, b) => {
    let diff: number;
    if (sort.key === "name") {
      diff = compareText(a.name || a.email, b.name || b.email);
    } else if (sort.key === "answeredRate") {
      diff =
        (answeredRate(a.answeredCount, a.questionCount) ?? -1) -
        (answeredRate(b.answeredCount, b.questionCount) ?? -1);
    } else {
      diff = a[sort.key] - b[sort.key];
    }
    return diff !== 0 ? sign * diff : b.questionCount - a.questionCount;
  });
}

/** Bar width for a count against the largest count in view, as a CSS percentage. */
export function barWidth(value: number, max: number): string {
  if (max <= 0 || value <= 0) return "0%";
  // A small floor keeps a count of 1 visible next to a count of 400.
  return `${Math.max(2, Math.round((value / max) * 100))}%`;
}

/**
 * Library documents absent from the cited list. Exact only while the server
 * returned the full cited list (it caps at 100 sources), so callers show a
 * caveat when `complete` is false.
 */
export function neverCitedDocuments(
  library: readonly KbDocumentListItem[],
  cited: readonly SourceUsageSource[],
  citedCap = 100
): { items: KbDocumentListItem[]; complete: boolean } {
  const citedIds = new Set(cited.map((source) => source.documentId));
  const items = library
    .filter((doc) => !citedIds.has(doc.documentId))
    .sort((a, b) => compareText(a.title, b.title));
  return { items, complete: cited.length < citedCap };
}

/** "Dana Ruiz" falls back to the email, then to a neutral label. */
export function personLabel(person: { name: string | null; email?: string | null } | null): string {
  if (!person) return "Unknown person";
  return person.name?.trim() || person.email?.trim() || "Unknown person";
}

const ROLE_LABELS: Record<SourceUsageUser["role"], string> = {
  csr: "CSR",
  manager: "Manager",
  senior_manager: "Senior manager",
  super_user: "Super user"
};

export function roleLabel(role: SourceUsageUser["role"]): string {
  return ROLE_LABELS[role];
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** First word of a name, for headings like "Sources Jordan relies on". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/**
 * Category paths ("Billing / Refunds") for every document, from the library's
 * category list. A document in several categories gets several paths,
 * sorted A to Z. Parents missing from the list end the path where they stop.
 */
export function categoryPathsByDocument(
  categories: readonly KbCategory[]
): Map<string, string[]> {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const pathOf = (category: KbCategory): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let current: KbCategory | undefined = category;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return names.join(" / ");
  };
  const result = new Map<string, string[]>();
  for (const category of categories) {
    const path = pathOf(category);
    for (const documentId of category.documentIds) {
      const list = result.get(documentId) ?? [];
      list.push(path);
      result.set(documentId, list);
    }
  }
  for (const list of result.values()) {
    list.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }
  return result;
}

/** "Billing / Refunds" or "Billing / Refunds +1 more"; null when the source is in no category. */
export function formatCategoryPaths(paths: readonly string[] | undefined): string | null {
  if (!paths || paths.length === 0) return null;
  const first = paths[0] ?? "";
  return paths.length === 1 ? first : `${first} +${paths.length - 1} more`;
}

// ---------------------------------------------------------------------------
// Sources table columns (customizable, saved per user in localStorage)

export type SourceColumn = "userCount" | "questionCount" | "viewCount" | "negativeCount";

export const SOURCE_COLUMN_OPTIONS: readonly { key: SourceColumn; label: string; hint: string }[] = [
  { key: "userCount", label: "People", hint: "Different people whose answers cited it" },
  {
    key: "questionCount",
    label: "Distinct questions",
    hint: "Different wordings; the same question asked twice counts once"
  },
  { key: "viewCount", label: "Views", hint: "Times the source was opened in the reader" },
  { key: "negativeCount", label: "Thumbs down", hint: "Answers citing it that got a thumbs-down" }
];

export const DEFAULT_SOURCE_COLUMNS: readonly SourceColumn[] = ["userCount"];

const COLUMNS_PREFIX = "truenote:source-usage:columns:v1:";

/** Keeps only known columns, in the menu's order. */
export function parseSourceColumns(raw: string | null): SourceColumn[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const known = new Set(SOURCE_COLUMN_OPTIONS.map((option) => option.key));
    const chosen = new Set(value.filter((key): key is SourceColumn => known.has(key)));
    return SOURCE_COLUMN_OPTIONS.map((option) => option.key).filter((key) => chosen.has(key));
  } catch {
    return null;
  }
}

export function loadSourceColumns(userId: string): SourceColumn[] {
  try {
    return (
      parseSourceColumns(window.localStorage.getItem(COLUMNS_PREFIX + userId)) ?? [
        ...DEFAULT_SOURCE_COLUMNS
      ]
    );
  } catch {
    return [...DEFAULT_SOURCE_COLUMNS];
  }
}

export function saveSourceColumns(userId: string, columns: readonly SourceColumn[]): void {
  try {
    window.localStorage.setItem(COLUMNS_PREFIX + userId, JSON.stringify(columns));
  } catch {
    // Private mode or a full quota: the choice lasts until reload.
  }
}

// ---------------------------------------------------------------------------
// Data-built highlights for the everyone view

export interface UsageHighlights {
  topSource: { source: SourceUsageSource; share: number; next: SourceUsageSource | null } | null;
  mostRefused: SourceUsageUser | null;
  mostNegative: SourceUsageUser | null;
}

/**
 * The few standouts a manager acts on: the most-cited source and its share of
 * answered questions, and who had the most refusals and thumbs-down answers.
 * Ties go to the person with more questions (the server's order).
 */
export function usageHighlights(
  sources: readonly SourceUsageSource[],
  users: readonly SourceUsageUser[],
  answered: number
): UsageHighlights {
  const ranked = [...sources].sort((a, b) => b.citationCount - a.citationCount);
  const top = ranked[0] ?? null;
  const pick = (key: "refusedCount" | "negativeCount"): SourceUsageUser | null => {
    let best: SourceUsageUser | null = null;
    for (const user of users) {
      if (user[key] > 0 && (best === null || user[key] > best[key])) best = user;
    }
    return best;
  };
  return {
    topSource:
      top && answered > 0
        ? { source: top, share: top.citationCount / answered, next: ranked[1] ?? null }
        : null,
    mostRefused: pick("refusedCount"),
    mostNegative: pick("negativeCount")
  };
}

/** Share of `part` in `whole` as "12%", or null when there is nothing to divide. */
export function percentOf(part: number, whole: number): string | null {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : null;
}
