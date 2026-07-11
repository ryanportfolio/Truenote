import { Router } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../lib/db-client.js";
import {
  chatSessions,
  chunks,
  documents,
  documentVersions,
  queryLog
} from "@workspace/db/schema";
import {
  authedUser,
  requireAuth,
  requireCsrOrAbove,
  requireFreshPassword
} from "../middleware/current-user.js";
import { resolveEffectiveProgramId } from "../lib/auth/effective-program.js";
import {
  applyVersionActivity,
  linkedSourceFromChunk,
  loadCitationSnapshots,
  loadVersionActivity,
  withoutDurableCitation,
  type LinkedSource
} from "../lib/citations.js";

/**
 * CSR chat session history. A session groups the query_log rows from one
 * conversation so a CSR can return to a past lookup. Auto-named server-side
 * (routes/ask.ts) from the opening exchange.
 *
 * Every endpoint is scoped to the caller's own sessions AND effective
 * program — a session id belonging to another user or program 404s without
 * leaking existence. Open to every authenticated role (a CSR reviewing
 * their own history is the feature).
 */
export const sessionsRouter = Router();

sessionsRouter.use(requireAuth, requireFreshPassword, requireCsrOrAbove);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionListItem {
  id: string;
  title: string | null;
  updatedAt: string | null;
}

/** One reconstructed exchange, enough for the chat transcript to re-render. */
export interface SessionExchange {
  queryLogId: string;
  question: string;
  answer: string;
  refused: boolean;
  latencyMs: number | null;
  feedback: number | null;
  sources: LinkedSource[];
}

export interface SessionDetail {
  id: string;
  title: string | null;
  exchanges: SessionExchange[];
}

sessionsRouter.get("/", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.json({ items: [], noProgramSelected: true });
      return;
    }
    const rows = await db
      .select({
        id: chatSessions.id,
        title: chatSessions.title,
        updatedAt: chatSessions.updatedAt
      })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.userId, user.id),
          eq(chatSessions.programId, programId)
        )
      )
      .orderBy(desc(chatSessions.updatedAt))
      .limit(100);
    const items: SessionListItem[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null
    }));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

sessionsRouter.get("/:id", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const programId = await resolveEffectiveProgramId(user, req);
    if (programId === null) {
      res.status(400).json({ error: "No program selected." });
      return;
    }

    const sessionRows = await db
      .select({ id: chatSessions.id, title: chatSessions.title })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, id),
          eq(chatSessions.userId, user.id),
          eq(chatSessions.programId, programId)
        )
      )
      .limit(1);
    const session = sessionRows[0];
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // The exchanges, oldest first (chat reads top-to-bottom). Scope by
    // program + user too, so a mislinked row can never surface cross-scope.
    const logRows = await db
      .select({
        id: queryLog.id,
        question: queryLog.question,
        answer: queryLog.answer,
        citedChunkIds: queryLog.citedChunkIds,
        refused: queryLog.refused,
        latencyMs: queryLog.latencyMs,
        feedback: queryLog.feedback
      })
      .from(queryLog)
      .where(
        and(
          eq(queryLog.sessionId, id),
          eq(queryLog.programId, programId),
          eq(queryLog.userId, user.id)
        )
      )
      .orderBy(asc(queryLog.createdAt));

    // Durable snapshots are the primary receipt. They retain the exact
    // document version, clean excerpt, and raw markdown range even when a
    // same-version re-ingest replaces every chunk id.
    const loadedSnapshots = await loadCitationSnapshots({
      queryLogIds: logRows.map((row) => row.id),
      userId: user.id,
      programId
    });
    const snapshotsByLogId = new Map<string, LinkedSource[]>();
    for (const row of logRows) {
      const snapshots = loadedSnapshots.get(row.id);
      const citedIds = row.citedChunkIds ?? [];
      if (
        snapshots &&
        snapshots.length === citedIds.length &&
        snapshots.every((source, index) => source.chunk_id === citedIds[index])
      ) {
        snapshotsByLogId.set(row.id, snapshots);
      }
    }

    // Legacy fallback for rows written before citation_snapshots DDL (or
    // while it was unavailable). This preserves current behavior, but it is
    // intentionally not the durability mechanism: replaced chunks can drop.
    const allChunkIds = Array.from(
      new Set(
        logRows
          .filter((row) => !snapshotsByLogId.has(row.id))
          .flatMap((row) => row.citedChunkIds ?? [])
      )
    );
    interface ResolvedChunk {
      chunkId: string;
      content: string;
      metadata: unknown;
      docId: string;
      docTitle: string;
      documentVersionId: string;
      versionNumber: number;
    }
    const chunkMap = new Map<string, ResolvedChunk>();
    if (allChunkIds.length > 0) {
      const chunkRows = await db
        .select({
          chunkId: chunks.id,
          content: chunks.content,
          metadata: chunks.metadata,
          docId: documents.id,
          docTitle: documents.title,
          documentVersionId: documentVersions.id,
          versionNumber: documentVersions.versionNumber
        })
        .from(chunks)
        .innerJoin(documentVersions, eq(documentVersions.id, chunks.documentVersionId))
        .innerJoin(documents, eq(documents.id, documentVersions.documentId))
        // Only resolve chunks in the caller's program AND from still-active
        // versions. Legacy rows have no durable receipt, so a replaced or
        // removed version has no audit claim to keep — it simply drops (the
        // inline [id] renders as an unknown citation client-side). The
        // snapshot path handles superseded/deleted versions separately below.
        .where(
          and(
            inArray(chunks.id, allChunkIds),
            eq(chunks.programId, programId),
            eq(documentVersions.isActive, true)
          )
        );
      for (const c of chunkRows) {
        chunkMap.set(c.chunkId, c);
      }
    }

    // Fold live version activity into the durable snapshots: mark a citation
    // whose version has since been replaced as superseded (kept, but flagged
    // no-longer-current), and drop one whose version was deleted. Runs once
    // over every snapshot version id in this session. The legacy fallback
    // already filtered to active versions in its chunk query above.
    const snapshotVersionIds = [...snapshotsByLogId.values()]
      .flat()
      .map((source) => source.document_version_id)
      .filter((v): v is string => v !== null);
    const versionActivity = await loadVersionActivity(snapshotVersionIds);

    const exchanges: SessionExchange[] = logRows.map((r) => {
      const snapshots = snapshotsByLogId.get(r.id);
      const sources = snapshots
        ? applyVersionActivity(snapshots, versionActivity)
        : (r.citedChunkIds ?? []).flatMap((chunkId, citationIndex) => {
            const chunk = chunkMap.get(chunkId);
            if (!chunk) return [];
            return [
              withoutDurableCitation(linkedSourceFromChunk({
                chunkId: chunk.chunkId,
                docTitle: chunk.docTitle,
                content: chunk.content,
                documentId: chunk.docId,
                documentVersionId: chunk.documentVersionId,
                versionNumber: chunk.versionNumber,
                metadata: chunk.metadata,
                citationIndex
              }))
            ];
          });
      return {
        queryLogId: r.id,
        question: r.question,
        answer: r.answer ?? "",
        refused: r.refused ?? false,
        latencyMs: r.latencyMs,
        feedback: r.feedback,
        sources
      };
    });

    const detail: SessionDetail = {
      id: session.id,
      title: session.title,
      exchanges
    };
    res.json(detail);
  } catch (err) {
    next(err);
  }
});
