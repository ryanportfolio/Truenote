import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePciJsonText, verifyPciScopeDecision } from "./pci-scope-decision.js";

const STAGES = new Set(["provisional_test_authorization", "final_scope_acceptance"]);

function usage(): void {
  console.error(
    "Usage: pnpm --filter @workspace/scripts run verify:pci-scope-decision -- " +
    "<decision.json> --require-stage <provisional_test_authorization|final_scope_acceptance> " +
    "[--provisional <provisional.json> --trace-receipt <trace-receipt.json>]"
  );
}

function main(): void {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  let path: string | null = null;
  let requiredStage: string | null = null;
  let provisionalPath: string | null = null;
  let traceReceiptPath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--require-stage") {
      requiredStage = args[index + 1] ?? null;
      index += 1;
    } else if (argument === "--provisional") {
      provisionalPath = args[index + 1] ?? null;
      index += 1;
    } else if (argument === "--trace-receipt") {
      traceReceiptPath = args[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--") || path !== null) {
      usage();
      process.exitCode = 2;
      return;
    } else {
      path = argument;
    }
  }
  if (!path || !requiredStage || !STAGES.has(requiredStage)) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (
    (requiredStage === "final_scope_acceptance" && (!provisionalPath || !traceReceiptPath)) ||
    (requiredStage === "provisional_test_authorization" && (provisionalPath || traceReceiptPath))
  ) {
    usage();
    process.exitCode = 2;
    return;
  }
  try {
    const root = process.env.INIT_CWD ?? process.cwd();
    const input = parsePciJsonText(readFileSync(resolve(root, path), "utf8"));
    const provisionalRecordBytes = provisionalPath ? readFileSync(resolve(root, provisionalPath)) : undefined;
    const traceReceiptBytes = traceReceiptPath ? readFileSync(resolve(root, traceReceiptPath)) : undefined;
    const result = verifyPciScopeDecision(input, {
      now: new Date(),
      provisionalRecordBytes,
      traceReceiptBytes
    });
    if (
      result.issues.length > 0 ||
      !result.structurallyAccepted ||
      result.stage !== requiredStage ||
      (requiredStage === "final_scope_acceptance" && !result.structurallyFinalAccepted)
    ) {
      console.error("PCI scope decision record failed:");
      for (const issue of result.issues) console.error(`- ${issue}`);
      if (result.stage !== requiredStage) {
        console.error(`- record stage ${result.stage ?? "invalid"} does not match required stage ${requiredStage}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(
      `PCI scope decision record passed: stage=${result.stage}; ` +
      `structurallyFinalAccepted=${result.structurallyFinalAccepted}.`
    );
  } catch (error) {
    console.error(`PCI scope decision record could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();
