import { Router, type Request, type Response } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../lib/db-client.js";
import {
  chatSessions,
  chunks,
  documentVersions,
  programs,
  queryLog
} from "@workspace/db/schema";
import { retrieve } from "../lib/retrieval/query.js";
import { generateAnswer, type Source } from "../lib/generation/answer.js";
import { rewriteFollowUp, type HistoryTurn } from "../lib/generation/rewrite.js";
import { nameSession } from "../lib/generation/name-session.js";
import {
  authedUser,
  requireAuth,
  requireCsrOrAbove,
  requireFreshPassword
} from "../middleware/current-user.js";
import type { CurrentUser } from "../lib/auth/current-user.js";
import { resolveEffectiveProgramId } from "../lib/auth/effective-program.js";
import { canAccessProgram } from "../lib/auth/current-user.js";

export const askRouter = Router();

// All ask/feedback/flag endpoints require a logged-in user (any role) and a
// fresh password. Super users without a program selected can't /ask in 2A;
// they're surfaced an explicit error below.
askRouter.use(requireAuth, requireFreshPassword, requireCsrOrAbove);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server-side cap on question length. Beyond this, OpenAI silently truncates
 * the embedding input (no error), and the user prompt eats GPT-4o's context
 * budget — both pure DoS surface against our API spend. CSRs realistically
 * type questions in the low hundreds of characters; 2000 is a safe ceiling.
 */
const MAX_QUESTION_CHARS = 2000;
const TOO_LONG_TEXT =
  "Your question is too long. Please shorten it (under 2000 characters) and try again.";

function uniqueUuids(ids: string[]): string[] {
  const set = new Set<string>();
  for (const id of ids) if (UUID_RE.test(id)) set.add(id);
  return Array.from(set);
}

const AskBody = z.object({
  question: z.string().min(1),
  /**
   * Recent conversation turns, client-supplied, used ONLY for follow-up
   * query rewriting before retrieval — never for answer generation (the
   * citation contract grounds answers in excerpts alone). Caps bound the
   * cost/injection surface; the rewriter further trims to the last 3 turns
   * at 500 chars per field.
   */
  history: z
    .array(
      z.object({
        question: z.string().max(2000),
        answer: z.string().max(8000)
      })
    )
    .max(8)
    .optional(),
  /**
   * The chat session this ask belongs to. Omitted → a new session is
   * created and its id returned. A supplied id is honored only if it
   * belongs to the same user AND program; anything else silently starts
   * a fresh session (no cross-user/-program stitching).
   */
  sessionId: z.string().uuid().optional()
});

/**
 * Pipeline stages surfaced to a waiting client. These are REAL checkpoints,
 * not timed guesses — the UI's wait-state honesty depends on that.
 * "rewriting" fires only on follow-ups (history present), "searching"
 * covers embed + hybrid search, "reranking" the Cohere pass, "generating"
 * the LLM call.
 */
export type AskStage = "rewriting" | "searching" | "reranking" | "generating";

/** A generation Source plus the owning document id, for KB deep links. */
export type LinkedSource = Source & {
  /** Resolved via chunks → document_versions; null if the chunk vanished. */
  doc_id: string | null;
};

export interface AskResponse {
  queryLogId: string | null;
  /** The session this exchange was logged under, for the client to continue it. */
  sessionId: string | null;
  answer: string;
  sources: LinkedSource[];
  refused: boolean;
  confidence: "high" | "medium" | "low";
  /** Full retrieved chunks for the citation side panel. */
  retrievedChunks: { id: string; content: string; docTitle?: string }[];
  latencyMs: number;
  topScore: number | null;
  /** The standalone question retrieval actually ran, when a follow-up was rewritten. Null otherwise. */
  rewrittenQuestion: string | null;
}

/**
 * Resolve the chat session for an ask, creating one when needed. A
 * client-supplied id is honored only if it belongs to this user AND
 * program — a leaked/tampered id can't attach one user's ask to
 * another's conversation, nor cross program scope. Anything unowned or
 * malformed falls through to a fresh session.
 */
async function resolveOrCreateSession(
  user: CurrentUser,
  programId: string,
  requested: string | undefined
): Promise<string> {
  if (requested) {
    const rows = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, requested),
          eq(chatSessions.userId, user.id),
          eq(chatSessions.programId, programId)
        )
      )
      .limit(1);
    if (rows[0]) return rows[0].id;
  }
  const inserted = await db
    .insert(chatSessions)
    .values({ programId, userId: user.id })
    .returning({ id: chatSessions.id });
  const id = inserted[0]?.id;
  if (!id) throw new Error("Failed to create chat session");
  return id;
}

/**
 * Auto-name a session from its opening exchange, detached from the
 * response path (the CSR already has their answer; a title is not worth
 * added latency mid-call). The `title IS NULL` guard makes it fire once —
 * later exchanges skip it, and a concurrent namer can't clobber a title.
 */
