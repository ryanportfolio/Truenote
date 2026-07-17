import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSafeCodeqlBaseline } from "./codeql-sarif-baseline.js";
import { verifyVulnerabilityBaseline } from "./vulnerability-baseline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultBaselinePath = resolve(
  repoRoot,
  "docs/compliance/pci/codeql-baseline-2026-07-16.json"
);
const registerPath = resolve(repoRoot, "docs/compliance/pci/vulnerability-register.md");

interface Arguments {
  sarif?: string;
  output: string;
  repository: string;
  runId?: number;
  commit?: string;
  commitBinding: "sarif-provenance" | "external-run-receipt";
  runReceiptUrl?: string;
  artifactId?: number;
  artifactName: string;
  expectedArtifactSha256?: string;
  artifactExpiresAt?: string;
  verifiedAvailableAt?: string;
  allowRemoved: boolean;
  migrateV1Unmanaged: boolean;
  write: boolean;
  mappings: Map<string, string>;
}

function usage(): string {
  return [
    "Usage: pnpm --filter @workspace/scripts run import:codeql -- [options]",
    "",
    "Required:",
    "  --sarif <restricted-path>",
    "  --run-id <positive-integer>",
    "  --commit <40-character-lowercase-sha>",
    "  --artifact-id <positive-integer>",
    "  --expected-artifact-sha256 <64-character-hex>",
    "  --artifact-expires-at <timestamp>",
    "  --verified-available-at <timestamp>",
    "",
    "Options:",
    "  --run-receipt-url <github-actions-run-url>  Required only for external-run-receipt binding",
    "  --map <rule-id=TN-VULN-YYYY-NNN>  Map a new rule to a reviewed register group (repeatable)",
    "  --allow-removed                       Acknowledge already-reconciled missing prior findings",
    "  --migrate-v1-unmanaged                One-time migration; refuses any managed legacy finding",
    "  --write                               Write the safe baseline; otherwise dry-run only",
    "  --output <path>                       Safe JSON output path",
    "  --repository <owner/name>             Default: ryanportfolio/Truenote",
    "  --artifact-name <name/javascript.sarif>",
    "  --commit-binding <external-run-receipt|sarif-provenance>",
    "  --help"
  ].join("\n");
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = {
    output: defaultBaselinePath,
    repository: "ryanportfolio/Truenote",
    artifactName: "truenote-codeql-sarif/javascript.sarif",
    commitBinding: "external-run-receipt",
    allowRemoved: false,
    migrateV1Unmanaged: false,
    write: false,
    mappings: new Map()
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = argv[index + 1];
    switch (argument) {
      case "--":
        break;
      case "--help":
        console.log(usage());
        process.exit(0);
      case "--sarif":
        parsed.sarif = value;
        index += 1;
        break;
      case "--output":
        parsed.output = resolve(value ?? "");
        index += 1;
        break;
      case "--repository":
        parsed.repository = value ?? "";
        index += 1;
        break;
      case "--run-id":
        parsed.runId = positiveInteger(value, "--run-id");
        index += 1;
        break;
      case "--commit":
        parsed.commit = value;
        index += 1;
        break;
      case "--commit-binding":
        if (value !== "external-run-receipt" && value !== "sarif-provenance") {
          throw new Error("--commit-binding must identify external-run-receipt or sarif-provenance");
        }
        parsed.commitBinding = value;
        index += 1;
        break;
      case "--run-receipt-url":
        parsed.runReceiptUrl = value;
        index += 1;
        break;
      case "--artifact-id":
        parsed.artifactId = positiveInteger(value, "--artifact-id");
        index += 1;
        break;
      case "--artifact-name":
        parsed.artifactName = value ?? "";
        index += 1;
        break;
      case "--expected-artifact-sha256":
        parsed.expectedArtifactSha256 = value?.toUpperCase();
        index += 1;
        break;
      case "--artifact-expires-at":
        parsed.artifactExpiresAt = value;
        index += 1;
        break;
      case "--verified-available-at":
        parsed.verifiedAvailableAt = value;
        index += 1;
        break;
      case "--map": {
        if (!value?.includes("=")) throw new Error("--map must use rule-id=register-id");
        const separator = value.lastIndexOf("=");
        parsed.mappings.set(value.slice(0, separator), value.slice(separator + 1));
        index += 1;
        break;
      }
      case "--allow-removed":
        parsed.allowRemoved = true;
        break;
      case "--migrate-v1-unmanaged":
        parsed.migrateV1Unmanaged = true;
        break;
      case "--write":
        parsed.write = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.sarif) throw new Error("--sarif is required");
  if (!parsed.runId) throw new Error("--run-id is required");
  if (!parsed.commit) throw new Error("--commit is required");
  if (!parsed.artifactId) throw new Error("--artifact-id is required");
  if (!parsed.expectedArtifactSha256 || !/^[A-F0-9]{64}$/.test(parsed.expectedArtifactSha256)) {
    throw new Error("--expected-artifact-sha256 must be 64 hexadecimal characters");
  }
  if (!parsed.artifactExpiresAt) throw new Error("--artifact-expires-at is required");
  if (!parsed.verifiedAvailableAt) throw new Error("--verified-available-at is required");
  if (parsed.commitBinding === "external-run-receipt" && !parsed.runReceiptUrl) {
    throw new Error("--run-receipt-url is required for external run-receipt binding");
  }
  if (parsed.commitBinding === "sarif-provenance" && parsed.runReceiptUrl) {
    throw new Error("--run-receipt-url must be omitted for SARIF-provenance binding");
  }
  return parsed;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export function atomicWriteIfUnchanged(
  output: string,
  originalBytes: Buffer | null,
  serialized: string
): void {
  const currentBytes = existsSync(output) ? readFileSync(output) : null;
  if (
    (originalBytes === null) !== (currentBytes === null) ||
    (originalBytes !== null && currentBytes !== null && sha256(originalBytes) !== sha256(currentBytes))
  ) {
    throw new Error("safe baseline changed during import; rerun to preserve the newer management evidence");
  }
  const temporary = `${output}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, output);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function legacyMappingsAndSafety(existing: unknown): Map<string, string> {
  const root = record(existing);
  if (root?.schemaVersion !== 1 || !Array.isArray(root.findings)) {
    throw new Error("--migrate-v1-unmanaged requires a schemaVersion 1 baseline");
  }
  const mappings = new Map<string, string>();
  for (const rawFinding of root.findings) {
    const finding = record(rawFinding);
    if (
      !finding ||
      finding.status !== "open" ||
      finding.owner !== null ||
      finding.due !== null ||
      finding.disposition !== "pending" ||
      finding.approver !== null ||
      finding.exceptionExpires !== null ||
      finding.retestArtifact !== null
    ) {
      throw new Error("legacy migration refuses to discard any management decision");
    }
    if (typeof finding.ruleId !== "string" || typeof finding.registerId !== "string") {
      throw new Error("legacy baseline contains an invalid rule/register mapping");
    }
    const current = mappings.get(finding.ruleId);
    if (current && current !== finding.registerId) {
      throw new Error(`legacy baseline has conflicting mappings for ${finding.ruleId}`);
    }
    mappings.set(finding.ruleId, finding.registerId);
  }
  return mappings;
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const sarifBytes = readFileSync(resolve(args.sarif!));
  const sarif = JSON.parse(sarifBytes.toString("utf8")) as unknown;
  const originalOutputBytes = existsSync(args.output) ? readFileSync(args.output) : null;
  const existing = originalOutputBytes
    ? (JSON.parse(originalOutputBytes.toString("utf8")) as unknown)
    : undefined;
  let existingForPreservation = existing;
  if (args.migrateV1Unmanaged) {
    const legacyMappings = legacyMappingsAndSafety(existing);
    for (const [ruleId, registerId] of legacyMappings) {
      if (!args.mappings.has(ruleId)) args.mappings.set(ruleId, registerId);
    }
    existingForPreservation = undefined;
  } else if (existing !== undefined) {
    const register = readFileSync(registerPath, "utf8");
    const existingVerification = verifyVulnerabilityBaseline(existing, register);
    if (existingVerification.issues.length > 0) {
      throw new Error(
        `existing safe baseline failed structural verification:\n- ${existingVerification.issues.join("\n- ")}`
      );
    }
  }

  const artifactSha256 = sha256(sarifBytes);
  if (artifactSha256 !== args.expectedArtifactSha256) {
    throw new Error("SARIF SHA-256 does not match --expected-artifact-sha256");
  }
  const result = buildSafeCodeqlBaseline({
    sarif,
    source: {
      repository: args.repository,
      runId: args.runId!,
      commit: args.commit!,
      commitBinding: args.commitBinding,
      runReceiptUrl: args.runReceiptUrl ?? null,
      artifactId: args.artifactId!,
      artifactName: args.artifactName,
      artifactSha256,
      artifactExpiresAt: args.artifactExpiresAt!,
      verifiedAvailableAt: args.verifiedAvailableAt!
    },
    existing: existingForPreservation,
    ruleMappings: args.mappings,
    allowRemoved: args.allowRemoved
  });

  const register = readFileSync(registerPath, "utf8");
  const verification = verifyVulnerabilityBaseline(result.baseline, register);
  if (verification.issues.length > 0) {
    throw new Error(`safe baseline failed structural verification:\n- ${verification.issues.join("\n- ")}`);
  }
  if (args.write) {
    atomicWriteIfUnchanged(
      args.output,
      originalOutputBytes,
      `${JSON.stringify(result.baseline, null, 2)}\n`
    );
  }
  console.log(
    `CodeQL safe import ${args.write ? "written" : "dry-run"}: ${result.summary.imported} active findings; ${result.summary.preservedFindingIds.length} preserved, ${result.summary.addedFindingIds.length} added, ${result.summary.removedFindingIds.length} removed.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
