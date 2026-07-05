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
import type { LinkedSource } from "./ask.js";

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

    // Reconstruct citation sources from the stored chunk ids. Chunk ids
    // change on re-ingest (doc ids don't), so a chunk cited by an old
    // answer may no longer resolve — those citations simply drop, and the
    // answer's inline [id] renders as an unknown citation client-side.
    // The excerpt is the full chunk content (the live LLM-trimmed excerpt
    // isn't stored); the citation panel already renders full chunk text.
    const allChunkIds = Array.from(
      new Set(logRows.flatMap((r) => r.citedChunkIds ?? []))
    );
    const chunkMap = new Map<string, LinkedSource>();
    if (allChunkIds.length > 0) {
      const chunkRows = await db
        .select({
          chunkId: chunks.id,
          content: chunks.content,
          docId: documents.id,
          docTitle: documents.title
        })
        .from(chunks)
        .innerJoin(documentVersions, eq(documentVersions.id, chunks.documentVersionId))
        .innerJoin(documents, eq(documents.id, documentVersions.documentId))
        // Defense in depth: only resolve chunks in the caller's program.
        .where(and(inArray(chunks.id, allChunkIds), eq(chunks.programId, programId)));
      for (const c of chunkRows) {
        chunkMap.set(c.chunkId, {
          chunk_id: c.chunkId,
          doc_title: c.docTitle,
          excerpt: c.content,
          doc_id: c.docId
        });
      }
    }

    const exchanges: SessionExchange[] = logRows.map((r) => ({
      queryLogId: r.id,
      question: r.question,
      answer: r.answer ?? "",
      refused: r.refused ?? false,
      latencyMs: r.latencyMs,
      feedback: r.feedback,
      sources: (r.citedChunkIds ?? [])
        .map((cid) => chunkMap.get(cid))
        .filter((s): s is LinkedSource => s !== undefined)
    }));

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
