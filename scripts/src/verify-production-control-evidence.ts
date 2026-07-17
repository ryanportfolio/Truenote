import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePciJsonText, verifyPciScopeDecision } from "./pci-scope-decision.js";
import { verifyProductionControlEvidence } from "./production-control-evidence.js";

function usage(): void {
  console.error(
    "Usage: pnpm --filter @workspace/scripts run verify:production-controls -- " +
    "--record <production-record.json> --scope <final-scope.json> " +
    "--provisional <provisional-scope.json> --trace-receipt <trace-receipt.json>"
  );
}

function main(): void {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const values = new Map<string, string>();
  const allowed = new Set(["--record", "--scope", "--provisional", "--trace-receipt"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value || !allowed.has(flag) || values.has(flag)) {
      usage();
      process.exitCode = 2;
      return;
    }
    values.set(flag, value);
  }
  if ([...allowed].some((flag) => !values.has(flag))) {
    usage();
    process.exitCode = 2;
    return;
  }
  try {
    const root = process.env.INIT_CWD ?? process.cwd();
    const read = (flag: string): Buffer => readFileSync(resolve(root, values.get(flag)!));
    const recordBytes = read("--record");
    const finalScopeRecordBytes = read("--scope");
    const provisionalRecordBytes = read("--provisional");
    const traceReceiptBytes = read("--trace-receipt");
    const now = new Date();
    const finalScopeResult = verifyPciScopeDecision(
      parsePciJsonText(finalScopeRecordBytes.toString("utf8")),
      { now, provisionalRecordBytes, traceReceiptBytes }
    );
    const result = verifyProductionControlEvidence(parsePciJsonText(recordBytes.toString("utf8")), {
      now,
      finalScopeRecordBytes,
      finalScopeStructurallyAccepted: finalScopeResult.structurallyFinalAccepted && finalScopeResult.issues.length === 0
    });
    const issues = [
      ...finalScopeResult.issues.map((issue) => `scope: ${issue}`),
      ...result.issues.map((issue) => `production: ${issue}`)
    ];
    if (!result.structurallyAccepted || issues.length > 0) {
      console.error("Production control evidence failed:");
      for (const issue of issues) console.error(`- ${issue}`);
      process.exitCode = 1;
      return;
    }
    console.log("Production control evidence passed: final scope and all declared exercise applicability/results structurally accepted.");
  } catch (error) {
    console.error(`Production control evidence could not be read: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();
