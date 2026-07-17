import { Router, type Request, type Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { documents, evalQuestions } from "@workspace/db/schema";
import { db } from "../../lib/db-client.js";
import { resolveEffectiveProgramId } from "../../lib/auth/effective-program.js";
import {
  authedUser,
  blockDemoWrites,
  requireAuth,
  requireFreshPassword,
  requireSuperUser
} from "../../middleware/current-user.js";
import {
  enqueueEvalRun,
  reconcileQueuedEvalRuns
} from "../../lib/eval/queue.js";
import { loadEvalQuestions } from "../../lib/eval/runner.js";
import {
  cancelEvalRun,
  createEvalRun,
  failStaleEvalRuns,
  getEvalRunDetail,
  isEvalPersistenceReady,
  isMissingEvalRunsTable,
  isUniqueViolation,
  listEvalRuns,
  setEvalRunBaseline,
  type EvalRunListItem
} from "../../lib/eval/persistence.js";
import { recordAppError } from "../../lib/observability/error-log.js";
import { workloadRateLimitMiddleware } from "../../middleware/workload-rate-limit.js";

export const evaluationsRouter = Router();

evaluationsRouter.use(
  requireAuth,
  requireFreshPassword,
  requireSuperUser,
  blockDemoWrites
);

const Uuid = z.string().uuid();
const Phrase = z.string().trim().min(1).max(500);

export const EvalQuestionBody = z
  .object({
    kind: z.enum(["in-kb", "out-of-kb"]),
    question: z.string().trim().min(1).max(2000),
    expectedDocId: Uuid.nullable().optional(),
    expectedAnswerContains: z.array(Phrase).max(20).default([]),
    notes: z.string().trim().max(2000).nullable().optional()
  })
  .superRefine((value, context) => {
    if (
      value.kind === "in-kb" &&
      !value.expectedDocId &&
      value.expectedAnswerContains.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An in-KB question needs an expected document or phrase",
        path: ["expectedAnswerContains"]
      });
    }
  });

const RunBody = z.object({
  judge: z.boolean().default(false),
  questionId: Uuid.optional()
});

const RunListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

const IdParams = z.object({ id: Uuid });
const MAX_QUESTIONS_PER_RUN = 250;

export interface EvalQuestionItem {
  id: string;
  programId: string;
  question: string;
  kind: "in-kb" | "out-of-kb";
  expectedDocId: string | null;
  expectedDocTitle: string | null;
  expectedAnswerContains: string[];
  notes: string | null;
  createdAt: string | null;
}

