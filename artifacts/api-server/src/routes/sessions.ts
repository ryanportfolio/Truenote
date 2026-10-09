import { Router } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../lib/db-client.js";
import {
  chatSessions,
  queryLog
} from "@workspace/db/schema";
import {
  authedUser,
  requireAuth,
  requireCsrOrAbove,
  requireFreshPassword
} from "../middleware/current-user.js";
import { resolveEffectiveProgramId } from "../lib/auth/effective-program.js";
import type { LinkedSource } from "../lib/citations.js";
import { loadAuthorizedHistorySources } from "../lib/security/history-access.js";

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

interface TitleLog {
  id: string;
  refused: boolean | null;
  citedChunkIds: string[] | null;
}

/**
 * The title is generated from the opening exchange (routes/ask.ts), so it
 * is released only when that exchange is currently authorized and no other
 * cited exchange is withheld. A later uncited refusal stores only fixed
 * refusal text and does not withhold the title, though it stays out of
 * history. `logs` must be oldest first.
 */
function canReleaseTitle(logs: TitleLog[], authorized: Map<string, unknown>): boolean {
  const [opening] = logs;
  if (!opening || !authorized.has(opening.id)) return false;
  return logs.every((log) => authorized.has(log.id) ||
    (log.refused === true && (log.citedChunkIds ?? []).length === 0));
}

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
    // Titles derive from conversation content (see canReleaseTitle).
    // Sessions with no visible exchange are left out: they would open empty.
    const logs = rows.length === 0 ? [] : await db.select({
      id: queryLog.id,
      sessionId: queryLog.sessionId,
      citedChunkIds: queryLog.citedChunkIds,
      refused: queryLog.refused
    }).from(queryLog).where(and(
      inArray(queryLog.sessionId, rows.map((row) => row.id)),
      eq(queryLog.programId, programId),
      eq(queryLog.userId, user.id)
    )).orderBy(asc(queryLog.createdAt), asc(queryLog.id));
    const authorized = await loadAuthorizedHistorySources({ logs, userId: user.id, programId });
    const bySession = new Map<string, TitleLog[]>();
    for (const log of logs) {
      if (log.sessionId === null) continue;
      const group = bySession.get(log.sessionId);
      if (group) group.push(log);
      else bySession.set(log.sessionId, [log]);
    }
    const items: SessionListItem[] = rows.flatMap((r) => {
      const sessionLogs = bySession.get(r.id) ?? [];
      if (!sessionLogs.some((log) => authorized.has(log.id))) return [];
      return [{
        id: r.id,
        title: canReleaseTitle(sessionLogs, authorized) ? r.title : null,
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null
      }];
    });
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
      // Same order as the namer in routes/ask.ts, so both agree on the
      // opening exchange.
      .orderBy(asc(queryLog.createdAt), asc(queryLog.id));

    const authorized = await loadAuthorizedHistorySources({ logs: logRows, userId: user.id, programId });
    const exchanges: SessionExchange[] = logRows.flatMap((r) => {
      const sources = authorized.get(r.id);
      if (!sources) return [];
      return [{
        queryLogId: r.id,
        question: r.question,
        answer: r.answer ?? "",
        refused: r.refused ?? false,
        latencyMs: r.latencyMs,
        feedback: r.feedback,
        sources
      }];
    });

    const detail: SessionDetail = {
      id: session.id,
      title: canReleaseTitle(logRows, authorized) ? session.title : null,
      exchanges
    };
    res.json(detail);
  } catch (err) {
    next(err);
  }
});
