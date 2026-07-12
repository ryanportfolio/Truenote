import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db-client.js";
import type { Source } from "./generation/answer.js";
import { stripContextHeader } from "./ingestion/contextual.js";
import { canonicalChunkContent } from "./parsing/chunker.js";
import type { RetrievalChunk } from "./retrieval/query.js";
import { recordAppError } from "./observability/error-log.js";

const CitationMetadataSchema = z
  .object({
    context_header: z.string().optional(),
    has_image: z.boolean().optional(),
    source_start: z.number().int().nonnegative().optional(),
    source_end: z.number().int().positive().optional()
  })
  .passthrough();

export const LinkedSourceSchema = z
  .object({
    chunk_id: z.string().uuid(),
    doc_title: z.string(),
    excerpt: z.string(),
    doc_id: z.string().uuid().nullable(),
    document_version_id: z.string().uuid().nullable(),
    version_number: z.number().int().positive().nullable(),
    citation_index: z.number().int().nonnegative(),
    /** UTF-16 offsets into the cited version's parsed_markdown. */
    source_start: z.number().int().nonnegative().nullable(),
    source_end: z.number().int().positive().nullable(),
    /**
     * Runtime-only display flag, computed on the history read path and never
     * persisted: true when the cited document version has since been replaced
     * (is_active=false) but still exists. The excerpt stays the owner's
     * durable receipt of what they were shown; the flag lets the UI mark it
     * as no longer current so a CSR doesn't re-quote superseded content.
     * Absent on the stored snapshot and on freshly generated citations (the
     * version is active then). Deleted-version citations are dropped, not
     * flagged.
     */
    superseded: z.boolean().optional()
  })
  .superRefine((source, ctx) => {
    const hasStart = source.source_start !== null;
    const hasEnd = source.source_end !== null;
    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Citation source offsets must be present together"
      });
    } else if (
      source.source_start !== null &&
      source.source_end !== null &&
      source.source_end <= source.source_start
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Citation source end must follow start"
      });
    }
  });

export const CitationSnapshotsSchema = z.array(LinkedSourceSchema).max(64);

export type LinkedSource = z.infer<typeof LinkedSourceSchema>;

export interface CitationTarget {
  excerpt: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface AuthorizedCitationReceipt {
  /** Null for image-derived evidence or snapshots without a raw text anchor. */
  target: CitationTarget | null;
}

interface LinkedSourceInput {
  chunkId: string;
  docTitle: string;
  content: string;
  documentId: string | null;
  documentVersionId: string | null;
  versionNumber: number | null;
  metadata: unknown;
  citationIndex: number;
}

function readCitationMetadata(metadata: unknown): z.infer<typeof CitationMetadataSchema> {
  const parsed = CitationMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : {};
}

/**
 * Build one server-grounded citation source. Contextual retrieval headers are
 * synthetic index text, not part of the source document, so they never reach
 * the user-facing excerpt. Image-description chunks intentionally have no raw
 * markdown anchor.
 */
export function linkedSourceFromChunk(input: LinkedSourceInput): LinkedSource {
  const metadata = readCitationMetadata(input.metadata);
  const hasAnchor =
    metadata.has_image !== true &&
    metadata.source_start !== undefined &&
    metadata.source_end !== undefined &&
    metadata.source_end > metadata.source_start;

  return {
    chunk_id: input.chunkId,
    doc_title: input.docTitle,
    excerpt: stripContextHeader(input.content, metadata.context_header).trim(),
    doc_id: input.documentId,
    document_version_id: input.documentVersionId,
    version_number: input.versionNumber,
    citation_index: input.citationIndex,
    source_start: hasAnchor ? metadata.source_start! : null,
    source_end: hasAnchor ? metadata.source_end! : null
  };
}

/** Preserve the generation source order: the zero-based position is durable. */
export function buildLinkedSources(
  sources: Source[],
  retrievedChunks: RetrievalChunk[]
): LinkedSource[] {
  const byId = new Map(retrievedChunks.map((chunk) => [chunk.id, chunk]));
  return sources.map((source, citationIndex) => {
    const chunk = byId.get(source.chunk_id);
    if (!chunk) {
      return {
        ...source,
        doc_id: null,
        document_version_id: null,
        version_number: null,
        citation_index: citationIndex,
        source_start: null,
        source_end: null
      };
    }
    return linkedSourceFromChunk({
      chunkId: chunk.id,
      docTitle: chunk.docTitle ?? "Untitled",
      content: chunk.content,
      documentId: chunk.documentId,
      documentVersionId: chunk.documentVersionId,
      versionNumber: chunk.versionNumber,
      metadata: chunk.metadata,
      citationIndex
    });
  });
}

/** Parse an immutable snapshot array and reject reordered/sparse positions. */
export function parseCitationSnapshots(value: unknown): LinkedSource[] | null {
  const parsed = CitationSnapshotsSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.some((source, index) => source.citation_index !== index)) {
    return null;
  }
  return parsed.data;
}

