import {
  FALLBACK_MODEL,
  getModelRoutingState
} from "../generation/model-routing.js";
import { ensureQueue, getBoss } from "../jobs/boss.js";
import { getRerankModel } from "../retrieval/rerank.js";
import { getRetrievalRuntimeConfig } from "../retrieval/query.js";
import {
  claimEvalRun,
  completeEvalRun,
  failEvalRun,
  isMissingEvalRunsTable,
  listQueuedEvalRunIds,
  setEvalRunConfiguration,
  updateEvalRunProgress,
  type EvalRunConfiguration
} from "./persistence.js";
import { recordAppError } from "../observability/error-log.js";
import { evalQuestionSetHash, runEval } from "./runner.js";

export const RUN_EVALUATION_QUEUE = "run-evaluation";
const EVAL_OUTBOX_RECONCILE_MS = 60_000;

export interface RunEvaluationPayload {
  runId: string;
}

const EVAL_QUEUE_POLICY = {
  // Retries recover transient claim failures and worker crashes. The DB lease
  // token makes every progress/terminal write compare-and-set; an expired
  // handler that later resumes cannot overwrite its replacement.
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 4 * 60 * 60
} as const;

async function captureConfiguration(judge: boolean) {
  const [modelState, retrieval] = await Promise.all([
    getModelRoutingState(),
    Promise.resolve(getRetrievalRuntimeConfig())
  ]);
  const primaryRoute = modelState.routes[0];
  if (!primaryRoute) {
    throw new Error("No approved generation route is configured");
  }
  return {
    routeChain: modelState.routes,
    configuration: {
      judge,
      questionSetHash: null,
      generation: {
        id: primaryRoute.id,
        label: primaryRoute.label,
        model: primaryRoute.model,
        providerLabel: primaryRoute.providerLabel
      },
      routeChain: modelState.routes.map((route) => ({
        id: route.id,
        label: route.label,
        model: route.model,
        providerLabel: route.providerLabel
      })),
      fallback: {
        label: FALLBACK_MODEL.label,
        model: FALLBACK_MODEL.model,
        providerLabel: FALLBACK_MODEL.providerLabel
      },
      retrieval: {
        topK: retrieval.topK,
        candidateK: retrieval.candidateK,
        threshold: retrieval.threshold,
        neighborAnchors: retrieval.neighborAnchors,
        rerankModel: getRerankModel()
      }
    } satisfies EvalRunConfiguration
  };
}

export async function enqueueEvalRun(runId: string): Promise<string | null> {
  const boss = await getBoss();
  await ensureQueue(boss, RUN_EVALUATION_QUEUE, EVAL_QUEUE_POLICY);
  return boss.send(
    RUN_EVALUATION_QUEUE,
    { runId },
    // Suppress repeated UI/startup reconciliation while preserving the
    // ability to send a fresh job after a terminal pg-boss failure. A fixed
    // job UUID would remain occupied in pg-boss history and strand the outbox.
    { singletonKey: runId, singletonSeconds: 15 * 60 }
  );
}

/**
 * Repair the durable insert -> pg-boss send crash gap. Duplicate sends are
 * suppressed in 15-minute slots; claimEvalRun is a second boundary.
 */
export async function reconcileQueuedEvalRuns(programId?: string): Promise<number> {
  let runIds: string[];
  try {
    runIds = await listQueuedEvalRunIds(programId);
  } catch (error) {
    if (isMissingEvalRunsTable(error)) return 0;
    throw error;
  }
  for (const runId of runIds) {
    await enqueueEvalRun(runId);
  }
  return runIds.length;
}

async function reconcileQueuedEvalRunsSafely(): Promise<void> {
  try {
    await reconcileQueuedEvalRuns();
  } catch (error) {
    console.warn(
      "[eval-worker] queued-run reconciliation failed:",
      error instanceof Error ? error.message : error
    );
    void recordAppError({
      severity: "warning",
      source: "evaluation",
      operation: "queued-run-reconciliation",
      error,
      context: {}
    });
  }
}

/** Keep the durable outbox moving even when no browser is polling the API. */
export function startEvalOutboxReconciler(
  intervalMs = EVAL_OUTBOX_RECONCILE_MS
): () => void {
  let reconciling = false;
  const timer = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void reconcileQueuedEvalRunsSafely().finally(() => {
      reconciling = false;
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** @internal Exported for broker-retry takeover tests. */
export async function executeEvalRun(
  runId: string,
  brokerJobId: string,
  brokerRetry = false
): Promise<void> {
  const run = await claimEvalRun(runId, brokerJobId, brokerRetry);
  if (!run) return;

  try {
    const { configuration, routeChain } = await captureConfiguration(run.judge);
    if (!(await setEvalRunConfiguration(run.id, run.leaseToken, configuration))) {
      throw new Error("Evaluation run lease was replaced before execution");
    }
    const report = await runEval(
      {
        programId: run.programId,
        ...(run.questionId ? { questionId: run.questionId } : {}),
        ...(run.judge ? { judge: true } : {}),
        ...(run.questionSnapshot.length > 0
          ? { questionSnapshot: run.questionSnapshot }
          : {})
      },
      {
        onProgress: async (completed, total) => {
          const updated = await updateEvalRunProgress(
            run.id,
            run.leaseToken,
            completed,
            total
          );
          if (!updated) {
            throw new Error("Evaluation run lease was replaced during execution");
          }
        },
        routeChain
      }
    );
    if (report.summary.totalQuestions === 0) {
      throw new Error("No evaluation questions were available for this run");
    }
    const completed = await completeEvalRun(
      run.id,
      run.leaseToken,
      report,
      {
        ...configuration,
        questionSetHash: evalQuestionSetHash(report.results)
      }
    );
    if (!completed) {
      throw new Error("Evaluation run lease was replaced before completion");
    }
  } catch (error) {
    console.error(
      `[eval-worker] run ${run.id} failed:`,
      error instanceof Error ? error.message : error
    );
    void recordAppError({
      source: "evaluation",
      operation: "evaluation-run",
      error,
      programId: run.programId,
      context: {
        runId: run.id,
        brokerJobId,
        brokerRetry,
        questionId: run.questionId,
        judge: run.judge
      }
    });
    try {
      await failEvalRun(run.id, error, run.leaseToken);
    } catch (persistError) {
      console.error(
        `[eval-worker] could not persist failure for ${run.id}:`,
        persistError instanceof Error ? persistError.message : persistError
      );
      void recordAppError({
        severity: "fatal",
        source: "evaluation",
        operation: "persist-evaluation-failure",
        error: persistError,
        programId: run.programId,
        context: { runId: run.id, brokerJobId }
      });
      // The broker must retain retry responsibility when durable terminal
      // state could not be written. Swallowing this strands `running` rows.
      throw persistError;
    }
  }
}

/** Register one sequential consumer; runEval itself processes questions serially. */
export async function startEvaluationWorker(): Promise<() => void> {
  const boss = await getBoss();
  await ensureQueue(boss, RUN_EVALUATION_QUEUE, EVAL_QUEUE_POLICY);
  await boss.work<RunEvaluationPayload>(
    RUN_EVALUATION_QUEUE,
    { batchSize: 1, includeMetadata: true },
    async (jobs) => {
      const list = Array.isArray(jobs) ? jobs : [jobs];
      for (const job of list) {
        await executeEvalRun(job.data.runId, job.id, job.retryCount > 0);
      }
    }
  );
  // eval_runs is the durable outbox. Repair startup gaps immediately, then
  // keep repairing send failures without depending on browser traffic.
  await reconcileQueuedEvalRunsSafely();
  return startEvalOutboxReconciler();
}
