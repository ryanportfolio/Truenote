import { z, type ZodError } from "zod";

/**
 * Pure validation and serialization helpers for the source library
 * (personal pins and notes, categories, tags, team pins). The SQL lives in
 * routes/kb.ts and routes/kb-library.ts; this module has no database import
 * so it can be unit-tested directly.
 */

export const LIBRARY_COLORS = [
  "slate",
  "blue",
  "green",
  "amber",
  "red",
  "violet",
  "teal",
  "pink"
] as const;

export type LibraryColor = (typeof LIBRARY_COLORS)[number];

export const MAX_NOTE_CHARS = 4_000;
export const MAX_CATEGORY_NAME_CHARS = 80;
export const MAX_TAG_NAME_CHARS = 40;
export const MAX_CATEGORY_DEPTH = 4;
export const MAX_CATEGORY_DOCUMENTS = 500;
export const MAX_DOCUMENT_CATEGORIES = 50;
export const MAX_DOCUMENT_TAGS = 30;
export const MAX_FEATURED = 12;
export const MAX_SIBLING_ORDER = 500;

const uuid = z.string().uuid();
const color = z.enum(LIBRARY_COLORS, {
  errorMap: () => ({ message: "Pick one of the listed colors." })
});

function boundedName(max: number, label: string) {
  return z
    .string({
      required_error: `Enter a ${label} name.`,
      invalid_type_error: `Enter a ${label} name.`
    })
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1, `Enter a ${label} name.`)
        .max(max, `${capitalize(label)} names can be at most ${max} characters.`)
    );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Array of unique uuids, at most `max` long. */
function uniqueIdList(max: number, tooMany: string) {
  return z
    .array(uuid, { invalid_type_error: "Send a list of ids." })
    .max(max, tooMany)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      message: "The list has the same item more than once."
    })
    .transform((ids) => ids.map((id) => id.toLowerCase()));
}

export const pinSchema = z
  .object({ pinned: z.boolean({ required_error: "Say whether to pin or unpin." }) })
  .strict();

export const noteSchema = z
  .object({
    note: z
      .string({ required_error: "Send the note text.", invalid_type_error: "Send the note text." })
      .transform((value) => value.trim())
      .pipe(z.string().max(MAX_NOTE_CHARS, `Notes can be at most ${MAX_NOTE_CHARS} characters.`))
  })
  .strict();

/** Trimmed note, or null when the user cleared it. */
export function normalizeNote(note: string): string | null {
  const trimmed = note.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export const createCategorySchema = z
  .object({
    name: boundedName(MAX_CATEGORY_NAME_CHARS, "category"),
    parentId: uuid.nullable().optional(),
    color: color.optional()
  })
  .strict();

export const updateCategorySchema = z
  .object({
    name: boundedName(MAX_CATEGORY_NAME_CHARS, "category").optional(),
    color: color.optional(),
    parentId: uuid.nullable().optional()
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined || value.color !== undefined || value.parentId !== undefined,
    { message: "Nothing to change." }
  );

export const reorderCategoriesSchema = z
  .object({
    parentId: uuid.nullable(),
    orderedIds: uniqueIdList(MAX_SIBLING_ORDER, "Too many categories at one level.")
  })
  .strict();

export const categoryDocumentsSchema = z
  .object({
    documentIds: uniqueIdList(
      MAX_CATEGORY_DOCUMENTS,
      `A category can hold at most ${MAX_CATEGORY_DOCUMENTS} sources.`
    )
  })
  .strict();

export const documentCategoriesSchema = z
  .object({
    categoryIds: uniqueIdList(
      MAX_DOCUMENT_CATEGORIES,
      `A source can be in at most ${MAX_DOCUMENT_CATEGORIES} categories.`
    )
  })
  .strict();

export const createTagSchema = z
  .object({
    name: boundedName(MAX_TAG_NAME_CHARS, "tag"),
    color: color.optional()
  })
  .strict();

export const updateTagSchema = z
  .object({
    name: boundedName(MAX_TAG_NAME_CHARS, "tag").optional(),
    color: color.optional()
  })
  .strict()
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    message: "Nothing to change."
  });

export const documentTagsSchema = z
  .object({
    tagIds: uniqueIdList(MAX_DOCUMENT_TAGS, `A source can have at most ${MAX_DOCUMENT_TAGS} tags.`)
  })
  .strict();