export function citationTargetFromLinkedSource(
  value: unknown,
  expected: {
    sourceIndex: number;
    documentId: string;
    documentVersionId: string;
  }
): CitationTarget | null {
  return citationReceiptFromLinkedSource(value, expected)?.target ?? null;
}

/** Authorize the saved receipt even when its evidence has no text span. */
export function citationReceiptFromLinkedSource(
  value: unknown,
  expected: {
    sourceIndex: number;
    documentId: string;
    documentVersionId: string;
  }
): AuthorizedCitationReceipt | null {
  const parsed = LinkedSourceSchema.safeParse(value);
  if (!parsed.success) return null;
  const source = parsed.data;
  if (
    source.citation_index !== expected.sourceIndex ||
    source.doc_id !== expected.documentId ||
    source.document_version_id !== expected.documentVersionId
  ) {
    return null;
  }
  return {
    target:
      source.source_start === null || source.source_end === null
        ? null
        : {
            excerpt: source.excerpt,
            sourceStart: source.source_start,
            sourceEnd: source.source_end
          }
  };
}

/** Remove fields that would claim durability when the snapshot write failed. */
export function withoutDurableCitation(source: LinkedSource): LinkedSource {
  return {
    ...source,
    document_version_id: null,
    version_number: null,
    source_start: null,
    source_end: null
  };
}

/** Guard against a same-version re-ingest replacing Markdown under old offsets. */
export function citationTargetMatchesMarkdown(
  markdown: string,
  target: CitationTarget
): boolean {
  if (
    target.sourceStart < 0 ||
    target.sourceEnd <= target.sourceStart ||
    target.sourceEnd > markdown.length
  ) {
    return false;
  }
  return (
    canonicalChunkContent(markdown.slice(target.sourceStart, target.sourceEnd)) ===
    target.excerpt.trim()
  );
}

/** PostgreSQL undefined_column, including driver-wrapped errors. */
export function isMissingCitationSnapshotsColumn(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code?: unknown }).code === "42703"
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return false;
}

function warning(scope: string, error: unknown): void {
  console.warn(scope, error instanceof Error ? error.message : error);
  void recordAppError({
    severity: "warning",
    source: "citations",
    operation: scope,
    error
  });
}

/**
 * Best-effort persistence after query_log insert. The `[]` predicate makes
 * the snapshot immutable after its first successful write. Missing DDL never
 * breaks answer delivery.
 */
export async function saveCitationSnapshots(input: {
  queryLogId: string;
  userId: string;
  programId: string;
  sources: LinkedSource[];
}): Promise<boolean> {
  const snapshots = parseCitationSnapshots(input.sources);
  if (!snapshots || snapshots.length === 0) return false;
  try {
    const value = JSON.stringify(snapshots);
    const citedChunkIds = sql.join(
      snapshots.map((source) => sql`${source.chunk_id}::uuid`),
      sql`, `
    );
    const result = await db.execute(sql`
      UPDATE query_log
      SET citation_snapshots = ${value}::jsonb
      WHERE id = ${input.queryLogId}::uuid
        AND user_id = ${input.userId}
        AND program_id = ${input.programId}::uuid
        AND cited_chunk_ids = ARRAY[${citedChunkIds}]::uuid[]
        AND COALESCE(citation_snapshots, '[]'::jsonb) = '[]'::jsonb
      RETURNING id
    `);
    return result.rows.length > 0;
  } catch (error) {
    if (!isMissingCitationSnapshotsColumn(error)) {
      warning("[citations] failed to persist snapshots:", error);
    }
    return false;
  }
}

interface CitationSnapshotRow {
  id: string;
  citation_snapshots: unknown;
}

/** Owner + program scoped history read. Missing/invalid rows use legacy fallback. */
export async function loadCitationSnapshots(input: {
  queryLogIds: string[];
  userId: string;
  programId: string;
}): Promise<Map<string, LinkedSource[]>> {
  const out = new Map<string, LinkedSource[]>();
  if (input.queryLogIds.length === 0) return out;
  try {
    const ids = sql.join(
      input.queryLogIds.map((id) => sql`${id}::uuid`),
      sql`, `
    );
    const result = await db.execute(sql`
      SELECT id::text, citation_snapshots
      FROM query_log
      WHERE id IN (${ids})
        AND user_id = ${input.userId}
        AND program_id = ${input.programId}::uuid
    `);
    for (const row of result.rows as unknown as CitationSnapshotRow[]) {
      const snapshots = parseCitationSnapshots(row.citation_snapshots);
      if (snapshots && snapshots.length > 0) out.set(row.id, snapshots);
    }
  } catch (error) {
    if (!isMissingCitationSnapshotsColumn(error)) {
      warning("[citations] failed to load snapshots:", error);
    }
  }
  return out;
}