function normalizePhrases(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function questionKind(input: {
  expectedDocId: string | null;
  expectedAnswerContains: string[] | null;
}): "in-kb" | "out-of-kb" {
  return input.expectedDocId || (input.expectedAnswerContains?.length ?? 0) > 0
    ? "in-kb"
    : "out-of-kb";
}

function mapQuestion(row: {
  id: string;
  programId: string | null;
  question: string;
  expectedDocId: string | null;
  expectedDocTitle: string | null;
  expectedAnswerContains: string[] | null;
  notes: string | null;
  createdAt: Date | null;
}): EvalQuestionItem {
  return {
    id: row.id,
    // Every row returned by these routes is filtered to a non-null selected
    // program. Keeping the fallback defensive avoids a raw null in JSON if a
    // legacy row violates that contract.
    programId: row.programId ?? "",
    question: row.question,
    kind: questionKind(row),
    expectedDocId: row.expectedDocId,
    expectedDocTitle: row.expectedDocTitle,
    expectedAnswerContains: row.expectedAnswerContains ?? [],
    notes: row.notes,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null
  };
}

async function effectiveProgram(req: Request): Promise<string | null> {
  return resolveEffectiveProgramId(authedUser(req), req);
}

function requireSelectedProgram(
  programId: string | null,
  res: Response
): programId is string {
  if (programId !== null) return true;
  res.status(400).json({
    error: "No program selected. Choose a program from the picker in the header."
  });
  return false;
}

async function expectedDocumentTitle(
  programId: string,
  documentId: string | null
): Promise<{ valid: boolean; title: string | null }> {
  if (!documentId) return { valid: true, title: null };
  const rows = await db
    .select({ title: documents.title })
    .from(documents)
    .where(
      and(eq(documents.id, documentId), eq(documents.programId, programId))
    )
    .limit(1);
  return rows[0]
    ? { valid: true, title: rows[0].title }
    : { valid: false, title: null };
}

evaluationsRouter.get("/questions", async (req, res, next) => {
  try {
    const programId = await effectiveProgram(req);
    if (programId === null) {
      res.json({ items: [], noProgramSelected: true });
      return;
    }
    const rows = await db
      .select({
        id: evalQuestions.id,
        programId: evalQuestions.programId,
        question: evalQuestions.question,
        expectedDocId: evalQuestions.expectedDocId,
        expectedDocTitle: documents.title,
        expectedAnswerContains: evalQuestions.expectedAnswerContains,
        notes: evalQuestions.notes,
        createdAt: evalQuestions.createdAt
      })
      .from(evalQuestions)
      .leftJoin(
        documents,
        and(
          eq(documents.id, evalQuestions.expectedDocId),
          eq(documents.programId, programId)
        )
      )
      .where(eq(evalQuestions.programId, programId))
      .orderBy(asc(evalQuestions.createdAt), asc(evalQuestions.id));
    res.json({ items: rows.map(mapQuestion) });
  } catch (error) {
    next(error);
  }
});

evaluationsRouter.post("/questions", async (req, res, next) => {
  try {
    const parsed = EvalQuestionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid evaluation question" });
      return;
    }
    const programId = await effectiveProgram(req);
    if (!requireSelectedProgram(programId, res)) return;
    const expectedDocId =
      parsed.data.kind === "in-kb" ? (parsed.data.expectedDocId ?? null) : null;
    const expectedAnswerContains =
      parsed.data.kind === "in-kb"
        ? normalizePhrases(parsed.data.expectedAnswerContains)
        : [];
    const expectedDocument = await expectedDocumentTitle(programId, expectedDocId);
    if (!expectedDocument.valid) {
      res.status(400).json({
        error: "Expected document must belong to the selected program"
      });
      return;
    }
    const inserted = await db
      .insert(evalQuestions)
      .values({
        programId,
        question: parsed.data.question,
        expectedDocId,
        expectedAnswerContains,
        notes: parsed.data.notes || null
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      res.status(500).json({ error: "Failed to create evaluation question" });
      return;
    }
    res.status(201).json({
      item: mapQuestion({
        ...row,
        expectedDocTitle: expectedDocument.title
      })
    });
  } catch (error) {
    next(error);
  }
});

evaluationsRouter.put("/questions/:id", async (req, res, next) => {
  try {
    const params = IdParams.safeParse(req.params);
    const parsed = EvalQuestionBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid evaluation question" });
      return;
    }
    const programId = await effectiveProgram(req);
    if (!requireSelectedProgram(programId, res)) return;
    const existing = await db
      .select({ id: evalQuestions.id })
      .from(evalQuestions)
      .where(
        and(
          eq(evalQuestions.id, params.data.id),
          eq(evalQuestions.programId, programId)
        )
      )
      .limit(1);
    if (!existing[0]) {
      res.status(404).json({ error: "Evaluation question not found" });
      return;
    }
    const expectedDocId =
      parsed.data.kind === "in-kb" ? (parsed.data.expectedDocId ?? null) : null;
    const expectedAnswerContains =
      parsed.data.kind === "in-kb"
        ? normalizePhrases(parsed.data.expectedAnswerContains)
        : [];
    const expectedDocument = await expectedDocumentTitle(programId, expectedDocId);
    if (!expectedDocument.valid) {
      res.status(400).json({
        error: "Expected document must belong to the selected program"
      });
      return;
    }
    const updated = await db
      .update(evalQuestions)
      .set({
        question: parsed.data.question,
        expectedDocId,
        expectedAnswerContains,
        notes: parsed.data.notes || null
      })
      .where(
        and(
          eq(evalQuestions.id, params.data.id),
          eq(evalQuestions.programId, programId)
        )
      )
      .returning();
    const row = updated[0];
    if (!row) {
      res.status(404).json({ error: "Evaluation question not found" });
      return;
    }
    res.json({
      item: mapQuestion({
        ...row,
        expectedDocTitle: expectedDocument.title
      })
    });
  } catch (error) {
    next(error);
  }
});

