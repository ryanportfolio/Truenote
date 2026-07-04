/**
 * Eval harness runner.
 *
 * Usage (Replit or local with secrets loaded):
 *   pnpm --filter @workspace/scripts run eval
 *   pnpm --filter @workspace/scripts run eval -- --program <uuid>
 *   pnpm --filter @workspace/scripts run eval -- --question <uuid>
 *   pnpm --filter @workspace/scripts run eval -- --limit 5
 *   pnpm --filter @workspace/scripts run eval -- --json > result.json
 *
 * Calls the same retrieve() + generateAnswer() functions /api/ask uses,
 * scores each eval_question, and prints a summary. Exits non-zero if
 * any question fails — useful for CI gating once we get there.
 *
 * NOTE: each question burns embedding + generation tokens (~$0.001 per
 * question at current pricing). Don't run this in a loop without a
 * reason. The DDL doesn't auto-rerun on schema changes; the only
 * cost is when this script is invoked.
 */
import { runEval, type EvalRunOptions, type EvalQuestionResult } from "../../artifacts/api-server/src/lib/eval/runner.js";
import { closePool } from "../../artifacts/api-server/src/lib/db-client.js";

interface CliArgs {
  programId?: string;
  questionId?: string;
  limit?: number;
  json: boolean;
  help: boolean;
  judge: boolean;
  /** Env overrides for retrieval-parameter sweeps. Applied before runEval. */
  overrides: Record<string, string>;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, help: false, judge: false, overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--program" || a === "-p") {
      args.programId = argv[++i];
    } else if (a === "--question" || a === "-q") {
      args.questionId = argv[++i];
    } else if (a === "--limit" || a === "-n") {
      const next = argv[++i];
      args.limit = next !== undefined ? Number.parseInt(next, 10) : undefined;
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--judge") {
      args.judge = true;
    } else if (a === "--top-k") {
      const v = argv[++i];
      if (v !== undefined) args.overrides["RETRIEVAL_TOP_K"] = v;
    } else if (a === "--candidate-k") {
      const v = argv[++i];
      if (v !== undefined) args.overrides["RETRIEVAL_CANDIDATE_K"] = v;
    } else if (a === "--threshold") {
      const v = argv[++i];
      if (v !== undefined) args.overrides["RERANK_CONFIDENCE_THRESHOLD"] = v;
    } else if (a === "--neighbors") {
      const v = argv[++i];
      if (v !== undefined) args.overrides["RETRIEVAL_NEIGHBOR_ANCHORS"] = v;
    } else if (a === "--rerank-model") {
      const v = argv[++i];
      if (v !== undefined) args.overrides["COHERE_RERANK_MODEL"] = v;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: pnpm --filter @workspace/scripts run eval [--] [options]

Options:
  --program, -p <uuid>    Run only questions for one program
  --question, -q <uuid>   Run a single question by id
  --limit, -n <int>       Cap the number of questions
  --judge                 Claim-level faithfulness judge on every non-refused
                          answer (one extra gpt-4o call per judged question)
  --json                  Emit the full report as JSON on stdout
                          (suppresses the human-readable summary)
  --help, -h              Show this help

Parameter-sweep overrides (set the corresponding env var for this run only —
use to tune before changing Replit Secrets):
  --top-k <int>           RETRIEVAL_TOP_K
  --candidate-k <int>     RETRIEVAL_CANDIDATE_K
  --threshold <float>     RERANK_CONFIDENCE_THRESHOLD
  --neighbors <int>       RETRIEVAL_NEIGHBOR_ANCHORS (0 disables expansion)
  --rerank-model <name>   COHERE_RERANK_MODEL (e.g. rerank-v3.5)`);
}

/**
 * Human-readable summary block. Used when --json is not set. Designed
 * to fit on one terminal screen so an operator can spot regressions
 * at a glance. The per-question detail (failures only) follows below.
 */
function printSummary(report: Awaited<ReturnType<typeof runEval>>): void {
  const s = report.summary;
  const pct = (x: number | null): string =>
    x === null ? "n/a" : `${x.toFixed(1)}%`;
  const fs = s.inKbFailuresByStage;
  const stageLine =
    fs.retrieval + fs.rerank + fs.threshold + fs.generation + fs.unattributed === 0
      ? "none"
      : `retrieval ${fs.retrieval} · rerank ${fs.rerank} · threshold ${fs.threshold} · generation ${fs.generation} · unattributed ${fs.unattributed}`;
  console.log(`
eval — ${report.startedAt} → ${report.finishedAt} (${report.durationMs}ms)

  questions: ${s.totalQuestions}    passed: ${s.passed}    failed: ${s.failed}
  in-KB:     ${s.inKbPassed}/${s.inKbTotal}    out-of-KB: ${s.outOfKbPassed}/${s.outOfKbTotal}
  citation:  ${pct(s.citationAccuracyPct)}    answer: ${pct(s.answerAccuracyPct)}
  recall:    candidates ${pct(s.retrievalRecallPct)}    post-rerank ${pct(s.rerankRecallPct)}    mean doc rank ${s.expectedDocRankMean === null ? "n/a" : s.expectedDocRankMean.toFixed(1)}
  in-KB failure stages: ${stageLine}${
    s.judgedQuestions > 0
      ? `\n  faithfulness: ${pct(s.meanFaithfulnessPct)} mean over ${s.judgedQuestions} judged — ${s.unfaithfulQuestions} answer(s) with unsupported claims`
      : ""
  }
  latency:   p50 ${s.latencyP50Ms}ms  p95 ${s.latencyP95Ms}ms
`);

  const failures = report.results.filter((r) => !r.pass);
  // A question can PASS the phrase/citation checks while the judge still
  // found ungrounded claims — the exact failure mode phrase-matching can't
  // see. Surface those separately so they don't hide inside a green run.
  const unfaithfulPasses = report.results.filter(
    (r) => r.pass && r.unsupportedClaims.length > 0
  );
  if (failures.length === 0 && unfaithfulPasses.length === 0) {
    console.log("  all questions passed.\n");
    return;
  }
  if (failures.length > 0) {
    console.log(`  ${failures.length} failure(s):\n`);
    for (const r of failures) {
      console.log(`  [${r.kind}] ${r.questionId.slice(0, 8)}…  ${r.question.slice(0, 80)}`);
      if (r.error) {
        console.log(`    ERROR: ${r.error}`);
        continue;
      }
      const reasons = collectFailureReasons(r);
      for (const reason of reasons) console.log(`    - ${reason}`);
    }
    console.log("");
  }
  if (unfaithfulPasses.length > 0) {
    console.log(`  ${unfaithfulPasses.length} passing answer(s) with unsupported claims:\n`);
    for (const r of unfaithfulPasses) {
      console.log(`  [${r.kind}] ${r.questionId.slice(0, 8)}…  ${r.question.slice(0, 80)}`);
      for (const claim of r.unsupportedClaims) {
        console.log(`    - unsupported claim: "${claim}"`);
      }
    }
    console.log("");
  }
}

function collectFailureReasons(r: EvalQuestionResult): string[] {
  const reasons: string[] = [];
  if (r.failureStage) {
    reasons.push(`lost at stage: ${r.failureStage}`);
  }
  if (r.kind === "out-of-kb" && !r.refused) {
    reasons.push("expected refusal but the system answered");
  }
  if (r.kind === "in-kb" && r.refused) {
    reasons.push("system refused on an in-KB question");
  }
  if (r.citationCorrect === false && r.expectedDocId) {
    reasons.push(
      `expected doc ${r.expectedDocId.slice(0, 8)}… not in cited docs ` +
        `[${r.citedDocIds.map((d) => d.slice(0, 8) + "…").join(", ") || "none"}]`
    );
  }
  for (const p of r.phrasesPresent) {
    if (!p.present) reasons.push(`missing phrase: "${p.phrase}"`);
  }
  for (const claim of r.unsupportedClaims) {
    reasons.push(`unsupported claim: "${claim}"`);
  }
  return reasons;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  // Parameter-sweep overrides: retrieve() reads these env vars per call, so
  // setting them here scopes the override to this run without touching
  // Replit Secrets.
  for (const [key, value] of Object.entries(args.overrides)) {
    process.env[key] = value;
  }
  if (!args.json && Object.keys(args.overrides).length > 0) {
    const pairs = Object.entries(args.overrides)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    console.log(`[eval] overrides for this run: ${pairs}`);
  }

  const opts: EvalRunOptions = {};
  if (args.programId) opts.programId = args.programId;
  if (args.questionId) opts.questionId = args.questionId;
  if (args.limit && Number.isFinite(args.limit)) opts.limit = args.limit;
  if (args.judge) opts.judge = true;

  const report = await runEval(opts);

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    printSummary(report);
  }

  await closePool();

  // Exit non-zero if anything failed so a CI gate can treat this as a
  // boolean signal. The full report is still on stdout/JSON for
  // downstream inspection.
  if (report.summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[eval] fatal:", err);
  process.exit(1);
});
