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
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, help: false };
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
  --json                  Emit the full report as JSON on stdout
                          (suppresses the human-readable summary)
  --help, -h              Show this help`);
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
  console.log(`
eval — ${report.startedAt} → ${report.finishedAt} (${report.durationMs}ms)

  questions: ${s.totalQuestions}    passed: ${s.passed}    failed: ${s.failed}
  in-KB:     ${s.inKbPassed}/${s.inKbTotal}    out-of-KB: ${s.outOfKbPassed}/${s.outOfKbTotal}
  citation:  ${pct(s.citationAccuracyPct)}    answer: ${pct(s.answerAccuracyPct)}
  latency:   p50 ${s.latencyP50Ms}ms  p95 ${s.latencyP95Ms}ms
`);

  const failures = report.results.filter((r) => !r.pass);
  if (failures.length === 0) {
    console.log("  all questions passed.\n");
    return;
  }
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

function collectFailureReasons(r: EvalQuestionResult): string[] {
  const reasons: string[] = [];
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
  return reasons;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const opts: EvalRunOptions = {};
  if (args.programId) opts.programId = args.programId;
  if (args.questionId) opts.questionId = args.questionId;
  if (args.limit && Number.isFinite(args.limit)) opts.limit = args.limit;

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