evaluationsRouter.delete("/questions/:id", async (req, res, next) => {
  try {
    const params = IdParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid question id" });
      return;
    }
    const programId = await effectiveProgram(req);
    if (!requireSelectedProgram(programId, res)) return;
    const deleted = await db
      .delete(evalQuestions)
      .where(
        and(
          eq(evalQuestions.id, params.data.id),
          eq(evalQuestions.programId, programId)
        )
      )
      .returning({ id: evalQuestions.id });
    if (!deleted[0]) {
      res.status(404).json({ error: "Evaluation question not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

evaluationsRouter.get("/runs", async (req, res, next) => {
  try {
    const parsed = RunListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters" });
      return;
    }
    const programId = await effectiveProgram(req);
    if (programId === null) {
      res.json({
        persistenceReady: await isEvalPersistenceReady(),
        items: [],
        noProgramSelected: true
      });
      return;
    }
    try {
      await failStaleEvalRuns(programId);
      await reconcileQueuedEvalRuns(programId).catch((error: unknown) => {
        console.warn(
          "[evaluations] queued-run reconciliation failed:",
          error instanceof Error ? error.message : error
        );
        void recordAppError({
          severity: "warning",
          source: "evaluation",
          operation: "request-reconciliation",
          error,
          programId
        });
      });
      const items = await listEvalRuns(programId, parsed.data.limit);
      res.json({ persistenceReady: true, items });
    } catch (error) {
      if (isMissingEvalRunsTable(error)) {
        res.json({ persistenceReady: false, items: [] });
        return;
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

evaluationsRouter.post("/runs", workloadRateLimitMiddleware("evaluation_run"), async (req, res, next) => {
  try {
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid evaluation run request" });
      return;
    }
    const programId = await effectiveProgram(req);
    if (!requireSelectedProgram(programId, res)) return;

    const questionSnapshot = await loadEvalQuestions({
      programId,
      ...(parsed.data.questionId ? { questionId: parsed.data.questionId } : {})
    });
    const questionCount = questionSnapshot.length;
    if (questionCount === 0) {
      res.status(parsed.data.questionId ? 404 : 409).json({
        error: parsed.data.questionId
          ? "Evaluation question not found"
          : "Add at least one evaluation question before starting a run"
      });
      return;
    }
    if (questionCount > MAX_QUESTIONS_PER_RUN) {
      res.status(409).json({
        error: `A run is limited to ${MAX_QUESTIONS_PER_RUN} questions. Run one question or trim the set first.`
      });
      return;
    }

    let item: EvalRunListItem;
    try {
      await failStaleEvalRuns(programId);
      item = await createEvalRun({
        programId,
        requestedBy: authedUser(req).id,
        questionId: parsed.data.questionId ?? null,
        judge: parsed.data.judge,
        questionCount,
        questionSnapshot
      });
    } catch (error) {
      if (isMissingEvalRunsTable(error)) {
        res.status(503).json({
          error: "Evaluation run storage is not installed yet",
          code: "eval_storage_missing"
        });
        return;
      }
      if (isUniqueViolation(error)) {
        res.status(409).json({
          error: "An evaluation is already running for this program"
        });
        return;
      }
      throw error;
    }

    try {
      // null means this run was already sent in the reconciliation window by a
      // concurrent request; that is an accepted, idempotent outcome.
      await enqueueEvalRun(item.id);
    } catch (error) {
      // A broker send error can be ambiguous: the job may have been accepted
      // before the response failed. Keep the durable queued row intact so
      // reconciliation can safely resend it instead of racing a live claim.
      console.error(
        `[evaluations] failed to enqueue run ${item.id}:`,
        error instanceof Error ? error.message : error
      );
      void recordAppError({
        source: "evaluation",
        operation: "enqueue-run",
        error,
        programId,
        context: { runId: item.id }
      });
      res.status(202).json({
        item,
        warning: "Evaluation is queued; worker handoff will retry automatically.",
        code: "eval_queue_pending"
      });
      return;
    }
    res.status(202).json({ item });
  } catch (error) {
    next(error);
  }
});

evaluationsRouter.get("/runs/:id", async (req, res, next) => {
  try {
    const params = IdParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid run id" });
      return;
    }
    const programId = await effectiveProgram(req);
    if (!requireSelectedProgram(programId, res)) return;
    try {
      const detail = await getEvalRunDetail(programId, params.data.id);
      if (!detail) {
        res.status(404).json({ error: "Evaluation run not found" });
        return;
      }
      res.json(detail);
    } catch (error) {
      if (isMissingEvalRunsTable(error)) {
        res.status(503).json({
          error: "Evaluation run storage is not installed yet",
          code: "eval_storage_missing"
        });
        return;
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

evaluationsRouter.post("/runs/:id/cancel", async (req, res, next) => {
  try {
    const params = IdParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid run id" });
      return;
    }
    const programId = await effectiveProgram(req);
    if (!requireSelectedProgram(programId, res)) return;
    try {
      const item = await cancelEvalRun(programId, params.data.id);
      if (item) {
        res.json({ item });
        return;
      }
      const existing = await getEvalRunDetail(programId, params.data.id);
      if (!existing) {
        res.status(404).json({ error: "Evaluation run not found" });
        return;
      }
      res.status(409).json({ error: "Only a queued or running evaluation can be cancelled" });
    } catch (error) {
      if (isMissingEvalRunsTable(error)) {
        res.status(503).json({
          error: "Evaluation run storage is not installed yet",
          code: "eval_storage_missing"
        });
        return;
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

evaluationsRouter.post("/runs/:id/baseline", async (req, res, next) => {
  try {
    const params = IdParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid run id" });
      return;
    }
    const programId = await effectiveProgram(req);
    if (!requireSelectedProgram(programId, res)) return;
    try {
      const result = await setEvalRunBaseline(programId, params.data.id);
      if (result.outcome === "not-found") {
        res.status(404).json({ error: "Evaluation run not found" });
        return;
      }
      if (result.outcome === "not-completed") {
        res.status(409).json({ error: "Only a completed run can be the baseline" });
        return;
      }
      res.json({ item: result.item });
    } catch (error) {
      if (isMissingEvalRunsTable(error)) {
        res.status(503).json({
          error: "Evaluation run storage is not installed yet",
          code: "eval_storage_missing"
        });
        return;
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});