export const featuredSchema = z
  .object({
    documentIds: uniqueIdList(MAX_FEATURED, `You can pin at most ${MAX_FEATURED} sources for the team.`)
  })
  .strict();

/**
 * First human-readable issue, or the fallback when zod produced a generic
 * structural message (unknown keys, wrong JSON types) that would read as
 * jargon in the UI.
 */
export function validationMessage(error: ZodError, fallback: string): string {
  const issue = error.issues[0];
  if (!issue) return fallback;
  if (issue.code === "unrecognized_keys") return fallback;
  if (issue.code === "invalid_type" && issue.message === "Required") return fallback;
  if (issue.code === "invalid_type" && issue.message.startsWith("Expected ")) return fallback;
  if (issue.code === "invalid_string") return fallback;
  return issue.message;
}

/** True when both lists hold exactly the same ids (order ignored). */
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a.map((id) => id.toLowerCase()));
  const right = new Set(b.map((id) => id.toLowerCase()));
  if (left.size !== a.length || right.size !== b.length) return false;
  return [...right].every((id) => left.has(id));
}

/**
 * Can a category whose own subtree is `subtreeHeight` levels tall (1 = no
 * children) move under a parent sitting at `parentDepth` (1 = top level;
 * 0 = moving to the top level itself)? The database trigger only checks the
 * moved row, so the API checks the descendants it carries along.
 */
export function canNestAt(parentDepth: number, subtreeHeight: number): boolean {
  return parentDepth + subtreeHeight <= MAX_CATEGORY_DEPTH;
}

/**
 * Postgres SQLSTATE from a pg error. Drizzle 0.45 wraps driver errors in a
 * DrizzleQueryError whose `cause` holds the original, so check both.
 */
export function pgErrorCode(err: unknown): string | undefined {
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (typeof candidate === "object" && candidate !== null && "code" in candidate) {
      const code = (candidate as { code: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

function pgErrorText(err: unknown): string {
  const parts: string[] = [];
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (candidate instanceof Error) parts.push(candidate.message);
    if (typeof candidate === "object" && candidate !== null && "constraint" in candidate) {
      const constraint = (candidate as { constraint: unknown }).constraint;
      if (typeof constraint === "string") parts.push(constraint);
    }
  }
  return parts.join(" ");
}

export const CATEGORY_DEPTH_MESSAGE = `Categories can nest at most ${MAX_CATEGORY_DEPTH} levels.`;
export const CATEGORY_CYCLE_MESSAGE = "A category can't be moved inside itself.";
export const CATEGORY_NAME_TAKEN_MESSAGE = "A category with that name already exists here.";
export const TAG_NAME_TAKEN_MESSAGE = "A tag with that name already exists.";

/**
 * Plain-language 409 message for a category write the database refused
 * (kb_categories_guard trigger, the not-own-parent check, or the sibling
 * name index). Null when the error is something else.
 */
export function categoryConflictMessage(err: unknown): string | null {
  const code = pgErrorCode(err);
  if (code === "23505") return CATEGORY_NAME_TAKEN_MESSAGE;
  if (code !== "23514") return null;
  const text = pgErrorText(err);
  if (text.includes("nest at most")) return CATEGORY_DEPTH_MESSAGE;
  if (text.includes("inside itself") || text.includes("not_own_parent")) {
    return CATEGORY_CYCLE_MESSAGE;
  }
  return "That change isn't allowed for categories.";
}

export interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  color: string;
  position: number;
}

export function serializeCategory(row: CategoryRow, documentIds: string[]) {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    color: row.color as LibraryColor,
    position: Number(row.position),
    documentIds
  };
}

export interface TagRow {
  id: string;
  name: string;
  color: string;
}

export function serializeTag(row: TagRow) {
  return { id: row.id, name: row.name, color: row.color as LibraryColor };
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface UserStateRow {
  document_id: string;
  pinned_at: Date | string | null;
  note: string | null;
  note_updated_at: Date | string | null;
}

export function serializeUserState(documentId: string, row: UserStateRow | undefined) {
  return {
    documentId,
    pinnedAt: isoOrNull(row?.pinned_at),
    note: row?.note ?? null,
    noteUpdatedAt: isoOrNull(row?.note_updated_at)
  };
}
