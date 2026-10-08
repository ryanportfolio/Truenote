/**
 * Pure helpers for the source-usage analytics endpoints in
 * routes/admin/insights.ts. No database import, so they unit-test directly.
 */

export const DEFAULT_USAGE_WINDOW_DAYS = 30;
export const MAX_USAGE_WINDOW_DAYS = 365;
export const DEFAULT_QUESTION_LIMIT = 50;
export const MAX_QUESTION_LIMIT = 200;
export const MAX_USAGE_SOURCES = 100;
export const MAX_TOP_SOURCES_PER_USER = 3;
export const MAX_MATRIX_SOURCES = 10;

export interface UsageMatrix {
  documentIds: string[];
  rows: { userId: string; counts: number[] }[];
}

/**
 * Shape the people x sources matrix from the JSON the summary query returns.
 * Every row gets exactly one count per column (missing or non-numeric cells
 * read as 0), so counts[i] always belongs to documentIds[i].
 */
export function shapeUsageMatrix(rawDocumentIds: unknown, rawRows: unknown): UsageMatrix {
  const documentIds = Array.isArray(rawDocumentIds)
    ? rawDocumentIds.filter((id): id is string => typeof id === "string")
    : [];
  const rows: UsageMatrix["rows"] = [];
  if (Array.isArray(rawRows)) {
    for (const raw of rawRows) {
      if (!raw || typeof raw !== "object") continue;
      const { userId, counts } = raw as { userId?: unknown; counts?: unknown };
      if (typeof userId !== "string") continue;
      const cells = Array.isArray(counts) ? counts : [];
      rows.push({
        userId,
        counts: documentIds.map((_, i) => {
          const n = Number(cells[i]);
          return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
        })
      });
    }
  }
  return { documentIds, rows };
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return fallback;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** `?days=` clamped to 1..365; anything unparseable falls back to 30. */
export function parseUsageWindowDays(raw: unknown): number {
  return clampInt(raw, 1, MAX_USAGE_WINDOW_DAYS, DEFAULT_USAGE_WINDOW_DAYS);
}

/** `?limit=` clamped to 1..200; anything unparseable falls back to 50. */
export function parseQuestionLimit(raw: unknown): number {
  return clampInt(raw, 1, MAX_QUESTION_LIMIT, DEFAULT_QUESTION_LIMIT);
}

/**
 * Optional uuid query parameter. Absent or empty means "no filter"
 * (returns null); a present but malformed value returns "invalid" so the
 * route can 404 it like any other unknown id.
 */
export function parseOptionalUuid(raw: unknown): string | null | "invalid" {
  if (raw === undefined || raw === "") return null;
  if (
    typeof raw !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
  ) {
    return "invalid";
  }
  return raw.toLowerCase();
}

/** Null when the viewer's clearance hides the title. */
export function gatedTitle(title: string | null, visible: boolean): string | null {
  return visible ? title : null;
}

/** Answer feedback is stored as 1 / -1; anything else reads as no feedback. */
export function normalizeFeedback(value: unknown): 1 | -1 | null {
  const n = Number(value);
  return n === 1 || n === -1 ? n : null;
}

/**
 * Split a limit+1 fetch into the page and the truncated flag.
 */
export function takePage<T>(rows: T[], limit: number): { items: T[]; truncated: boolean } {
  return rows.length > limit
    ? { items: rows.slice(0, limit), truncated: true }
    : { items: rows, truncated: false };
}
