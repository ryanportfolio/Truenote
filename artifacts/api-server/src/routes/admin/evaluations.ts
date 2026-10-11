import { Router, type Request, type Response } from "express";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
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
  QuestionDraftUnavailableError,
  draftQuestionsWithChain,
  loadDocumentExcerpts,
  loadQuestionSuggestions
} from "../../lib/eval/question-sources.js";
import { evalQuestionDraftLimit } from "../../lib/security/route-rate-limit.js";
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
    notes: z.string().trim().max(2000).nullable().optional(),
    expectedAnswer: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional()
      .transform((value) => (value ? value : null)),
    isProtected: z.boolean().optional()
  })
  .superRefine((value, context) => {
    if (
      value.kind === "in-kb" &&
      !value.expectedDocId &&
      value.expectedAnswerContains.length === 0 &&
      !value.expectedAnswer
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An in-KB question needs an expected source, phrase, or answer",
        path: ["expectedAnswerContains"]
      });
    }
  });

type EvalQuestionInput = z.infer<typeof EvalQuestionBody>;

const BulkQuestionsBody = z.object({
  items: z.array(z.unknown()).min(1).max(100)
});

const SuggestionsQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30)
});

const DraftBody = z.object({
  documentId: Uuid,
  count: z.number().int().min(1).max(10).default(5)
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
  expectedAnswer: string | null;
  isProtected: boolean;
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
  expectedAnswer: string | null;
}): "in-kb" | "out-of-kb" {
  return input.expectedDocId ||
    (input.expectedAnswerContains?.length ?? 0) > 0 ||
    input.expectedAnswer
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
}, extras: QuestionExtras | undefined): EvalQuestionItem {
  const expectedAnswer = extras?.expectedAnswer ?? null;
  return {
    id: row.id,
    // Every row returned by these routes is filtered to a non-null selected
    // program. Keeping the fallback defensive avoids a raw null in JSON if a
    // legacy row violates that contract.
    programId: row.programId ?? "",
    question: row.question,
    kind: questionKind({ ...row, expectedAnswer }),
    expectedDocId: row.expectedDocId,
    expectedDocTitle: row.expectedDocTitle,
    expectedAnswerContains: row.expectedAnswerContains ?? [],
    notes: row.notes,
    expectedAnswer,
    isProtected: extras?.isProtected ?? false,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null
  };
}

// expected_answer and is_protected are added by raw DDL and stay unbound in
// Drizzle (like the runner's is_protected read). These helpers read and write
// them only when the column exists, so a deployment ahead of its SQL file
// keeps working.
interface QuestionExtras {
  expectedAnswer: string | null;
  isProtected: boolean;
}

interface QuestionExtraColumns {
  expectedAnswer: boolean;
  isProtected: boolean;
}

const COLUMN_CHECK_TTL_MS = 60_000;
let columnCheck: { at: number; columns: QuestionExtraColumns } | null = null;

const EXPECTED_ANSWER_COLUMN_MISSING =
  "Expected answers need a database update first (lib/db/sql/0021_eval_expected_answer.sql).";

async function questionExtraColumns(): Promise<QuestionExtraColumns> {
  if (columnCheck && Date.now() - columnCheck.at < COLUMN_CHECK_TTL_MS) {
    return columnCheck.columns;
  }
  const result = await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'eval_questions'
      AND column_name IN ('expected_answer', 'is_protected')
  `);
  const names = new Set(
    (result.rows as Array<{ column_name: string }>).map((row) => row.column_name)
  );
  const columns = {
    expectedAnswer: names.has("expected_answer"),
    isProtected: names.has("is_protected")
  };
  columnCheck = { at: Date.now(), columns };
  return columns;
}

/** PostgreSQL undefined_column (42703), including driver-wrapped errors. */
function isUndefinedColumn(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      (current as { code?: unknown }).code === "42703"
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return false;
}

async function loadQuestionExtras(
  programId: string,
  ids?: string[]
): Promise<Map<string, QuestionExtras>> {
  const out = new Map<string, QuestionExtras>();
  if (ids && ids.length === 0) return out;
  const columns = await questionExtraColumns();
  if (!columns.expectedAnswer && !columns.isProtected) return out;
  const idFilter = ids
    ? sql` AND id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `
      )})`
    : sql``;
  try {
    const result = await db.execute(sql`
      SELECT id::text AS id,
             ${columns.expectedAnswer ? sql`expected_answer` : sql`NULL::text`} AS expected_answer,
             ${columns.isProtected ? sql`is_protected` : sql`false`} AS is_protected
      FROM eval_questions
      WHERE program_id = ${programId}::uuid${idFilter}
    `);
    for (const row of result.rows as Array<{
      id: string;
      expected_answer: string | null;
      is_protected: unknown;
    }>) {
      out.set(row.id, {
        expectedAnswer: row.expected_answer ?? null,
        isProtected: row.is_protected === true
      });
    }
  } catch (error) {
    if (!isUndefinedColumn(error)) throw error;
    columnCheck = null;
  }
  return out;
}

