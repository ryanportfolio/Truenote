import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyBranchEnforcementEvidence } from "./branch-enforcement-evidence.js";
import { parsePciJsonText } from "./pci-scope-decision.js";

function main(): void {
  const path = process.argv.slice(2).find((argument) => argument !== "--");
  if (!path) {
    console.error("Usage: pnpm --filter @workspace/scripts run verify:branch-enforcement -- <evidence.json>");
    process.exitCode = 2;
    return;
  }
  try {
    const root = process.env.INIT_CWD ?? process.cwd();
    const input = parsePciJsonText(readFileSync(resolve(root, path), "utf8"));
    const codeownersPath = typeof input === "object" && input !== null && !Array.isArray(input)
      && typeof (input as { codeowners?: { path?: unknown } }).codeowners?.path === "string"
      ? (input as { codeowners: { path: string } }).codeowners.path
      : null;
    const allowedCodeownersPath = codeownersPath === ".github/CODEOWNERS"
      ? resolve(root, codeownersPath)
      : null;
    const codeownersText = allowedCodeownersPath && existsSync(allowedCodeownersPath)
      ? readFileSync(allowedCodeownersPath, "utf8")
      : undefined;
    const result = verifyBranchEnforcementEvidence(input, { now: new Date(), codeownersText });
    if (result.issues.length > 0 || !result.structurallyAccepted) {
      console.error("Branch enforcement evidence failed:");
      for (const issue of result.issues) console.error(`- ${issue}`);
      process.exitCode = 1;
      return;
    }
    console.log("Branch enforcement evidence passed: structurallyAccepted=true.");
  } catch (error) {
    console.error(`Branch enforcement evidence could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();
