import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db-client.js";
import type {
  EvalQuestionDefinition,
  EvalReport,
  EvalSummary
} from "./runner.js";

export type EvalRunStatus = "queued" | "running" | "completed" | "failed";

export interface EvalRunConfiguration {
  judge: boolean;
  /** Hash of the exact question + expectation definitions in the completed report. */
  questionSetHash: string | null;
  generation: {
    id: string;
    label: string;
    model: string;
    providerLabel: string;
  };
  /** Ordered OpenRouter chain pinned for this run; absent on legacy runs. */
  routeChain?: Array<{
    id: string;
    label: string;
    model: string;
    providerLabel: string;
  }>;
  /** Legacy direct backup snapshot; absent on ZDR-only runs. */
  fallback?: {
    label: string;
    model: string;
    providerLabel: string;
  };
  retrieval: {
    topK: number;
    candidateK: number;
    threshold: number;
    neighborAnchors: number;
    rerankModel: string;
  };
}

export interface EvalRunListItem {
  id: string;
  status: EvalRunStatus;
  questionId: string | null;
  judge: boolean;
  questionCount: number;
  completedQuestions: number;
  configuration: EvalRunConfiguration | null;
  summary: EvalSummary | null;
  error: string | null;
  isBaseline: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EvalRunDetail {
  item: EvalRunListItem;
  report: EvalReport | null;
}

export interface WorkerEvalRun {
  id: string;
  programId: string;
  questionId: string | null;
  judge: boolean;
  questionSnapshot: EvalQuestionDefinition[];
  leaseToken: string;
}

interface EvalRunRow {
  id: string;
  status: EvalRunStatus;
  question_id: string | null;
  judge: boolean;
  question_count: number;
  completed_questions: number;
  configuration: unknown;
  summary: unknown;
  report?: unknown;
  error: string | null;
  is_baseline: boolean;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

function hasErrorCode(error: unknown, expected: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (code === expected) return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return false;
}

/** PostgreSQL undefined_table, including errors wrapped by Drizzle/pg. */
export function isMissingEvalRunsTable(error: unknown): boolean {
  return hasErrorCode(error, "42P01");
}

export function isUniqueViolation(error: unknown): boolean {
  return hasErrorCode(error, "23505");
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function configurationFrom(value: unknown): EvalRunConfiguration | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<EvalRunConfiguration>;
  if (!candidate.generation || !candidate.retrieval || !candidate.fallback) return null;
  return {
    ...(candidate as EvalRunConfiguration),
    questionSetHash:
      typeof candidate.questionSetHash === "string" ? candidate.questionSetHash : null
  };
}

function mapListItem(row: EvalRunRow): EvalRunListItem {
  return {
    id: row.id,
    status: row.status,
    questionId: row.question_id,
    judge: row.judge,
    questionCount: Number(row.question_count),
    completedQuestions: Number(row.completed_questions),
    configuration: configurationFrom(row.configuration),
    summary: (row.summary as EvalSummary | null) ?? null,
    error: row.error,
    isBaseline: row.is_baseline,
    createdAt: iso(row.created_at) as string,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at)
  };
}

const RUN_LIST_COLUMNS = sql`
  id,
  status,
  COALESCE(question_id::text, configuration ->> 'questionId') AS question_id,
  judge,
  question_count,
  completed_questions,
  configuration - 'questionSnapshot' - 'leaseToken' - 'brokerJobId' AS configuration,
  report -> 'summary' AS summary,
  error,
  is_baseline,
  created_at,
  started_at,
  finished_at
`;

/** Probe only the new table so pre-DDL deployments can render a setup state. */
export async function isEvalPersistenceReady(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1 FROM eval_runs LIMIT 0`);
    return true;
  } catch (error) {
    if (isMissingEvalRunsTable(error)) return false;
    throw error;
  }
}

/**
 * Age out only genuinely abandoned running work. Queued work is durable and
 * may legitimately wait behind other programs in the sequential worker.
 * Six hours leaves room for pg-boss's four-hour expiry and delayed retry to
 * reclaim the row before UI polling can declare it failed.
 */
export async function failStaleEvalRuns(programId: string): Promise<void> {
  await db.execute(sql`
    UPDATE eval_runs
    SET status = 'failed',
        error = 'Evaluation worker stopped before this run completed',
        finished_at = now(),
        updated_at = now()
    WHERE program_id = ${programId}::uuid
      AND status = 'running'
      AND updated_at < now() - interval '6 hours'
  `);
}

/** `eval_runs` doubles as an outbox for API crashes between insert and send. */
export async function listQueuedEvalRunIds(programId?: string): Promise<string[]> {
  const programCondition = programId
    ? sql`AND program_id = ${programId}::uuid`
    : sql``;
  const result = await db.execute(sql`
    SELECT id::text
    FROM eval_runs
    WHERE status = 'queued'
      ${programCondition}
    ORDER BY created_at, id
  `);
  return result.rows.map((row) => String(row["id"]));
}

export async function createEvalRun(input: {
  programId: string;
  requestedBy: string;
  questionId: string | null;
  judge: boolean;
  questionCount: number;
  questionSnapshot: EvalQuestionDefinition[];
}): Promise<EvalRunListItem> {
  const result = await db.execute(sql`
    INSERT INTO eval_runs (
      program_id,
      requested_by,
      status,
      question_id,
      judge,
      question_count,
      completed_questions,
      configuration
    )
    VALUES (
      ${input.programId}::uuid,
      ${input.requestedBy}::uuid,
      'queued',
      ${input.questionId}::uuid,
      ${input.judge},
      ${input.questionCount},
      0,
      ${JSON.stringify({
        judge: input.judge,
        questionId: input.questionId,
        questionSnapshot: input.questionSnapshot
      })}::jsonb
    )
    RETURNING ${RUN_LIST_COLUMNS}
  `);
  return mapListItem(result.rows[0] as unknown as EvalRunRow);
}

export async function listEvalRuns(
  programId: string,
  limit: number
): Promise<EvalRunListItem[]> {
  const result = await db.execute(sql`
    SELECT ${RUN_LIST_COLUMNS}
    FROM eval_runs
    WHERE program_id = ${programId}::uuid
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `);
  const items = (result.rows as unknown as EvalRunRow[]).map(mapListItem);
  if (items.some((item) => item.isBaseline)) return items;
  const baseline = await db.execute(sql`
    SELECT ${RUN_LIST_COLUMNS}
    FROM eval_runs
    WHERE program_id = ${programId}::uuid
      AND is_baseline = true
    LIMIT 1
  `);
  const row = baseline.rows[0] as unknown as EvalRunRow | undefined;
  return row ? [...items, mapListItem(row)] : items;
}

export async function getEvalRunDetail(
  programId: string,
  runId: string
): Promise<EvalRunDetail | null> {
  const result = await db.execute(sql`
    SELECT ${RUN_LIST_COLUMNS}, report
    FROM eval_runs
    WHERE id = ${runId}::uuid
      AND program_id = ${programId}::uuid
    LIMIT 1
  `);
  const row = result.rows[0] as unknown as EvalRunRow | undefined;
  if (!row) return null;
  return {
    item: mapListItem(row),
    report: (row.report as EvalReport | null) ?? null
  };
}

/**
 * Claim is idempotent. A retry may replace only the lease created by the same
 * broker job; a duplicate job cannot fence healthy work. Any job may recover a
 * genuinely stale four-hour lease.
 */
export async function claimEvalRun(
  runId: string,
  brokerJobId: string,
  brokerRetry = false
): Promise<WorkerEvalRun | null> {
  const leaseToken = randomUUID();
  const result = await db.execute(sql`
    UPDATE eval_runs
    SET status = 'running',
        started_at = now(),
        completed_questions = 0,
        error = NULL,
        configuration = configuration || ${JSON.stringify({
          leaseToken,
          brokerJobId
        })}::jsonb,
        updated_at = now()
    WHERE id = ${runId}::uuid
      AND (
        status = 'queued'
        OR (
          status = 'running'
          AND (
            updated_at < now() - interval '4 hours'
            OR (
              ${brokerRetry}
              AND configuration ->> 'brokerJobId' = ${brokerJobId}
            )
          )
        )
      )
    RETURNING
      id,
      program_id,
      COALESCE(question_id::text, configuration ->> 'questionId') AS effective_question_id,
      judge,
      configuration -> 'questionSnapshot' AS question_snapshot
  `);
  const row = result.rows[0] as
    | {
        id: string;
        program_id: string;
        effective_question_id: string | null;
        judge: boolean;
        question_snapshot: unknown;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        programId: row.program_id,
        questionId: row.effective_question_id,
        judge: row.judge,
        questionSnapshot: Array.isArray(row.question_snapshot)
          ? (row.question_snapshot as EvalQuestionDefinition[])
          : [],
        leaseToken
      }
    : null;
}

export async function setEvalRunConfiguration(
  runId: string,
  leaseToken: string,
  configuration: EvalRunConfiguration
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE eval_runs
    SET configuration = configuration || ${JSON.stringify(configuration)}::jsonb,
        updated_at = now()
    WHERE id = ${runId}::uuid
      AND status = 'running'
      AND configuration ->> 'leaseToken' = ${leaseToken}
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function updateEvalRunProgress(
  runId: string,
  leaseToken: string,
  completed: number,
  total: number
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE eval_runs
    SET completed_questions = ${completed},
        question_count = ${total},
        updated_at = now()
    WHERE id = ${runId}::uuid
      AND status = 'running'
      AND configuration ->> 'leaseToken' = ${leaseToken}
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function completeEvalRun(
  runId: string,
  leaseToken: string,
  report: EvalReport,
  configuration: EvalRunConfiguration
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE eval_runs
    SET status = 'completed',
        question_count = ${report.summary.totalQuestions},
        completed_questions = ${report.summary.totalQuestions},
        configuration = configuration || ${JSON.stringify(configuration)}::jsonb,
        report = ${JSON.stringify(report)}::jsonb,
        error = NULL,
        finished_at = now(),
        updated_at = now()
    WHERE id = ${runId}::uuid
      AND status = 'running'
      AND configuration ->> 'leaseToken' = ${leaseToken}
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function failEvalRun(
  runId: string,
  error: unknown,
  leaseToken?: string
): Promise<boolean> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const leaseCondition = leaseToken
    ? sql`AND configuration ->> 'leaseToken' = ${leaseToken}`
    : sql``;
  const result = await db.execute(sql`
    UPDATE eval_runs
    SET status = 'failed',
        error = ${message},
        finished_at = now(),
        updated_at = now()
    WHERE id = ${runId}::uuid
      AND status IN ('queued', 'running')
      ${leaseCondition}
    RETURNING id
  `);
  return result.rows.length > 0;
}

/** Fence queued/running workers; their next lease-guarded write stops work. */
export async function cancelEvalRun(
  programId: string,
  runId: string
): Promise<EvalRunListItem | null> {
  const result = await db.execute(sql`
    UPDATE eval_runs
    SET status = 'failed',
        error = 'Cancelled by super user',
        finished_at = now(),
        updated_at = now()
    WHERE id = ${runId}::uuid
      AND program_id = ${programId}::uuid
      AND status IN ('queued', 'running')
    RETURNING ${RUN_LIST_COLUMNS}
  `);
  const row = result.rows[0] as unknown as EvalRunRow | undefined;
  return row ? mapListItem(row) : null;
}

export type SetBaselineResult =
  | { outcome: "not-found" }
  | { outcome: "not-completed" }
  | { outcome: "updated"; item: EvalRunListItem };

export async function setEvalRunBaseline(
  programId: string,
  runId: string
): Promise<SetBaselineResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${`eval-baseline:${programId}`}))
    `);
    const selected = await tx.execute(sql`
      SELECT status
      FROM eval_runs
      WHERE id = ${runId}::uuid
        AND program_id = ${programId}::uuid
      FOR UPDATE
    `);
    const row = selected.rows[0] as { status: EvalRunStatus } | undefined;
    if (!row) return { outcome: "not-found" };
    if (row.status !== "completed") return { outcome: "not-completed" };

    await tx.execute(sql`
      UPDATE eval_runs
      SET is_baseline = false,
          updated_at = now()
      WHERE program_id = ${programId}::uuid
        AND is_baseline = true
    `);
    const updated = await tx.execute(sql`
      UPDATE eval_runs
      SET is_baseline = true,
          updated_at = now()
      WHERE id = ${runId}::uuid
        AND program_id = ${programId}::uuid
      RETURNING ${RUN_LIST_COLUMNS}
    `);
    return {
      outcome: "updated",
      item: mapListItem(updated.rows[0] as unknown as EvalRunRow)
    };
  });
}
