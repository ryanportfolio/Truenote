import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  boss: { send: vi.fn() },
  claimEvalRun: vi.fn(),
  failEvalRun: vi.fn(),
  ensureQueue: vi.fn(),
  getBoss: vi.fn(),
  listQueuedEvalRunIds: vi.fn(),
  runEval: vi.fn(),
  setEvalRunConfiguration: vi.fn()
}));

vi.mock("../../jobs/boss.js", () => ({
  ensureQueue: mocks.ensureQueue,
  getBoss: mocks.getBoss
}));

vi.mock("../persistence.js", () => ({
  claimEvalRun: mocks.claimEvalRun,
  completeEvalRun: vi.fn(),
  failEvalRun: mocks.failEvalRun,
  isMissingEvalRunsTable: vi.fn(() => false),
  listQueuedEvalRunIds: mocks.listQueuedEvalRunIds,
  setEvalRunConfiguration: mocks.setEvalRunConfiguration,
  updateEvalRunProgress: vi.fn()
}));

vi.mock("../runner.js", () => ({
  evalQuestionSetHash: vi.fn(),
  runEval: mocks.runEval
}));

vi.mock("../../generation/model-routing.js", () => ({
  getModelRoutingState: vi.fn().mockResolvedValue({
    routes: [
      {
        id: "primary",
        label: "Primary",
        model: "primary-model",
        provider: "provider",
        providerLabel: "Provider",
        reasoningEffort: "low"
      }
    ]
  })
}));

vi.mock("../../retrieval/query.js", () => ({
  getRetrievalRuntimeConfig: vi.fn(() => ({
    topK: 8,
    candidateK: 40,
    threshold: 0.3,
    neighborAnchors: 2
  }))
}));

vi.mock("../../retrieval/rerank.js", () => ({
  getRerankModel: vi.fn(() => "rerank-model")
}));

import {
  enqueueEvalRun,
  executeEvalRun,
  reconcileQueuedEvalRuns,
  RUN_EVALUATION_QUEUE,
  startEvalOutboxReconciler
} from "../queue.js";

describe("evaluation queue outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBoss.mockResolvedValue(mocks.boss);
    mocks.boss.send.mockResolvedValue("job-id");
    mocks.claimEvalRun.mockResolvedValue(null);
    mocks.failEvalRun.mockResolvedValue(true);
    mocks.listQueuedEvalRunIds.mockResolvedValue([]);
    mocks.setEvalRunConfiguration.mockResolvedValue(true);
  });

  it("deduplicates reconciliation in a bounded singleton window", async () => {
    await enqueueEvalRun("11111111-1111-4111-8111-111111111111");

    expect(mocks.boss.send).toHaveBeenCalledWith(
      RUN_EVALUATION_QUEUE,
      { runId: "11111111-1111-4111-8111-111111111111" },
      {
        singletonKey: "11111111-1111-4111-8111-111111111111",
        singletonSeconds: 15 * 60
      }
    );
  });

  it("re-sends every durable queued row after an insert/send crash", async () => {
    mocks.listQueuedEvalRunIds.mockResolvedValue([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ]);

    await expect(reconcileQueuedEvalRuns("program-1")).resolves.toBe(2);
    expect(mocks.listQueuedEvalRunIds).toHaveBeenCalledWith("program-1");
    expect(mocks.boss.send).toHaveBeenCalledTimes(2);
  });

  it("reconciles the durable outbox without browser traffic", async () => {
    vi.useFakeTimers();
    const stop = startEvalOutboxReconciler(1_000);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.listQueuedEvalRunIds).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("correlates broker retry takeover with the broker job id", async () => {
    await executeEvalRun(
      "11111111-1111-4111-8111-111111111111",
      "broker-job-1",
      true
    );

    expect(mocks.claimEvalRun).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "broker-job-1",
      true
    );
  });

  it("propagates terminal-state persistence failures back to pg-boss", async () => {
    mocks.claimEvalRun.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      programId: "program-1",
      questionId: null,
      judge: false,
      questionSnapshot: [{ id: "question-1" }],
      leaseToken: "lease-1"
    });
    mocks.runEval.mockRejectedValue(new Error("evaluation failed"));
    mocks.failEvalRun.mockRejectedValue(new Error("database unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      executeEvalRun(
        "11111111-1111-4111-8111-111111111111",
        "broker-job-1"
      )
    ).rejects.toThrow("database unavailable");
    errorSpy.mockRestore();
  });
});
