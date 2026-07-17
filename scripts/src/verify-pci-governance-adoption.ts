import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PCI_GOVERNANCE_POLICY_SPECS,
  verifyPciPolicyAdoption,
  verifyPciRoleAssignments
} from "./pci-governance-adoption.js";
import { parsePciJsonText } from "./pci-scope-decision.js";

function usage(): void {
  console.error(
    "Usage: pnpm --filter @workspace/scripts run verify:pci-governance-adoption -- " +
    "--roles <role-assignment.json> --policy <policy-adoption.json>"
  );
}

function main(): void {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  let rolesPath: string | null = null;
  let policyPath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--roles" && rolesPath === null) {
      rolesPath = args[index + 1] ?? null;
      index += 1;
    } else if (argument === "--policy" && policyPath === null) {
      policyPath = args[index + 1] ?? null;
      index += 1;
    } else {
      usage();
      process.exitCode = 2;
      return;
    }
  }
  if (!rolesPath || !policyPath) {
    usage();
    process.exitCode = 2;
    return;
  }

  try {
    const root = process.env.INIT_CWD ?? process.cwd();
    const roleAssignmentRecordBytes = readFileSync(resolve(root, rolesPath));
    const roleInput = parsePciJsonText(roleAssignmentRecordBytes.toString("utf8"));
    const policyInput = parsePciJsonText(readFileSync(resolve(root, policyPath), "utf8"));
    const policyDocumentBytes = Object.fromEntries(
      PCI_GOVERNANCE_POLICY_SPECS.map((spec) => [spec.id, readFileSync(resolve(root, spec.path))])
    );
    const now = new Date();
    const roleResult = verifyPciRoleAssignments(roleInput, { now });
    const policyResult = verifyPciPolicyAdoption(policyInput, {
      now,
      roleAssignmentRecordBytes,
      policyDocumentBytes
    });
    const issues = [
      ...roleResult.issues.map((issue) => `roles: ${issue}`),
      ...policyResult.issues.map((issue) => `policy: ${issue}`)
    ];
    if (!roleResult.structurallyAccepted || !policyResult.structurallyAccepted || issues.length > 0) {
      console.error("PCI governance adoption records failed:");
      for (const issue of issues) console.error(`- ${issue}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `PCI governance adoption records passed: ${PCI_GOVERNANCE_POLICY_SPECS.length} policies and linked role assignments structurally accepted.`
    );
  } catch (error) {
    console.error(`PCI governance adoption records could not be read: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();