/**
 * Write expected_answer (always, when the column exists) and is_protected
 * (only when given and the column exists) for one question.
 */
async function writeQuestionExtras(
  programId: string,
  id: string,
  values: { expectedAnswer: string | null; isProtected: boolean | undefined },
  columns: QuestionExtraColumns
): Promise<void> {
  const sets: SQL[] = [];
  if (columns.expectedAnswer) {
    sets.push(sql`expected_answer = ${values.expectedAnswer}`);
  }
  if (columns.isProtected && values.isProtected !== undefined) {
    sets.push(sql`is_protected = ${values.isProtected}`);
  }
  if (sets.length === 0) return;
  await db.execute(sql`
    UPDATE eval_questions
    SET ${sql.join(sets, sql`, `)}
    WHERE id = ${id}::uuid AND program_id = ${programId}::uuid
  `);
}

function normalizedExpectations(data: EvalQuestionInput): {
  expectedDocId: string | null;
  expectedAnswerContains: string[];
  expectedAnswer: string | null;
} {
  const inKb = data.kind === "in-kb";
  return {
    expectedDocId: inKb ? (data.expectedDocId ?? null) : null,
    expectedAnswerContains: inKb
      ? normalizePhrases(data.expectedAnswerContains)
      : [],
    expectedAnswer: inKb ? (data.expectedAnswer ?? null) : null
  };
}

type CreateQuestionOutcome =
  | { ok: true; item: EvalQuestionItem }
  | { ok: false; status: number; error: string };

/** Validate references and insert one question in the selected program. */
async function createQuestion(
  programId: string,
  data: EvalQuestionInput
): Promise<CreateQuestionOutcome> {
  const expectations = normalizedExpectations(data);
  const columns = await questionExtraColumns();
  if (expectations.expectedAnswer && !columns.expectedAnswer) {
    return { ok: false, status: 409, error: EXPECTED_ANSWER_COLUMN_MISSING };
  }
  const expectedDocument = await expectedDocumentTitle(
    programId,
    expectations.expectedDocId
  );
  if (!expectedDocument.valid) {
    return {
      ok: false,
      status: 400,
      error: "Expected document must belong to the selected program"
    };
  }
  const inserted = await db
    .insert(evalQuestions)
    .values({
      programId,
      question: data.question,
      expectedDocId: expectations.expectedDocId,
      expectedAnswerContains: expectations.expectedAnswerContains,
      notes: data.notes || null
    })
    .returning();
  const row = inserted[0];
  if (!row) {
    return {
      ok: false,
      status: 500,
      error: "Failed to create evaluation question"
    };
  }
  const isProtected = data.isProtected ?? false;
  await writeQuestionExtras(
    programId,
    row.id,
    { expectedAnswer: expectations.expectedAnswer, isProtected },
    columns
  );
  return {
    ok: true,
    item: mapQuestion(
      { ...row, expectedDocTitle: expectedDocument.title },
      {
        expectedAnswer: columns.expectedAnswer ? expectations.expectedAnswer : null,
        isProtected: columns.isProtected ? isProtected : false
      }
    )
  };
}

