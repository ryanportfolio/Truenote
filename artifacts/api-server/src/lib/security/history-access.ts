import { sql } from "drizzle-orm";
import { db } from "../db-client.js";
import {
  applyVersionActivity, linkedSourceFromChunk, loadCitationSnapshots,
  withoutDurableCitation, type LinkedSource, type VersionActivity
} from "../citations.js";
import { canReadClassification, getUserMaxClassification, parseClassification } from "./classification.js";

interface HistoryLog {
  id: string;
  citedChunkIds: string[] | null;
}
interface HistoryVersion {
  id: string;
  document_id: string;
  program_id: string;
  document_lifecycle_state: string;
  is_active: boolean;
  lifecycle_state: string;
  classification: string;
  revoked_at: unknown;
  source_program_id: string;
  source_active: boolean;
  source_approved_at: unknown;
  source_retired_at: unknown;
}
interface HistoryChunk {
  chunkId: string;
  programId: string;
  content: string;
  metadata: unknown;
  docId: string;
  docTitle: string;
  documentVersionId: string;
  versionNumber: number;
}

/**
 * Authorize every dependency before returning any part of a stored exchange.
 * Missing provenance cannot prove current access, even for refused answers.
 * Durable retired receipts are allowed only while their parent document and
 * approved source remain active. Legacy chunks must still be current.
 */
export async function loadAuthorizedHistorySources(input: {
  logs: HistoryLog[];
  userId: string;
  programId: string;
}): Promise<Map<string, LinkedSource[]>> {
  const allowed = new Map<string, LinkedSource[]>();
  if (input.logs.length === 0) return allowed;
  const clearance = await getUserMaxClassification(input.userId);
  const snapshots = await loadCitationSnapshots({
    queryLogIds: input.logs.map((row) => row.id),
    userId: input.userId,
    programId: input.programId,
    strict: true
  });
  const receipts = new Map<string, LinkedSource[]>();
  for (const row of input.logs) {
    const saved = snapshots.get(row.id);
    const ids = row.citedChunkIds ?? [];
    if (saved && saved.length === ids.length && saved.every((source, index) => source.chunk_id === ids[index])) {
      receipts.set(row.id, saved);
    }
  }

  const chunkIds = [...new Set(input.logs.filter((row) => !receipts.has(row.id)).flatMap((row) => row.citedChunkIds ?? []))];
  const chunks = new Map<string, HistoryChunk>();
  if (chunkIds.length > 0) {
    const ids = sql.join(chunkIds.map((id) => sql`${id}::uuid`), sql`, `);
    const result = await db.execute(sql`
      SELECT c.id::text AS "chunkId", c.program_id::text AS "programId",
        c.content, c.metadata, d.id::text AS "docId", d.title AS "docTitle",
        v.id::text AS "documentVersionId", v.version_number AS "versionNumber"
      FROM chunks c
      JOIN document_versions v ON v.id = c.document_version_id
      JOIN documents d ON d.id = v.document_id
      WHERE c.id IN (${ids}) AND c.program_id = ${input.programId}::uuid
        AND d.program_id = ${input.programId}::uuid
    `);
    for (const row of result.rows as unknown as HistoryChunk[]) chunks.set(row.chunkId, row);
  }
  const versionIds = [...new Set([
    ...[...receipts.values()].flat().map((source) => source.document_version_id),
    ...[...chunks.values()].map((chunk) => chunk.documentVersionId)
  ].filter((id): id is string => id !== null))];
  const versions = new Map<string, HistoryVersion>();
  const activity = new Map<string, VersionActivity>();
  if (versionIds.length > 0) {
    const ids = sql.join(versionIds.map((id) => sql`${id}::uuid`), sql`, `);
    const result = await db.execute(sql`
      SELECT v.id::text, v.document_id::text, d.program_id::text,
        d.lifecycle_state AS document_lifecycle_state,
        v.is_active, v.lifecycle_state, v.classification, v.revoked_at,
        s.program_id::text AS source_program_id, s.is_active AS source_active,
        s.approved_at AS source_approved_at, s.retired_at AS source_retired_at
      FROM document_versions v
      JOIN documents d ON d.id = v.document_id
      JOIN content_sources s ON s.id = v.source_id
      WHERE v.id IN (${ids})
    `);
    for (const row of result.rows as unknown as HistoryVersion[]) {
      const classification = parseClassification(row.classification);
      if (
        row.program_id !== input.programId || row.source_program_id !== input.programId ||
        row.document_lifecycle_state !== "active" || row.source_active !== true ||
        !row.source_approved_at || row.source_retired_at !== null || row.revoked_at !== null ||
        !classification || !canReadClassification(clearance, classification)
      ) continue;
      versions.set(row.id, row);
      activity.set(row.id, { isActive: row.is_active, lifecycleState: row.lifecycle_state });
    }
  }

  for (const row of input.logs) {
    const ids = row.citedChunkIds ?? [];
    if (ids.length === 0) continue;
    const saved = receipts.get(row.id);
    if (saved) {
      if (!saved.every((source) => source.document_version_id !== null &&
        versions.get(source.document_version_id)?.document_id === source.doc_id)) continue;
      const sources = applyVersionActivity(saved, activity);
      if (sources.length === ids.length) allowed.set(row.id, sources);
      continue;
    }
    const sources: LinkedSource[] = [];
    for (const [citationIndex, id] of ids.entries()) {
      const chunk = chunks.get(id);
      if (!chunk || chunk.programId !== input.programId) break;
      const version = versions.get(chunk.documentVersionId);
      if (!version || version.document_id !== chunk.docId || version.is_active !== true || version.lifecycle_state !== "active") break;
      sources.push(withoutDurableCitation(linkedSourceFromChunk({
        chunkId: chunk.chunkId, docTitle: chunk.docTitle, content: chunk.content,
        documentId: chunk.docId, documentVersionId: chunk.documentVersionId,
        versionNumber: chunk.versionNumber, metadata: chunk.metadata, citationIndex
      })));
    }
    if (sources.length === ids.length) allowed.set(row.id, sources);
  }
  return allowed;
}
