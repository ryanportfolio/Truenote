// Evaluation Center fixture: /api/admin/evaluations/* for the super user.
// Mirrors artifacts/api-server/src/routes/admin/evaluations.ts and the shapes
// in lib/eval/persistence.ts and lib/eval/runner.ts. Results are synthetic:
// nothing here retrieves or calls a model. A run moves queued -> running ->
// completed from its timestamps on each read (no timers): running 1 s after it
// is queued, then one question about every 700 ms.

import { createHash } from "node:crypto";
import { nextId } from "./seed.mjs";

const DAY = 24 * 60 * 60 * 1000;
const REFUSAL = "I couldn't find this in the knowledge base.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORTS = ["none", "low", "medium", "high", "xhigh"];
const QUEUE_DELAY_MS = 1000;
const QUESTION_MS = 700;
const MAX_QUESTIONS_PER_RUN = 250;
const MAX_SUGGESTIONS = 50;
const DRAFT_DELAY_MS = 1500;
const RERANK_MODEL = "rerank-english-v3.0";
const RETRIEVAL_DEFAULTS = { topK: 8, candidateK: 40, threshold: 0.3, neighborAnchors: 3 };
const IN_KB_MESSAGE = "An in-KB question needs an expected source, phrase, or answer";

const iso = (ms) => new Date(ms).toISOString();
const sha = (text) => createHash("sha256").update(text).digest("hex");
/** Deterministic number in [0, 1) for a key. */
const unit = (key) => parseInt(sha(key).slice(0, 8), 16) / 2 ** 32;
/** Deterministic UUID-shaped id for a key (synthetic chunk ids). */
const keyId = (key) => {
  const h = sha(key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const evalId = (n) => `00000000-0000-4000-a000-${n.toString(16).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// Seed: 12 questions over the Acme Wireless Care library and three runs.

const SEED_QUESTIONS = [
  {
    doc: "cancel-fee",
    question: "What's the early termination fee for Unlimited Plus in month 8?",
    phrases: ["$325"],
    answer: "For Unlimited Plus 24-month in months 1 to 12 the early termination fee is $325, prorated by the full months left."
  },
  {
    doc: "refund-annual",
    question: "Can a customer get a refund on an annual plan after 3 months?",
    expectedAnswer: "Yes. Between 31 and 180 days after renewal the refund is prorated minus a $25 processing fee, with no approval needed under $150.",
    answer: "Yes. At 31 to 180 days after renewal the refund is prorated, minus the $25 processing fee; no approval is needed under $150."
  },
  {
    doc: "pw-reset",
    question: "How long does a password reset link last?",
    phrases: ["30 minutes"],
    answer: "Reset links now expire in 30 minutes. If it expired, send a new link."
  },
  {
    doc: "late-fee",
    question: "How much is the late fee?",
    phrases: ["$10", "5%"],
    answer: "The late fee is $10 or 5% of the past-due balance, whichever is greater."
  },
  {
    doc: "outage-credit",
    question: "What credit do we give for a 4 day outage?",
    expectedAnswer: "One day of credit per day of outage, and an outage over 72 hours also waives the cancellation fee.",
    answer: "Give 1 day of credit per day of outage. Because it lasted over 72 hours, the cancellation fee is also waived.",
    isProtected: true
  },
  {
    doc: "roaming",
    question: "How much is the international travel day pass?",
    phrases: ["$10 per day"],
    answer: "The travel day pass is $10 per day and uses the plan's data, talk and text."
  },
  {
    doc: "device-return",
    question: "What's the restocking fee on a returned phone?",
    expectedAnswer: "$50 for a phone returned within 14 days; waived when the device arrived damaged.",
    answer: "Phones have a $50 restocking fee and a 14-day return window. The fee is waived when the device arrived damaged."
  },
  {
    doc: "id-verify",
    question: "Can I accept date of birth instead of the PIN?",
    phrases: ["PIN"],
    answer: "No. The secret must be the PIN or the card's last 4; date of birth is not accepted.",
    notes: "CSRs ask this on almost every verification call."
  },
  {
    cite: "military",
    question: "How much is the active duty military discount?",
    phrases: ["25%"],
    answer: "Active duty customers get 25% off service.",
    notes: "No expected source: phrase check only."
  },
  {
    doc: "port-out",
    question: "Can an authorized user get a port-out PIN?",
    expectedAnswer: "No. Only the account owner (after the 3-point check) or a business admin can get a port-out PIN; the owner must call.",
    answer: "No. An authorized user can't get a port-out PIN; the account owner must call and pass the 3-point check.",
    isProtected: true
  },
  {
    question: "What's the trade-in value for a cracked iPhone 15?",
    notes: "Not covered by any source: the answer must be a refusal."
  },
  {
    question: "Do we price-match competitor promotions?",
    notes: "Asked often on retention calls; no policy exists."
  }
];

// Outcomes per seeded question (index order). Baseline 10/12; the later live
// run newly fails questions 3 and 7 and newly passes question 4; the trial run
// has its own mix.
const BASELINE_OUTCOMES = ["pass", "pass", "pass", "generation", "pass", "pass", "pass", "pass", "generation", "pass", "pass", "pass"];
const LIVE_OUTCOMES = ["pass", "pass", "rerank", "pass", "pass", "pass:fallback", "partial", "pass", "generation", "pass", "pass", "pass"];
const TRIAL_OUTCOMES = ["pass", "partial", "pass", "pass", "pass", "pass", "judge-failed", "pass", "generation", "incorrect", "pass", "answered"];
const SEED_LATENCIES = [
  [1240, 1510, 1810, 1700, 2300, 1620, 4200, 1780, 1850, 2900, 990, 3700],
  [1310, 1580, 1890, 1660, 2410, 3950, 4180, 1720, 1800, 2750, 1040, 1530],
  [980, 1190, 1460, 1390, 1820, 1280, 3600, 1350, 1510, 2200, 870, 4150]
];

// ---------------------------------------------------------------------------
// Scoring: the same rules as runner.ts (classify, combineAnswerCorrect,
// questionPasses, attributeFailure, summarizeEvalResults).

function classify(q) {
  return q.expectedDocId || (q.expectedAnswerContains?.length ?? 0) > 0 || q.expectedAnswer ? "in-kb" : "out-of-kb";
}

function combineAnswerCorrect(phrasesPresent, hasExpectedAnswer, verdict) {
  const checks = [];
  if (phrasesPresent.length > 0) checks.push(phrasesPresent.every((p) => p.present));
  if (hasExpectedAnswer) checks.push(verdict === "correct");
  return checks.length === 0 ? null : checks.every(Boolean);
}

function questionPasses({ kind, refused, citationCorrect, answerCorrect, correctnessJudgeFailed }) {
  if (kind === "out-of-kb") return refused;
  return !refused && (citationCorrect === null || citationCorrect) && answerCorrect !== false && !correctnessJudgeFailed;
}

function attributeFailure({ retrievalHit, rerankHit, gateRefused }) {
  if (retrievalHit === null || rerankHit === null) return null;
  if (!retrievalHit) return "retrieval";
  if (!rerankHit) return "rerank";
  if (gateRefused) return "threshold";
  return "generation";
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function splitStat(results) {
  const passed = results.filter((r) => r.pass).length;
  return { total: results.length, passed, passRatePct: results.length === 0 ? null : (passed / results.length) * 100 };
}

function summarize(results) {
  const pct = (part, whole) => (whole === 0 ? null : (part / whole) * 100);
  const passed = results.filter((r) => r.pass).length;
  const inKb = results.filter((r) => r.kind === "in-kb");
  const outOfKb = results.filter((r) => r.kind === "out-of-kb");
  const citationApplicable = inKb.filter((r) => r.citationCorrect !== null);
  const answerApplicable = inKb.filter((r) => r.answerCorrect !== null);
  const stageApplicable = inKb.filter((r) => r.retrievalHit !== null);
  const inKbFailures = inKb.filter((r) => !r.pass);
  const stageCount = (stage) => inKbFailures.filter((r) => r.failureStage === stage).length;
  const ranked = results.filter((r) => r.expectedDocRank !== null);
  const judged = results.filter((r) => r.faithfulnessPct !== null);
  const sortedLatency = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    totalQuestions: results.length,
    passed,
    failed: results.length - passed,
    splits: {
      protected: splitStat(results.filter((r) => r.isProtected)),
      open: splitStat(results.filter((r) => !r.isProtected))
    },
    inKbTotal: inKb.length,
    inKbPassed: inKb.filter((r) => r.pass).length,
    outOfKbTotal: outOfKb.length,
    outOfKbPassed: outOfKb.filter((r) => r.pass).length,
    inKbRefusalRatePct: pct(inKb.filter((r) => r.refused).length, inKb.length),
    outOfKbRefusalRatePct: pct(outOfKb.filter((r) => r.refused).length, outOfKb.length),
    citationAccuracyPct: pct(citationApplicable.filter((r) => r.citationCorrect === true).length, citationApplicable.length),
    answerAccuracyPct: pct(answerApplicable.filter((r) => r.answerCorrect === true).length, answerApplicable.length),
    retrievalRecallPct: pct(stageApplicable.filter((r) => r.retrievalHit === true).length, stageApplicable.length),
    rerankRecallPct: pct(stageApplicable.filter((r) => r.rerankHit === true).length, stageApplicable.length),
    inKbFailuresByStage: {
      retrieval: stageCount("retrieval"),
      rerank: stageCount("rerank"),
      threshold: stageCount("threshold"),
      generation: stageCount("generation"),
      unattributed: inKbFailures.filter((r) => r.failureStage === null).length
    },
    expectedDocRankMean:
      ranked.length === 0 ? null : ranked.reduce((sum, r) => sum + (r.expectedDocRank ?? 0), 0) / ranked.length,
    judgedQuestions: judged.length,
    meanFaithfulnessPct:
      judged.length === 0 ? null : judged.reduce((sum, r) => sum + (r.faithfulnessPct ?? 0), 0) / judged.length,
    unfaithfulQuestions: judged.filter((r) => r.unsupportedClaims.length > 0).length,
    fallbackGenerationCount: results.filter((r) => r.generationPath === "fallback").length,
    failedFallbackCount: results.filter((r) => r.generationPath === "fallback-failed").length,
    judgeFailures: results.filter((r) => r.faithfulnessJudgeFailed).length,
    correctnessJudgeFailures: results.filter((r) => r.correctnessJudgeFailed).length,
    latencyP50Ms: percentile(sortedLatency, 50),
    latencyP95Ms: percentile(sortedLatency, 95)
  };
}

/** runner.ts evalQuestionSetHash: the exact scored definitions, in order. */
function questionSetHash(results) {
  const definitions = results.map((r) => ({
    questionId: r.questionId,
    question: r.question,
    programId: r.programId,
    kind: r.kind,
    expectedDocId: r.expectedDocId,
    expectedAnswerContains: r.expectedAnswerContains,
    ...(r.expectedAnswer ? { expectedAnswer: r.expectedAnswer } : {})
  }));
  return sha(JSON.stringify(definitions));
}

// ---------------------------------------------------------------------------
// Module

export function registerEvaluationRoutes({
  route,
  getState,
  badRequest,
  HttpError,
  requireRole,
  effectiveProgramId,
  requireProgram,
  MODEL_ROUTES,
  modelRoutingConfig
}) {
  // One store per seed object, so /__mock/reset (which rebuilds state) also
  // reseeds evaluations.
  const stores = new WeakMap();

  function store() {
    const state = getState();
    let entry = stores.get(state);
    if (!entry) {
      entry = seedStore(state);
      stores.set(state, entry);
    }
    return entry;
  }

  const programDocs = (programId) => getState().documents.filter((d) => d.programId === programId);
  const findDoc = (programId, id) => programDocs(programId).find((d) => d.id === id) ?? null;
  const programName = (programId) => getState().programs.find((p) => p.id === programId)?.name ?? null;
  const questionsOf = (programId) => {
    const s = store();
    if (!s.questions.has(programId)) s.questions.set(programId, []);
    return s.questions.get(programId);
  };
  const runsOf = (programId) => {
    const s = store();
    if (!s.runs.has(programId)) s.runs.set(programId, []);
    return s.runs.get(programId);
  };

  function liveChain() {
    return modelRoutingConfig().routes.map(({ id, label, model, providerLabel, reasoningEffort }) => ({
      id,
      label,
      model,
      providerLabel,
      reasoningEffort
    }));
  }

  /** queue.ts captureConfiguration, with the fixture's routes. */
  function captureConfiguration(judge, trial) {
    let chain = liveChain();
    if (trial) {
      const configured = chain.find((r) => r.id === trial.routeId);
      const base = configured ?? MODEL_ROUTES.find((r) => r.id === trial.routeId);
      const { id, label, model, providerLabel } = base;
      chain = [{ id, label, model, providerLabel, reasoningEffort: trial.reasoningEffort ?? base.reasoningEffort }];
    }
    const primary = chain[0];
    return {
      judge,
      trial: trial !== null,
      ...(trial
        ? {
            trialOverrides: {
              routeId: primary.id,
              reasoningEffort: primary.reasoningEffort,
              ...(trial.threshold !== undefined ? { threshold: trial.threshold } : {}),
              ...(trial.topK !== undefined ? { topK: trial.topK } : {})
            }
          }
        : {}),
      questionSetHash: null,
      generation: { ...primary },
      routeChain: chain.map((r) => ({ ...r })),
      retrieval: {
        topK: trial?.topK ?? RETRIEVAL_DEFAULTS.topK,
        candidateK: RETRIEVAL_DEFAULTS.candidateK,
        threshold: trial?.threshold ?? RETRIEVAL_DEFAULTS.threshold,
        neighborAnchors: RETRIEVAL_DEFAULTS.neighborAnchors,
        rerankModel: RERANK_MODEL
      }
    };
  }

  function mapQuestion(programId, q) {
    return {
      id: q.id,
      programId,
      question: q.question,
      kind: classify(q),
      expectedDocId: q.expectedDocId,
      expectedDocTitle: q.expectedDocId ? findDoc(programId, q.expectedDocId)?.title ?? null : null,
      expectedAnswerContains: [...q.expectedAnswerContains],
      expectedAnswer: q.expectedAnswer,
      isProtected: q.isProtected,
      notes: q.notes,
      createdAt: q.createdAt
    };
  }

  function snapshotOf(programId, q) {
    return {
      id: q.id,
      question: q.question,
      programId,
      programName: programName(programId),
      expectedDocId: q.expectedDocId,
      expectedAnswerContains: [...q.expectedAnswerContains],
      notes: q.notes,
      isProtected: q.isProtected,
      expectedAnswer: q.expectedAnswer,
      // Fixture-only: the answer text the synthetic pipeline gives on a pass.
      goodAnswer: q.goodAnswer ?? null,
      citeDocId: q.citeDocId ?? null
    };
  }

  // -------------------------------------------------------------------------
  // Synthetic results

  /** A fixture document for a question with no expected source: best title-word overlap. */
  function guessDoc(programId, question) {
    const words = new Set(question.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    let best = null;
    let bestScore = 0;
    for (const d of programDocs(programId)) {
      if (d.retired) continue;
      const score = (d.title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 3 && words.has(w)).length;
      if (score > bestScore) {
        best = d;
        bestScore = score;
      }
    }
    return best ?? programDocs(programId).find((d) => !d.retired) ?? null;
  }

  function goodAnswerFor(def, doc) {
    if (def.goodAnswer) return def.goodAnswer;
    let text = def.expectedAnswer
      ? def.expectedAnswer
      : def.expectedAnswerContains.length > 0
        ? `Per ${doc?.title ?? "the source"}: ${def.expectedAnswerContains.join("; ")}.`
        : doc
          ? doc.versions.find((v) => v.id === doc.activeVersionId)?.passages[0]?.text ?? doc.title
          : "See the cited source.";
    const missing = def.expectedAnswerContains.filter((p) => !text.toLowerCase().includes(p.toLowerCase()));
    if (missing.length > 0) text = `${text} (${missing.join("; ")})`;
    return text;
  }

  /**
   * One scored result. `outcome` picks what the synthetic pipeline did; the
   * scoring fields are then derived with the runner's rules, so they always
   * agree with each other.
   */
  function synthResult(def, outcome, { key, latencyMs, judge, threshold, otherDocId }) {
    const kind = classify(def);
    const programId = def.programId;
    const expectedDoc = def.expectedDocId ? findDoc(programId, def.expectedDocId) : null;
    const citeDoc =
      expectedDoc ?? (def.citeDocId ? findDoc(programId, def.citeDocId) : null) ?? guessDoc(programId, def.question);
    const otherDoc =
      programDocs(programId).find((d) => d.id === otherDocId && d.id !== citeDoc?.id) ??
      programDocs(programId).find((d) => !d.retired && d.id !== citeDoc?.id);
    const fallback = outcome.endsWith(":fallback");
    let o = outcome.replace(":fallback", "");
    if (kind === "in-kb" && !def.expectedDocId && ["retrieval", "rerank", "threshold"].includes(o)) o = "generation";
    if (kind === "in-kb" && !def.expectedAnswer && ["partial", "incorrect", "judge-failed"].includes(o)) o = "generation";
    if (kind === "out-of-kb") o = o === "pass" ? "refuse" : "answered";

    const gateRefused = ["retrieval", "threshold", "refuse"].includes(o);
    const refused = gateRefused;
    let citedDoc = null;
    let answerText = REFUSAL;
    if (!refused) {
      if (o === "rerank") {
        citedDoc = otherDoc;
        answerText = `${otherDoc?.title ?? "A related source"} covers a similar case; confirm the details before quoting it.`;
      } else if (o === "generation") {
        const hasAnswerCheck = def.expectedAnswerContains.length > 0 || def.expectedAnswer;
        citedDoc = hasAnswerCheck ? citeDoc : otherDoc;
        answerText = `The source covers this topic, but the excerpt I found does not state it directly.`;
      } else if (o === "incorrect") {
        citedDoc = citeDoc;
        answerText = `No. That request needs a supervisor override before anything is processed.`;
      } else if (o === "answered") {
        citedDoc = guessDoc(programId, def.question);
        answerText = `Check ${citedDoc?.title ?? "the related source"}; it covers a similar request.`;
      } else {
        // pass, partial, judge-failed: the right source and the right text.
        // A partial answer keeps only the first clause of the full one.
        citedDoc = citeDoc;
        const full = goodAnswerFor(def, citeDoc);
        answerText = o === "partial" ? `${full.split(/[.;]/)[0].trim()}.` : full;
      }
    }
    const chunkId = citedDoc ? keyId(`${key}:chunk`) : null;
    const answer = chunkId ? `${answerText} [${chunkId}]` : answerText;
    const citedChunkIds = chunkId ? [chunkId] : [];
    const citedDocIds = citedDoc ? [citedDoc.id] : [];
    const answerLower = answer.toLowerCase();
    const phrasesPresent = def.expectedAnswerContains.map((phrase) => ({
      phrase,
      present: answerLower.includes(phrase.toLowerCase())
    }));
    const citationCorrect = def.expectedDocId === null ? null : citedDocIds.includes(def.expectedDocId);
    const retrievalHit = def.expectedDocId === null ? null : o !== "retrieval";
    const rerankHit = def.expectedDocId === null ? null : !["retrieval", "rerank"].includes(o);
    const expectedDocRank = rerankHit ? 1 + Math.floor(unit(`${key}:rank`) * (o === "threshold" ? 4 : 3)) : null;

    let correctness = null;
    let correctnessJudgeFailed = false;
    if (kind === "in-kb" && def.expectedAnswer && !refused) {
      if (o === "judge-failed") correctnessJudgeFailed = true;
      else if (o === "pass") correctness = { verdict: "correct", reason: "States the same amount and conditions as the expected answer." };
      else if (o === "partial") correctness = { verdict: "partial", reason: "Gives the main amount but leaves out a condition the expected answer includes." };
      else correctness = { verdict: "incorrect", reason: "Contradicts the expected answer." };
    }
    const answerCorrect = kind === "out-of-kb" ? null : combineAnswerCorrect(phrasesPresent, Boolean(def.expectedAnswer), correctness?.verdict ?? null);
    const pass = questionPasses({ kind, refused, citationCorrect, answerCorrect, correctnessJudgeFailed });
    const failureStage =
      kind === "in-kb" && !pass && !correctnessJudgeFailed ? attributeFailure({ retrievalHit, rerankHit, gateRefused }) : null;

    const topScore = Number(
      (gateRefused
        ? o === "threshold"
          ? Math.max(0.05, threshold - 0.04)
          : 0.06 + unit(`${key}:score`) * Math.max(0.05, threshold - 0.12)
        : o === "answered"
          ? threshold + 0.03
          : threshold + 0.2 + unit(`${key}:score`) * 0.45
      ).toFixed(3)
    );

    let faithfulnessPct = null;
    let unsupportedClaims = [];
    if (judge && !refused) {
      if (pass) faithfulnessPct = 100;
      else {
        faithfulnessPct = o === "answered" ? 50 : 67;
        unsupportedClaims =
          o === "incorrect"
            ? ["That request needs a supervisor override."]
            : o === "answered"
              ? ["The cited source covers this request."]
              : ["The excerpt does not state it directly."];
      }
    }

    return {
      questionId: def.id,
      question: def.question,
      programId,
      programName: def.programName,
      expectedDocId: def.expectedDocId,
      expectedAnswerContains: [...def.expectedAnswerContains],
      notes: def.notes,
      isProtected: def.isProtected === true,
      answer,
      refused,
      topScore,
      citedChunkIds,
      citedDocIds,
      latencyMs: gateRefused ? Math.round(latencyMs * 0.6) : latencyMs,
      generationPath: refused ? "retrieval-refusal" : fallback ? "fallback" : "primary",
      kind,
      pass,
      citationCorrect,
      phrasesPresent,
      expectedAnswer: def.expectedAnswer,
      answerCorrect,
      correctness,
      correctnessJudgeFailed,
      retrievalHit,
      rerankHit,
      expectedDocRank,
      failureStage,
      faithfulnessPct,
      unsupportedClaims,
      faithfulnessJudgeFailed: false,
      error: correctnessJudgeFailed ? "Answer grading failed" : null
    };
  }

  /** Outcome for a question in a run started from the fixture (not seeded). */
  function pickOutcome(runId, def, trial) {
    const r = unit(`${runId}:${def.id}:outcome`);
    const s = unit(`${runId}:${def.id}:kind`);
    if (classify(def) === "out-of-kb") return r < (trial ? 0.75 : 0.88) ? "pass" : "answered";
    if (r < (trial ? 0.7 : 0.78)) return s < 0.08 && !trial ? "pass:fallback" : "pass";
    if (def.expectedAnswer && r > 0.985) return "judge-failed";
    const failures = ["retrieval", "rerank", "threshold", "generation", ...(def.expectedAnswer ? ["partial", "incorrect"] : [])];
    return failures[Math.floor(s * failures.length)];
  }

  /** Exponential tail: median about 1.8 s, 95th percentile about 4.3 s. */
  const pickLatency = (key) => Math.min(4800, 1050 + Math.round(-Math.log(1 - unit(key) * 0.999) * 1100));

  function buildReport(run, outcomes, latencies, startedMs, finishedMs) {
    const threshold = run.configuration.retrieval.threshold;
    const results = run.snapshot.map((def, index) =>
      synthResult(def, outcomes[index], {
        key: `${run.id}:${def.id}`,
        latencyMs: latencies[index],
        judge: run.judge,
        threshold,
        otherDocId: run.snapshot[(index + 1) % run.snapshot.length]?.expectedDocId
      })
    );
    return {
      startedAt: iso(startedMs),
      finishedAt: iso(finishedMs),
      durationMs: finishedMs - startedMs,
      summary: summarize(results),
      results
    };
  }

  function completeRun(run, outcomes, latencies) {
    run.report = buildReport(run, outcomes, latencies, run.startedMs, run.finishedMs);
    run.configuration = { ...run.configuration, questionSetHash: questionSetHash(run.report.results) };
    run.status = "completed";
    run.completedQuestions = run.snapshot.length;
    run.error = null;
  }

  /** Move a queued or running run forward to where its timestamps say it is. */
  function advance(run, now = Date.now()) {
    if (run.status === "queued" && now >= run.createdMs + QUEUE_DELAY_MS) {
      run.status = "running";
      run.startedMs = run.createdMs + QUEUE_DELAY_MS;
      run.completedQuestions = 0;
      run.configuration = captureConfiguration(run.judge, run.trial);
    }
    if (run.status !== "running") return run;
    const total = run.snapshot.length;
    const done = Math.min(total, Math.floor((now - run.startedMs) / QUESTION_MS));
    run.completedQuestions = done;
    if (done >= total) {
      run.finishedMs = run.startedMs + total * QUESTION_MS;
      completeRun(
        run,
        run.snapshot.map((def) => pickOutcome(run.id, def, run.trial !== null)),
        run.snapshot.map((def) => pickLatency(`${run.id}:${def.id}:latency`))
      );
    }
    return run;
  }

  function toItem(run) {
    return {
      id: run.id,
      status: run.status,
      questionId: run.questionId,
      judge: run.judge,
      questionCount: run.snapshot.length,
      completedQuestions: run.completedQuestions,
      // A queued row holds only the request; the worker writes the full
      // configuration when it claims the run (configurationFrom -> null).
      configuration: run.configuration ? structuredClone(run.configuration) : null,
      summary: run.report ? structuredClone(run.report.summary) : null,
      error: run.error,
      isBaseline: run.isBaseline,
      createdAt: iso(run.createdMs),
      startedAt: run.startedMs === null ? null : iso(run.startedMs),
      finishedAt: run.finishedMs === null ? null : iso(run.finishedMs)
    };
  }

  // -------------------------------------------------------------------------
  // Seed

  function seedStore(state) {
    const entry = { questions: new Map(), runs: new Map() };
    stores.set(state, entry);
    const program = state.programs[0];
    const now = Date.now();
    const byKey = Object.fromEntries(state.documents.map((d) => [d.key, d]));
    const questions = SEED_QUESTIONS.map((spec, index) => ({
      id: evalId(index + 1),
      question: spec.question,
      expectedDocId: spec.doc ? byKey[spec.doc].id : null,
      expectedAnswerContains: spec.phrases ?? [],
      expectedAnswer: spec.expectedAnswer ?? null,
      isProtected: spec.isProtected === true,
      notes: spec.notes ?? null,
      createdAt: iso(now - (30 - index) * DAY),
      goodAnswer: spec.answer ?? null,
      citeDocId: spec.cite ? byKey[spec.cite].id : null
    }));
    entry.questions.set(program.id, questions);
    const snapshot = questions.map((q) => snapshotOf(program.id, q));

    const seedRun = (n, { createdMs, judge, trial, outcomes, latencies, isBaseline }) => {
      const startedMs = createdMs + 4000;
      const finishedMs = startedMs + latencies.reduce((a, b) => a + b, 0) / 3 + 6000;
      const run = {
        id: evalId(0x100 + n),
        programId: program.id,
        status: "running",
        questionId: null,
        judge,
        trial,
        snapshot: snapshot.map((d) => ({ ...d })),
        createdMs,
        startedMs,
        finishedMs: Math.round(finishedMs),
        completedQuestions: 0,
        configuration: captureConfiguration(judge, trial),
        report: null,
        error: null,
        isBaseline
      };
      completeRun(run, outcomes, latencies);
      return run;
    };
    const runs = [
      seedRun(1, { createdMs: now - 9 * DAY, judge: true, trial: null, outcomes: BASELINE_OUTCOMES, latencies: SEED_LATENCIES[0], isBaseline: true }),
      seedRun(2, { createdMs: now - 2 * DAY, judge: true, trial: null, outcomes: LIVE_OUTCOMES, latencies: SEED_LATENCIES[1], isBaseline: false }),
      seedRun(3, {
        createdMs: now - 5 * 60 * 60 * 1000,
        judge: false,
        trial: { routeId: "nemotron-3.5-lightning-coreweave", reasoningEffort: "medium", threshold: 0.25 },
        outcomes: TRIAL_OUTCOMES,
        latencies: SEED_LATENCIES[2],
        isBaseline: false
      })
    ];
    entry.runs.set(program.id, runs);
    return entry;
  }

  // -------------------------------------------------------------------------
  // Validation (the route's zod schemas)

  const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

  /** EvalQuestionBody. Returns { data } or { error }. */
  function parseQuestion(body) {
    const invalid = { error: "Invalid evaluation question" };
    if (body === null || typeof body !== "object" || Array.isArray(body)) return invalid;
    const { kind, question, expectedDocId, expectedAnswerContains, notes, expectedAnswer, isProtected } = body;
    if (kind !== "in-kb" && kind !== "out-of-kb") return invalid;
    if (typeof question !== "string" || question.trim().length < 1 || question.trim().length > 2000) return invalid;
    if (expectedDocId !== undefined && expectedDocId !== null && !isUuid(expectedDocId)) return invalid;
    let phrases = [];
    if (expectedAnswerContains !== undefined) {
      if (!Array.isArray(expectedAnswerContains) || expectedAnswerContains.length > 20) return invalid;
      for (const p of expectedAnswerContains) {
        if (typeof p !== "string" || p.trim().length < 1 || p.trim().length > 500) return invalid;
      }
      phrases = expectedAnswerContains.map((p) => p.trim());
    }
    if (notes !== undefined && notes !== null && (typeof notes !== "string" || notes.trim().length > 2000)) return invalid;
    if (
      expectedAnswer !== undefined &&
      expectedAnswer !== null &&
      (typeof expectedAnswer !== "string" || expectedAnswer.trim().length > 2000)
    ) {
      return invalid;
    }
    if (isProtected !== undefined && typeof isProtected !== "boolean") return invalid;
    const answer = typeof expectedAnswer === "string" && expectedAnswer.trim() ? expectedAnswer.trim() : null;
    if (kind === "in-kb" && !expectedDocId && phrases.length === 0 && !answer) {
      return { error: IN_KB_MESSAGE };
    }
    // normalizePhrases: drop case-insensitive repeats, keep the first spelling.
    const seen = new Set();
    const unique = phrases.filter((p) => {
      const k = p.toLocaleLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const inKb = kind === "in-kb";
    return {
      data: {
        question: question.trim(),
        expectedDocId: inKb ? expectedDocId ?? null : null,
        expectedAnswerContains: inKb ? unique : [],
        expectedAnswer: inKb ? answer : null,
        notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
        isProtected
      }
    };
  }

  function createQuestion(programId, data) {
    if (data.expectedDocId && !findDoc(programId, data.expectedDocId)) {
      return { status: 400, error: "Expected document must belong to the selected program" };
    }
    const q = {
      id: nextId(),
      question: data.question,
      expectedDocId: data.expectedDocId,
      expectedAnswerContains: data.expectedAnswerContains,
      expectedAnswer: data.expectedAnswer,
      isProtected: data.isProtected ?? false,
      notes: data.notes,
      createdAt: new Date().toISOString()
    };
    questionsOf(programId).push(q);
    return { item: mapQuestion(programId, q) };
  }

  /** RunBody plus the route's effort check. Throws a 400 HttpError. */
  function parseRunBody(body) {
    const generic = () => badRequest("Invalid evaluation run request");
    const raw = body ?? {};
    if (typeof raw !== "object" || Array.isArray(raw)) throw generic();
    const { judge = false, questionId, trial } = raw;
    let modelIssue = false;
    let effortIssue = false;
    let otherIssue = false;
    if (typeof judge !== "boolean") otherIssue = true;
    if (questionId !== undefined && !isUuid(questionId)) otherIssue = true;
    let parsedTrial = null;
    if (trial !== undefined) {
      if (trial === null || typeof trial !== "object" || Array.isArray(trial)) throw generic();
      const { routeId, reasoningEffort, threshold, topK } = trial;
      if (!MODEL_ROUTES.some((r) => r.id === routeId)) modelIssue = true;
      if (reasoningEffort !== undefined && !EFFORTS.includes(reasoningEffort)) effortIssue = true;
      if (threshold !== undefined && (typeof threshold !== "number" || !(threshold >= 0 && threshold <= 1))) otherIssue = true;
      if (topK !== undefined && (!Number.isInteger(topK) || topK < 1 || topK > 20)) otherIssue = true;
      parsedTrial = {
        routeId,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(topK !== undefined ? { topK } : {})
      };
    }
    if (modelIssue) throw badRequest("Pick an approved model");
    if (effortIssue) throw badRequest("Pick an effort level that model supports");
    if (otherIssue) throw generic();
    if (parsedTrial?.reasoningEffort !== undefined) {
      const routeDef = MODEL_ROUTES.find((r) => r.id === parsedTrial.routeId);
      if (!routeDef.supportedEfforts.includes(parsedTrial.reasoningEffort)) {
        throw badRequest("Pick an effort level that model supports");
      }
    }
    return { judge, questionId: questionId ?? null, trial: parsedTrial };
  }

  function runById(programId, id) {
    if (!isUuid(id)) throw badRequest("Invalid run id");
    const run = runsOf(programId).find((r) => r.id === id);
    if (!run) throw new HttpError(404, "Evaluation run not found");
    return advance(run);
  }

  // -------------------------------------------------------------------------
  // Draft questions from a document (the model call, faked)

  function draftFrom(doc, count) {
    const markdown = doc.versions.find((v) => v.id === doc.activeVersionId)?.markdown ?? "";
    const lines = markdown.split("\n");
    const items = [];
    const tableLines = lines.filter((l) => l.startsWith("|") && !/^\|\s*-/.test(l));
    if (tableLines.length > 1) {
      const cells = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
      const head = cells(tableLines[0]);
      for (const row of tableLines.slice(1).map(cells)) {
        items.push({
          question: `Under "${doc.title}", what applies for ${row[0]}?`,
          expectedAnswer: head
            .slice(1)
            .map((h, i) => `${h}: ${row[i + 1]}`)
            .join("; ") + "."
        });
      }
    }
    for (const note of lines.filter((l) => l.startsWith("> ")).map((l) => l.slice(2).trim())) {
      items.push({ question: `What should an agent know before quoting "${doc.title}"?`, expectedAnswer: note });
    }
    lines
      .filter((l) => /^\d+\. /.test(l))
      .forEach((l, i) => {
        items.push({
          question: `What is step ${i + 1} when handling ${doc.title.charAt(0).toLowerCase()}${doc.title.slice(1)}?`,
          expectedAnswer: l.replace(/^\d+\. /, "")
        });
      });
    const summary = lines.find((l, i) => i > 0 && l.trim() && !l.startsWith("#")) ?? doc.title;
    for (const question of doc.questions ?? []) items.push({ question, expectedAnswer: summary.trim() });
    const seen = new Set();
    return items
      .filter((item) => {
        const k = item.question.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, count)
      .map((item) => ({ ...item, expectedDocId: doc.id, expectedDocTitle: doc.title }));
  }

  const FIXED_SUGGESTIONS = [
    "Can we waive the activation fee for a returning customer?",
    "What's the trade-in value for a cracked phone?",
    "Do we price-match competitor promotions?",
    "Can a minor without ID be added as a line?",
    "Can a customer split one bill across two cards?",
    "Is there a fee for paper statements in Quebec?"
  ];

  // -------------------------------------------------------------------------
  // Routes

  const E = "\\/api\\/admin\\/evaluations";
  const superUser = (user) => requireRole(user, "super_user");

  route("GET", new RegExp(`^${E}\\/questions$`), ({ user, req }) => {
    superUser(user);
    const programId = effectiveProgramId(user, req);
    if (programId === null) return { items: [], noProgramSelected: true, expectedAnswerReady: false };
    const items = [...questionsOf(programId)]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((q) => mapQuestion(programId, q));
    return { items, expectedAnswerReady: true };
  });

  route("GET", new RegExp(`^${E}\\/questions\\/suggestions$`), ({ user, req, url }) => {
    superUser(user);
    const raw = url.searchParams.get("days");
    const days = raw === null || raw === "" ? 30 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw badRequest("Invalid query parameters");
    const programId = requireProgram(user, req);
    const inSet = new Set(questionsOf(programId).map((q) => q.question.trim().toLowerCase()));
    const matches = (row) => row.programId === programId && (row.refused || row.flaggedMissing || (row.feedback ?? 0) < 0) && row.question.trim();
    const all = getState().queryLog.filter(matches);
    if (all.length === 0) {
      return {
        items: FIXED_SUGGESTIONS.map((question, index) => ({
          question,
          askCount: 6 - index,
          lastAskedAt: iso(Date.now() - (index + 1) * 0.7 * DAY),
          outcome: index % 3 === 2 ? "flagged" : "refused",
          alreadyInSet: inSet.has(question.toLowerCase())
        }))
      };
    }
    const since = Date.now() - days * DAY;
    const groups = new Map();
    for (const row of all) {
      if (Date.parse(row.createdAt) < since) continue;
      const key = row.question.trim().toLowerCase();
      const g = groups.get(key) ?? { question: row.question.trim(), askCount: 0, lastMs: 0, refused: false };
      g.askCount += 1;
      const at = Date.parse(row.createdAt);
      if (at > g.lastMs) {
        g.lastMs = at;
        g.question = row.question.trim();
      }
      g.refused ||= row.refused === true;
      groups.set(key, g);
    }
    const items = [...groups.entries()]
      .map(([key, g]) => ({
        question: g.question,
        askCount: g.askCount,
        lastAskedAt: iso(g.lastMs),
        outcome: g.refused ? "refused" : "flagged",
        alreadyInSet: inSet.has(key)
      }))
      .sort((a, b) => b.askCount - a.askCount || b.lastAskedAt.localeCompare(a.lastAskedAt))
      .slice(0, MAX_SUGGESTIONS);
    return { items };
  });

  route("POST", new RegExp(`^${E}\\/questions$`), ({ user, req, body, res }) => {
    superUser(user);
    const parsed = parseQuestion(body);
    if (parsed.error) throw badRequest(parsed.error);
    const programId = requireProgram(user, req);
    const outcome = createQuestion(programId, parsed.data);
    if (outcome.error) throw new HttpError(outcome.status, outcome.error);
    res.statusCode = 201;
    return { item: outcome.item };
  });

  route("POST", new RegExp(`^${E}\\/questions\\/bulk$`), ({ user, req, body }) => {
    superUser(user);
    const items = body?.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
      throw badRequest("Send between 1 and 100 questions");
    }
    const programId = requireProgram(user, req);
    const created = [];
    const errors = [];
    items.forEach((raw, index) => {
      const parsed = parseQuestion(raw);
      if (parsed.error) {
        errors.push({ index, error: parsed.error });
        return;
      }
      const outcome = createQuestion(programId, parsed.data);
      if (outcome.error) errors.push({ index, error: outcome.error });
      else created.push(outcome.item);
    });
    return { created, errors };
  });

  route("POST", new RegExp(`^${E}\\/questions\\/draft$`), async ({ user, req, body }) => {
    superUser(user);
    const count = body?.count === undefined ? 5 : body.count;
    if (!body || !isUuid(body.documentId) || !Number.isInteger(count) || count < 1 || count > 10) {
      throw badRequest("Invalid draft request");
    }
    const programId = requireProgram(user, req);
    const doc = findDoc(programId, body.documentId);
    if (!doc) throw new HttpError(404, "Source not found in this program");
    await new Promise((resolve) => setTimeout(resolve, DRAFT_DELAY_MS));
    return { items: draftFrom(doc, count) };
  });

  route("PUT", new RegExp(`^${E}\\/questions\\/([^/]+)$`), ({ user, req, params, body }) => {
    superUser(user);
    const parsed = parseQuestion(body);
    if (!isUuid(params[0]) || parsed.error === "Invalid evaluation question") throw badRequest("Invalid evaluation question");
    if (parsed.error) throw badRequest(parsed.error);
    const programId = requireProgram(user, req);
    const q = questionsOf(programId).find((x) => x.id === params[0].toLowerCase());
    if (!q) throw new HttpError(404, "Evaluation question not found");
    const data = parsed.data;
    if (data.expectedDocId && !findDoc(programId, data.expectedDocId)) {
      throw badRequest("Expected document must belong to the selected program");
    }
    q.question = data.question;
    q.expectedDocId = data.expectedDocId;
    q.expectedAnswerContains = data.expectedAnswerContains;
    q.expectedAnswer = data.expectedAnswer;
    q.notes = data.notes;
    if (data.isProtected !== undefined) q.isProtected = data.isProtected;
    // An edited question no longer matches its seeded pass text.
    q.goodAnswer = null;
    q.citeDocId = null;
    return { item: mapQuestion(programId, q) };
  });

  route("DELETE", new RegExp(`^${E}\\/questions\\/([^/]+)$`), ({ user, req, params }) => {
    superUser(user);
    if (!isUuid(params[0])) throw badRequest("Invalid question id");
    const programId = requireProgram(user, req);
    const list = questionsOf(programId);
    const index = list.findIndex((x) => x.id === params[0].toLowerCase());
    if (index < 0) throw new HttpError(404, "Evaluation question not found");
    list.splice(index, 1);
    return undefined;
  });

  route("GET", new RegExp(`^${E}\\/runs$`), ({ user, req, url }) => {
    superUser(user);
    const raw = url.searchParams.get("limit");
    const limit = raw === null || raw === "" ? 20 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw badRequest("Invalid query parameters");
    const programId = effectiveProgramId(user, req);
    if (programId === null) return { persistenceReady: true, items: [], noProgramSelected: true };
    const runs = runsOf(programId).map((r) => advance(r));
    const sorted = [...runs].sort((a, b) => b.createdMs - a.createdMs || b.id.localeCompare(a.id));
    const page = sorted.slice(0, limit);
    // listEvalRuns: the baseline is appended when it falls outside the page.
    const baseline = sorted.find((r) => r.isBaseline);
    if (baseline && !page.includes(baseline)) page.push(baseline);
    return { items: page.map(toItem), persistenceReady: true, noProgramSelected: false };
  });

  route("POST", new RegExp(`^${E}\\/runs$`), ({ user, req, body, res }) => {
    superUser(user);
    const input = parseRunBody(body);
    const programId = requireProgram(user, req);
    const pool = questionsOf(programId);
    const chosen = input.questionId ? pool.filter((q) => q.id === input.questionId.toLowerCase()) : pool;
    if (chosen.length === 0) {
      throw new HttpError(
        input.questionId ? 404 : 409,
        input.questionId ? "Evaluation question not found" : "Add at least one evaluation question before starting a run"
      );
    }
    if (chosen.length > MAX_QUESTIONS_PER_RUN) {
      throw new HttpError(409, `A run is limited to ${MAX_QUESTIONS_PER_RUN} questions. Run one question or trim the set first.`);
    }
    const runs = runsOf(programId);
    // The partial unique index on eval_runs allows one queued or running run per program.
    if (runs.map((r) => advance(r)).some((r) => r.status === "queued" || r.status === "running")) {
      throw new HttpError(409, "An evaluation is already running for this program");
    }
    const ordered = [...chosen].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const run = {
      id: nextId(),
      programId,
      status: "queued",
      questionId: input.questionId ? input.questionId.toLowerCase() : null,
      judge: input.judge,
      trial: input.trial,
      snapshot: ordered.map((q) => snapshotOf(programId, q)),
      createdMs: Date.now(),
      startedMs: null,
      finishedMs: null,
      completedQuestions: 0,
      configuration: null,
      report: null,
      error: null,
      isBaseline: false
    };
    runs.push(run);
    res.statusCode = 202;
    return { item: toItem(run) };
  });

  route("GET", new RegExp(`^${E}\\/runs\\/([^/]+)$`), ({ user, req, params }) => {
    superUser(user);
    if (!isUuid(params[0])) throw badRequest("Invalid run id");
    const run = runById(requireProgram(user, req), params[0].toLowerCase());
    return { item: toItem(run), report: run.report ? structuredClone(run.report) : null };
  });

  route("POST", new RegExp(`^${E}\\/runs\\/([^/]+)\\/cancel$`), ({ user, req, params }) => {
    superUser(user);
    if (!isUuid(params[0])) throw badRequest("Invalid run id");
    const run = runById(requireProgram(user, req), params[0].toLowerCase());
    if (run.status !== "queued" && run.status !== "running") {
      throw new HttpError(409, "Only a queued or running evaluation can be cancelled");
    }
    run.status = "failed";
    // persistence.ts cancelEvalRun writes this exact message.
    run.error = "Cancelled by super user";
    run.finishedMs = Date.now();
    return { item: toItem(run) };
  });

  route("POST", new RegExp(`^${E}\\/runs\\/([^/]+)\\/baseline$`), ({ user, req, params }) => {
    superUser(user);
    if (!isUuid(params[0])) throw badRequest("Invalid run id");
    const programId = requireProgram(user, req);
    const run = runById(programId, params[0].toLowerCase());
    if (run.status !== "completed") throw new HttpError(409, "Only a completed run can be the baseline");
    for (const other of runsOf(programId)) other.isBaseline = false;
    run.isBaseline = true;
    return { item: toItem(run) };
  });
}
