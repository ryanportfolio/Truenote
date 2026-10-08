import type {
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
