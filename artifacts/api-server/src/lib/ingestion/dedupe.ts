import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../db-client.js";
import { documentVersions } from "@workspace/db/schema";

/**
 * Hash dedupe: if a prior version with the same SHA-256 exists and was parsed
 * successfully, return its parsed_markdown so we can skip the OCR call.
 *
 * Caller MUST pass `currentVersionId` — the id of the version currently being
 * ingested. uploadDocument writes file_sha256 onto the new row before the
 * worker fires, so without excluding the current row this query always
 * matches the in-flight 'parsing' version and the cache short-circuits to
 * miss.
 *
 * `parse_status = 'ready'` is filtered in SQL (not in TS after the fact) so
 * any number of older failed/parsing/pending rows for the same hash are
 * skipped — the ORDER BY uploadedAt only matters among ready rows.
 *
 * Per .claude/reference/ingestion.md: re-uploading does NOT update an
 * existing row — it creates a new document_versions row. Dedupe only reuses
 * the parsed markdown text; the new row still gets inserted.
 */
export async function findCachedParsedMarkdown(
  sha256: string,
  currentVersionId: string
): Promise<{ parsedMarkdown: string } | null> {
  if (!sha256) return null;
  const rows = await db
    .select({
      parsedMarkdown: documentVersions.parsedMarkdown
    })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.fileSha256, sha256),
        eq(documentVersions.parseStatus, "ready"),
        ne(documentVersions.id, currentVersionId)
      )
    )
    .orderBy(desc(documentVersions.uploadedAt))
    .limit(1);

  const row = rows[0];
  if (!row?.parsedMarkdown) return null;
  return { parsedMarkdown: row.parsedMarkdown };
}
