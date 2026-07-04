import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../lib/db-client.js";
import { programs, queryLog } from "@workspace/db/schema";
import { retrieve } from "../lib/retrieval/query.js";
import { generateAnswer, type Source } from "../lib/generation/answer.js";
import { rewriteFollowUp, type HistoryTurn } from "../lib/generation/rewrite.js";
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
    .optional()
});

/**
 * Pipeline stages surfaced to a waiting client. These are REAL checkpoints,
 * not timed guesses — the UI's wait-state honesty depends on that.
 * "rewriting" fires only on follow-ups (history present), "searching"
 * covers embed + hybrid search, "reranking" the Cohere pass, "generating"
 * the LLM call.
 */
export type AskStage = "rewriting" | "searching" | "reranking" | "generating";

export interface AskResponse {
  queryLogId: string | null;
  answer: string;
  sources: Source[];
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
        question: question.slice(0, MAX_QUESTION_CHARS),
        answer: TOO_LONG_TEXT,
        citedChunkIds: [],
        refused: true,
        latencyMs
      })
      .returning({ id: queryLog.id });
    return {
      queryLogId: inserted[0]?.id ?? null,
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

  const inserted = await db
    .insert(queryLog)
    .values({
      programId,
      userId: user.id,
      question,
      answer: generation.payload.answer,
      citedChunkIds: cited,
      refused: generation.payload.refused,
      latencyMs
    })
    .returning({ id: queryLog.id });

  return {
    queryLogId: inserted[0]?.id ?? null,
    answer: generation.payload.answer,
    sources: generation.payload.sources,
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

    res.json(await runAsk(question, user, programId, parsed.data.history ?? []));
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
      const result = await runAsk(question, user, programId, parsed.data.history ?? [], (stage) =>
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