function questionBodyError(error: z.ZodError): string {
  return (
    error.issues.find((issue) => issue.code === z.ZodIssueCode.custom)?.message ??
    "Invalid evaluation question"
  );
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
    const extras = await loadQuestionExtras(programId);
    const columns = await questionExtraColumns();
    res.json({
      items: rows.map((row) => mapQuestion(row, extras.get(row.id))),
      expectedAnswerReady: columns.expectedAnswer
    });
  } catch (error) {
    next(error);
  }
});

evaluationsRouter.get("/questions/suggestions", async (req, res, next) => {
  try {
    const parsed = SuggestionsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters" });
      return;
    }
    const programId = await effectiveProgram(req);
    if (!requireSelectedProgram(programId, res)) return;
    const items = await loadQuestionSuggestions(programId, parsed.data.days);
    res.json({ items });
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
    const outcome = await createQuestion(programId, parsed.data);
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    res.status(201).json({ item: outcome.item });
  } catch (error) {
    next(error);
  }
});

evaluationsRouter.post("/questions/bulk", async (req, res, next) => {
  try {
    const parsed = BulkQuestionsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Send between 1 and 100 questions" });
      return;
    }
    const programId = await effectiveProgram(req);
    if (!requireSelectedProgram(programId, res)) return;
    const created: EvalQuestionItem[] = [];
    const errors: Array<{ index: number; error: string }> = [];
    for (const [index, raw] of parsed.data.items.entries()) {
      const item = EvalQuestionBody.safeParse(raw);
      if (!item.success) {
        errors.push({ index, error: questionBodyError(item.error) });
        continue;
      }
      const outcome = await createQuestion(programId, item.data);
      if (outcome.ok) created.push(outcome.item);
      else errors.push({ index, error: outcome.error });
    }
    res.json({ created, errors });
  } catch (error) {
    next(error);
  }
});

evaluationsRouter.post(
  "/questions/draft",
  evalQuestionDraftLimit,
  async (req, res, next) => {
    try {
      const parsed = DraftBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid draft request" });
        return;
      }
      const programId = await effectiveProgram(req);
      if (!requireSelectedProgram(programId, res)) return;
      const { documentId, count } = parsed.data;
      const source = await expectedDocumentTitle(programId, documentId);
      if (!source.valid) {
        res.status(404).json({ error: "Source not found in this program" });
        return;
      }
      const documentTitle = source.title ?? "";
      const excerpts = await loadDocumentExcerpts(programId, documentId);
      if (!excerpts) {
        // No processed text on the current version: no model call can draft
        // from it.
        res.status(503).json({ error: "Drafting failed. Try again." });
        return;
      }
      let drafted;
      try {
        drafted = await draftQuestionsWithChain({
          programId,
          documentTitle,
          excerpts,
          count
        });
      } catch (error) {
        if (error instanceof QuestionDraftUnavailableError) {
          res.status(503).json({ error: "Drafting failed. Try again." });
          return;
        }
        throw error;
      }
      res.json({
        items: drafted.map((item) => ({
          question: item.question,
          expectedAnswer: item.expectedAnswer,
          expectedDocId: documentId,
          expectedDocTitle: source.title
        }))
      });
    } catch (error) {
      next(error);
    }
  }
);

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
    const expectations = normalizedExpectations(parsed.data);
    const columns = await questionExtraColumns();
    if (expectations.expectedAnswer && !columns.expectedAnswer) {
      res.status(409).json({ error: EXPECTED_ANSWER_COLUMN_MISSING });
      return;
    }
    const expectedDocument = await expectedDocumentTitle(
      programId,
      expectations.expectedDocId
    );
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
        expectedDocId: expectations.expectedDocId,
        expectedAnswerContains: expectations.expectedAnswerContains,
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
    await writeQuestionExtras(
      programId,
      row.id,
      {
        expectedAnswer: expectations.expectedAnswer,
        isProtected: parsed.data.isProtected
      },
      columns
    );
    const extras = await loadQuestionExtras(programId, [row.id]);
    res.json({
      item: mapQuestion(
        { ...row, expectedDocTitle: expectedDocument.title },
        extras.get(row.id)
      )
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
