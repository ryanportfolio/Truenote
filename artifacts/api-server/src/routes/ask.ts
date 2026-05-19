import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../lib/db-client.js";
import { programs, queryLog } from "@workspace/db/schema";
import { retrieve } from "../lib/retrieval/query.js";
import { generateAnswer, type Source } from "../lib/generation/answer.js";
import {
  authedUser,
  requireAuth,
  requireCsrOrAbove,
  requireFreshPassword
} from "../middleware/current-user.js";
import { resolveEffectiveProgramId } from "../lib/auth/effective-program.js";
import { canAccessProgram } from "../lib/auth/current-user.js";

export const askRouter = Router();

// Both /ask and /feedback require a logged-in user (any role) and a fresh
// password. Super users without a program selected can't /ask in 2A;
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
  question: z.string().min(1)
});

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
      return;
    }
    // Defense in depth: canAccessProgram is the single source of truth
    // for program scoping. A header-resolved id for super_user passes
    // by definition; a non-super_user with a tampered/leaked header is
    // already ignored upstream, so this check is belt-and-suspenders.
    if (!canAccessProgram(user, programId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
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
      const response: AskResponse = {
        queryLogId: inserted[0]?.id ?? null,
        answer: TOO_LONG_TEXT,
        sources: [],
        refused: true,
        confidence: "low",
        retrievedChunks: [],
        latencyMs,
        topScore: null
      };
      res.json(response);
      return;
    }

    const programRows = await db
      .select({ name: programs.name })
      .from(programs)
      .where(eq(programs.id, programId))
      .limit(1);
    const programName = programRows[0]?.name ?? "the program";

    const retrieval = await retrieve({ programId, question });
    const generation = await generateAnswer({
      programName,
      question,
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

    const response: AskResponse = {
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
      topScore: retrieval.topScore
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

const FeedbackBody = z.object({
  queryLogId: z.string().uuid(),
  feedback: z.union([z.literal(-1), z.literal(0), z.literal(1)])
});

askRouter.post("/feedback", async (req, res, next) => {
  try {
    const parsed = FeedbackBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const { queryLogId, feedback } = parsed.data;
    const user = authedUser(req);

    // Programs are a security boundary — a CSR may only update feedback on
    // their own program's queries. Super users with no program can act
    // across programs (and the row.programId check is bypassed below).
    const rows = await db
      .select({ programId: queryLog.programId })
      .from(queryLog)
      .where(eq(queryLog.id, queryLogId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (user.role !== "super_user" && row.programId !== user.programId) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await db.update(queryLog).set({ feedback }).where(eq(queryLog.id, queryLogId));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