function scheduleSessionNaming(sessionId: string, question: string, answer: string): void {
  void (async () => {
    try {
      const rows = await db
        .select({ title: chatSessions.title })
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .limit(1);
      if (rows[0]?.title != null) return;
      const title = await nameSession({ question, answer });
      await db
        .update(chatSessions)
        .set({ title })
        .where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.title)));
    } catch (err) {
      console.warn(
        "[ask] session auto-name failed:",
        err instanceof Error ? err.message : err
      );
    }
  })();
}

/**
 * Resolve + authorize the effective program for an ask request. Returns
 * null after writing the HTTP error response, so callers just bail.
 */
async function resolveAskProgram(req: Request, res: Response): Promise<string | null> {
  const user = authedUser(req);
  // /ask is program-scoped: retrieval filters chunks by program_id.
  // For non-super_user the program is fixed (DB CHECK guarantees
  // non-null user.programId). For super_user it's resolved from the
  // X-Program-Id header; if absent or invalid, refuse rather than
  // silently broadening scope across all programs.
  const programId = await resolveEffectiveProgramId(user, req);
  if (programId === null) {
    res.status(400).json({
      error:
        "No program selected. Choose a program from the picker in the header to ask a question."
    });
    return null;
  }
  // Defense in depth: canAccessProgram is the single source of truth
  // for program scoping. A header-resolved id for super_user passes
  // by definition; a non-super_user with a tampered/leaked header is
  // already ignored upstream, so this check is belt-and-suspenders.
  if (!canAccessProgram(user, programId)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return programId;
}

/**
 * The ask pipeline, shared by the JSON and streaming endpoints. Stage
 * callbacks fire at real checkpoints (see AskStage).
 */
async function runAsk(
  question: string,
  user: CurrentUser,
  programId: string,
  sessionId: string,
  history: HistoryTurn[],
  onStage?: (stage: AskStage) => void
): Promise<AskResponse> {
  const t0 = Date.now();

  if (question.length > MAX_QUESTION_CHARS) {
    // Log as a refusal so ops sees these in query_log alongside real misses.
    // Truncate the stored question so a malicious 100MB POST doesn't bloat
    // the row.
    const latencyMs = Date.now() - t0;
    const inserted = await db
      .insert(queryLog)
      .values({
        programId,
        userId: user.id,
        sessionId,
        question: question.slice(0, MAX_QUESTION_CHARS),
        answer: TOO_LONG_TEXT,
        citedChunkIds: [],
        refused: true,
        latencyMs
      })
      .returning({ id: queryLog.id });
    // Keep the session at the top of history, but don't name it from an
    // over-long (likely junk) question — a real exchange names it later.
    await touchSession(sessionId);
    return {
      queryLogId: inserted[0]?.id ?? null,
      sessionId,
      answer: TOO_LONG_TEXT,
      sources: [],
      refused: true,
      confidence: "low",
      retrievedChunks: [],
      latencyMs,
      topScore: null,
      rewrittenQuestion: null
    };
  }

  const programRows = await db
    .select({ name: programs.name })
    .from(programs)
    .where(eq(programs.id, programId))
    .limit(1);
  const programName = programRows[0]?.name ?? "the program";

  // Follow-up rewriting: resolve conversational references into a
  // standalone question BEFORE retrieval. Passthrough (no LLM call, no
  // stage event) on the first turn. The ORIGINAL question is what gets
  // logged — it's what the CSR typed; the rewrite is surfaced on the
  // response for operator debugging.
  if (history.length > 0) onStage?.("rewriting");
  const rewrite = await rewriteFollowUp({ question, history });
  const searchQuestion = rewrite.standaloneQuestion;
  const rewrittenQuestion = searchQuestion !== question ? searchQuestion : null;

  onStage?.("searching");
  const retrieval = await retrieve(
    { programId, question: searchQuestion },
    { onRerankStart: () => onStage?.("reranking") }
  );

  if (!retrieval.refused) onStage?.("generating");
  const generation = await generateAnswer({
    programName,
    question: searchQuestion,
    chunks: retrieval.chunks,
    refusedByRetrieval: retrieval.refused
  });

  const latencyMs = Date.now() - t0;
  const cited = uniqueUuids(generation.payload.sources.map((s) => s.chunk_id));

  // Resolve each cited chunk to its owning document so the client can link
  // "read the full document" from receipts and citation panels. Program
  // scope is already guaranteed: every cited chunk came out of retrieval,
  // which filters on program_id.
  const docByChunkId = new Map<string, string>();
  if (cited.length > 0) {
    const chunkDocs = await db
      .select({ chunkId: chunks.id, documentId: documentVersions.documentId })
      .from(chunks)
      .innerJoin(documentVersions, eq(documentVersions.id, chunks.documentVersionId))
      .where(inArray(chunks.id, cited));
    for (const r of chunkDocs) {
      if (r.documentId) docByChunkId.set(r.chunkId, r.documentId);
    }
  }
  const linkedSources: LinkedSource[] = generation.payload.sources.map((s) => ({
    ...s,
    doc_id: docByChunkId.get(s.chunk_id) ?? null
  }));

  const inserted = await db
    .insert(queryLog)
    .values({
      programId,
      userId: user.id,
      sessionId,
      question,
      answer: generation.payload.answer,
      citedChunkIds: cited,
      refused: generation.payload.refused,
      latencyMs
    })
    .returning({ id: queryLog.id });

  await touchSession(sessionId);
  // Name the session from its first real exchange (no-op if already named).
  scheduleSessionNaming(sessionId, question, generation.payload.answer);

  return {
    queryLogId: inserted[0]?.id ?? null,
    sessionId,
    answer: generation.payload.answer,
    sources: linkedSources,
    refused: generation.payload.refused,
    confidence: generation.payload.confidence,
    retrievedChunks: retrieval.chunks.map((c) => ({
      id: c.id,
      content: c.content,
      docTitle: c.docTitle
    })),
    latencyMs,
    topScore: retrieval.topScore,
    rewrittenQuestion
  };
}

/** Bump updated_at so the session sorts to the top of history. */
async function touchSession(sessionId: string): Promise<void> {
  await db
    .update(chatSessions)
    .set({ updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId));
}

askRouter.post("/ask", async (req, res, next) => {
  try {
    const parsed = AskBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const question = parsed.data.question.trim();
    const user = authedUser(req);
    const programId = await resolveAskProgram(req, res);
    if (programId === null) return;
    const sessionId = await resolveOrCreateSession(user, programId, parsed.data.sessionId);

    res.json(await runAsk(question, user, programId, sessionId, parsed.data.history ?? []));
  } catch (err) {
    next(err);
  }
});

/**
 * Streaming variant: NDJSON stage events at real pipeline checkpoints,
 * then the complete answer atomically in a final "result" event. No token
 * streaming, per the retrieval contract — CSRs need the whole answer
 * before they speak. The chat UI uses this; /ask stays for programmatic
 * callers.
 */
askRouter.post("/ask/stream", async (req, res, next) => {
  try {
    const parsed = AskBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const question = parsed.data.question.trim();
    const user = authedUser(req);
    const programId = await resolveAskProgram(req, res);
    if (programId === null) return;
    // Resolve the session BEFORE streaming starts so a failure here is a
    // clean pre-stream error, not a mid-stream break.
    const sessionId = await resolveOrCreateSession(user, programId, parsed.data.sessionId);

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    // Disable proxy buffering (nginx and friends) so stage events reach
    // the browser as they happen rather than in one flush at the end.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event: object): void => {
      res.write(`${JSON.stringify(event)}\n`);
    };

    try {
      const result = await runAsk(question, user, programId, sessionId, parsed.data.history ?? [], (stage) =>
        send({ type: "stage", stage })
      );
      send({ type: "result", result });
    } catch (err) {
      // Headers are already sent; deliver the error in-band.
      send({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to answer"
      });
    } finally {
      res.end();
    }
  } catch (err) {
    next(err);
  }
});

