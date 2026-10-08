import type {
  KbCategory,
  KbDocumentListItem,
  SourceUsageQuestion,
  SourceUsageSource,
  SourceUsageSuggestion,
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

/** The people with the highest count: one person, or a tie of two or three. */
export interface PersonStandout {
  people: SourceUsageUser[];
  count: number;
}

export interface UsageHighlights {
  topSource: { source: SourceUsageSource; share: number; next: SourceUsageSource | null } | null;
  mostRefused: PersonStandout | null;
  mostNegative: PersonStandout | null;
}

/** Ties larger than this are not a standout; the sentence is left out. */
const MAX_NAMED_TIE = 3;

/**
 * The few standouts a manager acts on: the most-cited source and its share of
 * answered questions, and who had the most refusals and thumbs-down answers.
 * A top count of 1 is noise, not a standout, so it gets no sentence; a tie of
 * two or three names everyone in it (server order: most questions first); a
 * larger tie gets no sentence.
 */
export function usageHighlights(
  sources: readonly SourceUsageSource[],
  users: readonly SourceUsageUser[],
  answered: number
): UsageHighlights {
  const ranked = [...sources].sort((a, b) => b.citationCount - a.citationCount);
  const top = ranked[0] ?? null;
  const pick = (key: "refusedCount" | "negativeCount"): PersonStandout | null => {
    const count = users.reduce((max, user) => Math.max(max, user[key]), 0);
    if (count < 2) return null;
    const people = users.filter((user) => user[key] === count);
    return people.length > MAX_NAMED_TIE ? null : { people, count };
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

// ---------------------------------------------------------------------------
// Sources section view (table or heatmap), saved per user like the columns

export type SourceView = "table" | "heatmap";

const VIEW_PREFIX = "truenote:source-usage:view:v1:";

export function loadSourceView(userId: string): SourceView {
  try {
    return window.localStorage.getItem(VIEW_PREFIX + userId) === "heatmap" ? "heatmap" : "table";
  } catch {
    return "table";
  }
}

export function saveSourceView(userId: string, view: SourceView): void {
  try {
    window.localStorage.setItem(VIEW_PREFIX + userId, view);
  } catch {
    // Private mode or a full quota: the choice lasts until reload.
  }
}

// ---------------------------------------------------------------------------
// People x sources heatmap

export interface HeatmapColumn {
  documentId: string;
  /** Null when the viewer may not see the source (or it is not in `sources`). */
  title: string | null;
  isLive: boolean;
}

export interface HeatmapRow {
  userId: string;
  name: string;
  counts: number[];
}

export interface HeatmapModel {
  columns: HeatmapColumn[];
  rows: HeatmapRow[];
  max: number;
}

/**
 * Joins the response's `matrix` with names and titles. A column whose source
 * is missing from `sources` or has a null title stays restricted: the page
 * never guesses a title it was not given.
 */
export function heatmapModel(
  matrix: { documentIds: readonly string[]; rows: readonly { userId: string; counts: readonly number[] }[] },
  sources: readonly SourceUsageSource[],
  people: readonly { userId: string; name: string }[],
  users: readonly SourceUsageUser[]
): HeatmapModel {
  const byId = new Map(sources.map((source) => [source.documentId, source]));
  const names = new Map<string, string>();
  for (const user of users) names.set(user.userId, personLabel(user));
  for (const person of people) names.set(person.userId, personLabel(person));
  const columns = matrix.documentIds.map((documentId) => {
    const source = byId.get(documentId);
    return { documentId, title: source?.title ?? null, isLive: source?.isLive ?? true };
  });
  let max = 0;
  const rows = matrix.rows.map((row) => {
    const counts = columns.map((_, i) => Math.max(0, row.counts[i] ?? 0));
    for (const count of counts) max = Math.max(max, count);
    return { userId: row.userId, name: names.get(row.userId) ?? "Unknown person", counts };
  });
  return { columns, rows, max };
}

export interface HeatBin {
  min: number;
  max: number;
  /** "0", "3" or "4-6". */
  label: string;
  /** 0 for the zero bin, 1..4 for the shades, darkest last. */
  tone: number;
}

/**
 * Legend bins for counts 0..max: a zero bin plus up to four equal-width
 * ranges, so the printed ranges cover every count in view.
 */
export function heatBins(max: number): HeatBin[] {
  const bins: HeatBin[] = [{ min: 0, max: 0, label: "0", tone: 0 }];
  if (max <= 0) return bins;
  const steps = Math.min(4, max);
  let low = 1;
  for (let i = 1; i <= steps; i++) {
    const high = Math.round((max * i) / steps);
    bins.push({
      min: low,
      max: high,
      label: low === high ? String(low) : `${low}-${high}`,
      tone: Math.round((i * 4) / steps)
    });
    low = high + 1;
  }
  return bins;
}

export function heatBin(value: number, bins: readonly HeatBin[]): HeatBin {
  return bins.find((bin) => value >= bin.min && value <= bin.max) ?? bins[bins.length - 1]!;
}

/**
 * Sources page filtered to the given documents, with a note that the list
 * came from here. `days` names the window the list was built from.
 */
export function neverCitedHref(documentIds: readonly string[], days: number): string {
  if (documentIds.length === 0) return "/kb";
  return `/kb?ids=${documentIds.map(encodeURIComponent).join(",")}&from=usage&days=${days}`;
}

/** A fallback ("team_top") suggestion needs at least this many team answers in the window. */
export const TEAM_TOP_MIN_CITATIONS = 3;

/**
 * Suggestions worth showing: "related" ones as sent, "team_top" ones only
 * when teammates used the source at least TEAM_TOP_MIN_CITATIONS times, so a
 * source two teammates opened once is not offered as a team habit.
 */
export function shownSuggestions(
  suggestions: readonly SourceUsageSuggestion[]
): SourceUsageSuggestion[] {
  return suggestions.filter(
    (item) => item.reason === "related" || item.teamCitations >= TEAM_TOP_MIN_CITATIONS
  );
}

/** Share of `part` in `whole` as "12%", or null when there is nothing to divide. */
export function percentOf(part: number, whole: number): string | null {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : null;
}

// ---------------------------------------------------------------------------
// "More detail" section on the everyone view: collapsed by default, saved per user

const MORE_DETAIL_PREFIX = "truenote:source-usage:more-detail:v1:";

export function loadMoreDetailOpen(userId: string): boolean {
  try {
    return window.localStorage.getItem(MORE_DETAIL_PREFIX + userId) === "open";
  } catch {
    return false;
  }
}

export function saveMoreDetailOpen(userId: string, open: boolean): void {
  try {
    window.localStorage.setItem(MORE_DETAIL_PREFIX + userId, open ? "open" : "closed");
  } catch {
    // Private mode or a full quota: the choice lasts until reload.
  }
}

/** "Last 30 days", for headings and the time dropdown. */
export function windowLabel(days: number): string {
  return `Last ${days} days`;
}

// ---------------------------------------------------------------------------
// "Needs your attention" cards on the everyone view

export type AttentionCard =
  | { kind: "neverUsed"; count: number; documentIds: string[] }
  | { kind: "refused"; people: SourceUsageUser[]; count: number }
  | { kind: "negative"; people: SourceUsageUser[]; count: number }
  | { kind: "topSource"; source: SourceUsageSource; share: number };

/**
 * Up to three cards, each built from a fact that is true in this window and
 * hidden otherwise:
 * - sources nobody's answers used (count from the library the manager can
 *   see when it loaded, else the server's count);
 * - the person with the most refused questions, or the most thumbs-down
 *   answers when that standout is larger (same tie rules as
 *   `usageHighlights`: a count of 1 or a tie of four or more is skipped);
 * - the top source when it carries more answers than the next one and has at
 *   least 2, so a manager checks the source the team leans on most. A
 *   restricted or removed source is skipped: there is nothing to open.
 */
export function attentionCards(input: {
  sources: readonly SourceUsageSource[];
  users: readonly SourceUsageUser[];
  answered: number;
  neverUsed: { count: number; documentIds: string[] } | null;
}): AttentionCard[] {
  const cards: AttentionCard[] = [];
  if (input.neverUsed && input.neverUsed.count > 0) {
    cards.push({ kind: "neverUsed", ...input.neverUsed });
  }
  const { topSource, mostRefused, mostNegative } = usageHighlights(
    input.sources,
    input.users,
    input.answered
  );
  const negativeIsStronger =
    mostNegative !== null && (mostRefused === null || mostNegative.count > mostRefused.count);
  if (negativeIsStronger && mostNegative) {
    cards.push({ kind: "negative", ...mostNegative });
  } else if (mostRefused) {
    cards.push({ kind: "refused", ...mostRefused });
  }
  if (
    topSource &&
    topSource.source.title !== null &&
    topSource.source.isLive &&
    topSource.source.citationCount >= 2 &&
    (topSource.next === null || topSource.source.citationCount > topSource.next.citationCount)
  ) {
    cards.push({ kind: "topSource", source: topSource.source, share: topSource.share });
  }
  return cards.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Source drawer: identical questions grouped

/** Lowercase, punctuation removed, spaces collapsed: "What's the fee?" and "whats the fee" match. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface QuestionAsker {
  userId: string | null;
  name: string;
  /** This person's asks in the group whose answer they marked thumbs down. */
  negativeCount: number;
}

export interface QuestionGroup {
  key: string;
  /** The newest wording, as typed. */
  question: string;
  /** Every ask, newest first. */
  items: SourceUsageQuestion[];
  /** Distinct people who asked it, in order of their newest ask. */
  askers: QuestionAsker[];
  latestAt: string;
  refusedCount: number;
  negativeCount: number;
}

/** Groups asks by normalized text, keeping the newest-first order of the input. */
export function groupQuestions(items: readonly SourceUsageQuestion[]): QuestionGroup[] {
  const groups = new Map<string, QuestionGroup>();
  for (const item of items) {
    const key = normalizeQuestion(item.question) || item.queryLogId;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        question: item.question,
        items: [],
        askers: [],
        latestAt: item.askedAt,
        refusedCount: 0,
        negativeCount: 0
      };
      groups.set(key, group);
    }
    group.items.push(item);
    if (item.refused) group.refusedCount += 1;
    if (item.feedback === -1) group.negativeCount += 1;
    const askerKey = item.userId ?? `name:${item.userName ?? ""}`;
    let asker = group.askers.find((entry) => (entry.userId ?? `name:${entry.name}`) === askerKey);
    if (!asker) {
      asker = { userId: item.userId, name: personLabel({ name: item.userName }), negativeCount: 0 };
      group.askers.push(asker);
    }
    if (item.feedback === -1) asker.negativeCount += 1;
  }
  return [...groups.values()];
}

/** "JR" for "Jordan Reyes", "K" for "Kim", "?" when there is no name. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}