/**
 * Resolve one durable deep-link target. Query owner, program, source position,
 * document, and document version must all match before an excerpt or offsets
 * are returned.
 */
export async function loadAuthorizedCitationReceipt(input: {
  queryLogId: string;
  sourceIndex: number;
  userId: string;
  programId: string;
  documentId: string;
  documentVersionId: string;
}): Promise<AuthorizedCitationReceipt | null> {
  try {
    const result = await db.execute(sql`
      SELECT citation_snapshots -> (${input.sourceIndex}::int) AS snapshot
      FROM query_log
      WHERE id = ${input.queryLogId}::uuid
        AND user_id = ${input.userId}
        AND program_id = ${input.programId}::uuid
        AND cited_chunk_ids[${input.sourceIndex + 1}] =
          ((citation_snapshots -> (${input.sourceIndex}::int) ->> 'chunk_id')::uuid)
      LIMIT 1
    `);
    return citationReceiptFromLinkedSource(result.rows[0]?.["snapshot"], {
      sourceIndex: input.sourceIndex,
      documentId: input.documentId,
      documentVersionId: input.documentVersionId
    });
  } catch (error) {
    if (!isMissingCitationSnapshotsColumn(error)) {
      warning("[citations] failed to resolve target:", error);
    }
    return null;
  }
}

interface VersionActivityRow {
  id: string;
  is_active: boolean;
}

/**
 * Resolve the current activity of a set of document versions. The returned
 * map distinguishes three states a history read must treat differently:
 *   - key present, value true   → version is active (current)
 *   - key present, value false  → version exists but was superseded/deactivated
 *   - key ABSENT                → version no longer exists (its document was
 *                                 deleted, cascading the version away)
 *
 * Returns null (not an empty map) on query failure, so callers can tell
 * "lookup failed, fail open to current behavior" apart from "every cited
 * version has genuinely been deleted, drop them all".
 */
export async function loadVersionActivity(
  versionIds: string[]
): Promise<Map<string, boolean> | null> {
  const unique = Array.from(new Set(versionIds));
  const out = new Map<string, boolean>();
  if (unique.length === 0) return out;
  try {
    const ids = sql.join(unique.map((id) => sql`${id}::uuid`), sql`, `);
    const result = await db.execute(sql`
      SELECT id::text, is_active FROM document_versions WHERE id IN (${ids})
    `);
    for (const row of result.rows as unknown as VersionActivityRow[]) {
      out.set(row.id, row.is_active === true);
    }
    return out;
  } catch (error) {
    warning("[citations] failed to load version activity:", error);
    return null;
  }
}

/**
 * Fold live version activity into durable citation sources so a CSR's history
 * reflects what content is still live:
 *   - active version         → source unchanged
 *   - superseded (inactive)  → source kept with superseded=true (still the
 *                              owner's receipt of what they saw, but the UI
 *                              marks it as no longer current)
 *   - deleted (absent)       → source DROPPED: a removed document must stop
 *                              serving its excerpt from history
 *   - null document_version_id (legacy/degenerate receipt) → passthrough:
 *                              nothing to tie it to a version, leave as-is
 *
 * `activity === null` means the lookup failed — fail open to current behavior
 * rather than blanking valid history over a transient DB error. Pure and
 * synchronous so the branch logic is unit-tested without a database.
 */
export function applyVersionActivity(
  sources: LinkedSource[],
  activity: Map<string, boolean> | null
): LinkedSource[] {
  if (activity === null) return sources;
  const out: LinkedSource[] = [];
  for (const source of sources) {
    const versionId = source.document_version_id;
    if (versionId === null) {
      out.push(source);
      continue;
    }
    if (!activity.has(versionId)) continue; // deleted → drop
    out.push(
      activity.get(versionId) === true ? source : { ...source, superseded: true }
    );
  }
  return out;
}

/**
 * Erase durable citation snapshots that reference a now-deleted document, so
 * a removed document's excerpts are purged from every user's history at rest
 * — not merely hidden at read time. The whole snapshot for a matching row is
 * nulled (a partial edit would corrupt the index-aligned receipt); those rows
 * fall back to the legacy resolver, which filters to active versions and so
 * drops the deleted chunks. Program-scoped. Returns the number of rows
 * scrubbed.
 *
 * Best-effort by design: the history read path (applyVersionActivity) already
 * refuses to serve deleted-version excerpts, so a failure here is a lost
 * at-rest cleanup, not an exposure.
 */
export async function purgeCitationSnapshotsForDocument(input: {
  programId: string;
  documentId: string;
}): Promise<number> {
  const marker = JSON.stringify([{ doc_id: input.documentId }]);
  const result = await db.execute(sql`
    UPDATE query_log
    SET citation_snapshots = NULL
    WHERE program_id = ${input.programId}::uuid
      AND citation_snapshots @> ${marker}::jsonb
    RETURNING id
  `);
  return result.rows.length;
}