const FeedbackBody = z.object({
  queryLogId: z.string().uuid(),
  feedback: z.union([z.literal(-1), z.literal(0), z.literal(1)])
});

/**
 * Load a query_log row and check the caller may write to it. Programs are
 * a security boundary — a CSR may only touch their own program's queries.
 * Super users may touch any program's row (intentionally): these are
 * low-stakes writes, and a super_user who just switched the picker away
 * from program A should still be able to act on an answer they received
 * on program A. canAccessProgram-style scoping would either over-restrict
 * or be equivalent (super_user always passes), so a plain role check is
 * simpler and easier to audit.
 */
async function canWriteQueryLogRow(
  user: CurrentUser,
  queryLogId: string
): Promise<boolean> {
  const rows = await db
    .select({ programId: queryLog.programId })
    .from(queryLog)
    .where(eq(queryLog.id, queryLogId))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  return user.role === "super_user" || row.programId === user.programId;
}

askRouter.post("/feedback", async (req, res, next) => {
  try {
    const parsed = FeedbackBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const { queryLogId, feedback } = parsed.data;
    const user = authedUser(req);
    if (!(await canWriteQueryLogRow(user, queryLogId))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await db.update(queryLog).set({ feedback }).where(eq(queryLog.id, queryLogId));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const FlagMissingBody = z.object({
  queryLogId: z.string().uuid()
});

/**
 * CSR marks a refusal as "the knowledge base should have had this."
 * Feeds the admin content-gaps queue (Phase B reads query_log rows where
 * flagged_missing = true). One-way: the UI never un-flags, so this only
 * sets true.
 */
askRouter.post("/flag-missing", async (req, res, next) => {
  try {
    const parsed = FlagMissingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const { queryLogId } = parsed.data;
    const user = authedUser(req);
    if (!(await canWriteQueryLogRow(user, queryLogId))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await db
      .update(queryLog)
      .set({ flaggedMissing: true })
      .where(eq(queryLog.id, queryLogId));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
