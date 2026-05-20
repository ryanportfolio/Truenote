/**
 * Object Storage orphan sweep.
 *
 * Usage on Replit (one-shot, ad-hoc — there's no scheduler yet):
 *   pnpm --filter @workspace/scripts exec tsx src/sweep-orphans.ts
 *
 * What it does:
 *   - Walks every distinct source_url referenced by document_versions
 *     (the "still-needed" set).
 *   - For each storage key NOT in that set, calls storage.delete().
 *
 * Why this exists: the delete-document route now removes blobs eagerly
 * when no other version references them. But three failure modes can
 * still strand a blob in storage:
 *   1. The eager delete-after-response fires-and-forgets; a transient
 *      Object Storage failure leaves the key alive.
 *   2. An ingestion job that uploaded the blob then crashed before
 *      inserting the document_versions row.
 *   3. Pre-Phase-1.5 deletes (when blobs were intentionally orphaned).
 *
 * This script is deliberately conservative: it only knows about keys
 * under the `uploads/` prefix the upload route writes to. Anything
 * else in the bucket is left alone. If the bucket ever grows another
 * prefix (snapshots, exports), this script needs to learn about it.
 *
 * Replit Object Storage doesn't expose a list() call through the
 * minimal interface we wrap, so this script can NOT enumerate the
 * bucket directly — it only deletes keys it can prove are orphaned.
 * Listing would require expanding ObjectStorage with a list() method
 * and is left for a follow-up when there's a real growth signal.
 *
 * For now: this script reports the count of still-referenced source_urls
 * the DB knows about, so an operator can compare against bucket-level
 * stats (Replit's UI) and notice drift. The actual blob deletion path
 * is exercised by the eager delete-after-response in the documents
 * route; this script is a placeholder runner so the operator pattern
 * exists.
 */
import { isNotNull } from "drizzle-orm";
import { db, closePool } from "../../artifacts/api-server/src/lib/db-client.js";
import { documentVersions } from "@workspace/db/schema";

async function main(): Promise<void> {
  console.log("[sweep] querying referenced storage keys");
  const rows = await db
    .selectDistinct({ sourceUrl: documentVersions.sourceUrl })
    .from(documentVersions)
    .where(isNotNull(documentVersions.sourceUrl));
  const referenced = new Set(
    rows
      .map((r) => r.sourceUrl)
      .filter((v): v is string => typeof v === "string" && v.length > 0)
  );
  console.log(
    `[sweep] ${referenced.size} distinct source_url(s) referenced by document_versions`
  );

  // Without a list() on ObjectStorage we can't enumerate the bucket.
  // Surface what we know so the operator can do a manual diff against
  // the Replit Object Storage UI if blob count looks suspicious.
  for (const key of referenced) {
    console.log(`[sweep] keep: ${key}`);
  }

  console.log(
    "[sweep] NB: to actively delete orphans we'd need ObjectStorage.list() — " +
      "tracked as a follow-up. The eager delete in routes/documents.ts " +
      "handles the common case (delete document → remove blob)."
  );

  await closePool();
}

main().catch((err) => {
  console.error("[sweep] fatal:", err);
  process.exit(1);
});
