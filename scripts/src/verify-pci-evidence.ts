import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyChangeRecordTemplate } from "./change-record.js";
import { verifyVulnerabilityBaseline } from "./vulnerability-baseline.js";
import {
  verifyVulnerabilitySources,
  vulnerabilitySourceLocalEvidencePaths
} from "./vulnerability-sources.js";

export interface EvidenceIssue {
  source: string;
  message: string;
}

export interface EvidenceVerificationResult {
  checkedMarkdownFiles: number;
  checkedPublicGrades: number;
  checkedReadOnlySqlArtifacts: number;
  checkedHashBoundArtifacts: number;
  checkedThreats: number;
  checkedVulnerabilityFindings: number;
  checkedVulnerabilitySources: number;
  issues: EvidenceIssue[];
}

const ALLOWED_EVIDENCE_GRADES = new Set([
  "Verified",
  "Implemented, unverified",
  "Configuration required",
  "Operational evidence required",
  "Third-party evidence required",
  "Gap",
  "Not applicable"
]);

function filesBelow(directory: string, extension: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(path);
  }
  return files;
}

function localMarkdownTarget(rawTarget: string): string | null {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1);
  }
  if (/^(?:https?:|mailto:|#)/i.test(target)) return null;
  target = target.split("#", 1)[0]?.trim() ?? "";
  if (!target) return null;
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

export function verifyMarkdownLinks(
  repoRoot: string,
  markdownDirectory: string
): { checked: number; issues: EvidenceIssue[] } {
  const issues: EvidenceIssue[] = [];
  const files = filesBelow(markdownDirectory, ".md");
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(linkPattern)) {
      const target = localMarkdownTarget(match[1] ?? "");
      if (!target) continue;
      const resolvedTarget = isAbsolute(target)
        ? resolve(repoRoot, target.replace(/^[/\\]+/, ""))
        : resolve(dirname(file), target);
      if (!existsSync(resolvedTarget)) {
        issues.push({
          source: relative(repoRoot, file),
          message: `Local Markdown target does not exist: ${target}`
        });
      }
    }
  }

  return { checked: files.length, issues };
}

function activeYaml(workflow: string): string {
  return workflow
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

function workflowJob(workflow: string, jobName: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start < 0) return "";
  const next = lines.findIndex(
    (line, index) => index > start && /^  [A-Za-z0-9_-]+:\s*$/.test(line)
  );
  return lines.slice(start, next < 0 ? undefined : next).join("\n");
}

function workflowSteps(job: string): string[] {
  const lines = job.split("\n");
  const starts = lines
    .map((line, index) => (/^      -\s+/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  return starts.map((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length).join("\n")
  );
}

function stepWithRun(steps: string[], command: string): string | undefined {
  return steps.find((step) =>
    step.split("\n").some((line) =>
      new Set([`run: ${command}`, `- run: ${command}`]).has(line.trim())
    )
  );
}

export function verifySecurityWorkflow(workflow: string): string[] {
  const issues: string[] = [];
  const active = activeYaml(workflow);
  const lines = active.split("\n");
  const pullRequestLine = lines.findIndex((line) => line === "  pull_request:");
  if (pullRequestLine < 0) issues.push("pull-request trigger is missing");
  else {
    const triggerEnd = lines.findIndex(
      (line, index) => index > pullRequestLine && /^  [A-Za-z0-9_-]+:\s*$/.test(line)
    );
    const trigger = lines.slice(pullRequestLine, triggerEnd < 0 ? undefined : triggerEnd).join("\n");
    if (/^\s{4}paths-ignore:/m.test(trigger)) {
      issues.push("security workflow excludes pull-request paths");
    }
    if (!/^\s{4}types:\s*\[[^\]]*edited[^\]]*\]\s*$/m.test(trigger)) {
      issues.push("pull-request trigger does not rerun when the change record is edited");
    }
  }

  const verifyJob = workflowJob(active, "verify");
  if (!verifyJob) issues.push("verify job is missing");
  else {
    if (/^    if:/m.test(verifyJob)) issues.push("verify job must not have a job-level condition");
    const steps = workflowSteps(verifyJob);
    for (const [command, message] of [
      ["pnpm run verify:pci-evidence", "PCI evidence verifier is not an unconditional verify-job step"],
      ["corepack pnpm --filter @workspace/scripts run verify:vulnerabilities", "vulnerability baseline verifier is not an unconditional verify-job step"]
    ] as const) {
      const step = stepWithRun(steps, command);
      if (!step || /^\s+if:/m.test(step)) issues.push(message);
    }
    const changeCommand = 'corepack pnpm --filter @workspace/scripts run verify:change-record -- --event "$GITHUB_EVENT_PATH" --allow-pending';
    const changeStep = stepWithRun(steps, changeCommand);
    if (!changeStep) issues.push("pull-request change-record verifier is not a verify-job step");
    else if (!changeStep.split("\n").some(
      (line) => line.trim() === "if: github.event_name == 'pull_request'"
    )) {
      issues.push("change-record verifier is not scoped exactly to pull-request events");
    }
    const releaseStep = stepWithRun(
      steps,
      "corepack pnpm --filter @workspace/scripts run verify:vulnerabilities:release"
    );
    if (!releaseStep) issues.push("managed-release vulnerability gate is not a verify-job step");
    else if (!releaseStep.split("\n").some(
      (line) => line.trim() === "if: github.event_name == 'workflow_dispatch' && inputs.managed_release_gate"
    )) {
      issues.push("managed-release vulnerability gate lacks the explicit manual release condition");
    }
    const branchStep = stepWithRun(
      steps,
      "corepack pnpm --filter @workspace/scripts run verify:branch-enforcement -- docs/compliance/pci/branch-enforcement-evidence-current.json"
    );
    if (!branchStep) issues.push("branch-enforcement evidence gate is not a verify-job step");
    else if (!branchStep.split("\n").some(
      (line) => line.trim() === "if: github.event_name == 'workflow_dispatch' && inputs.branch_enforcement_gate"
    )) {
      issues.push("branch-enforcement evidence gate lacks the explicit manual condition");
    }
  }

  const codeqlJob = workflowJob(active, "codeql");
  if (!codeqlJob) issues.push("CodeQL job is missing");
  else {
    if (!/^\s{6}security-events:\s*write\s*$/m.test(codeqlJob)) {
      issues.push("CodeQL security-events write permission is missing from the CodeQL job");
    }
    const steps = workflowSteps(codeqlJob);
    const analyze = steps.find((step) => step.includes("uses: github/codeql-action/analyze@v4"));
    if (!analyze || !/^\s+upload:\s*always\s*$/m.test(analyze)) {
      issues.push("CodeQL analyze step is not configured to upload always");
    }
    const retain = steps.find((step) => step.includes("name: Retain CodeQL SARIF evidence"));
    if (!retain || !retain.split("\n").some((line) => line.trim() === "if: always()")) {
      issues.push("SARIF retention step is not unconditional");
    }
  }
  return issues;
}

export function verifySupplyChainSettings(
  workspaceSettings: string,
  rootPackageJson: string
): string[] {
  const issues: string[] = [];
  const allowBuildsSection =
    workspaceSettings.match(/^allowBuilds:\s*\r?\n((?:\s{2}.+(?:\r?\n|$))*)/m)?.[1] ?? "";
  const allowedBuilds = [
    ...allowBuildsSection.matchAll(/^\s{2}["']?([^"':]+)["']?:\s*true\s*$/gm)
  ].map((match) => match[1]);
  if (allowedBuilds.length !== 1 || allowedBuilds[0] !== "esbuild") {
    issues.push("esbuild is not the explicitly allowed dependency build");
  }
  const overridesSection =
    workspaceSettings.match(/^overrides:\s*\r?\n((?:\s{2}.+(?:\r?\n|$))*)/m)?.[1] ?? "";
  for (const [selector, version] of [
    ["form-data@2.5.5", "2.5.6"],
    ["form-data@4.0.5", "4.0.6"]
  ] as const) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `^\\s{2}["']?${escapedSelector}["']?:\\s*["']?${escapedVersion}["']?\\s*$`,
      "m"
    );
    if (!pattern.test(overridesSection)) {
      issues.push(`required dependency override is missing: ${selector} -> ${version}`);
    }
  }
  try {
    const packageObject = JSON.parse(rootPackageJson) as Record<string, unknown>;
    if (Object.hasOwn(packageObject, "pnpm")) {
      issues.push("pnpm project settings must live in pnpm-workspace.yaml");
    }
  } catch {
    issues.push("root package.json is not valid JSON");
  }
  return issues;
}

export function verifyReadOnlyEvidenceSql(sql: string): string[] {
  const issues: string[] = [];
  const executable = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .replace(/'(?:''|[^'])*'/g, "''");

  if (!/^\s*BEGIN\s+TRANSACTION\s+READ\s+ONLY\s*;/im.test(executable)) {
    issues.push("evidence SQL does not begin a read-only transaction");
  }
  if (!/^\s*COMMIT\s*;\s*$/im.test(executable)) {
    issues.push("evidence SQL does not end with COMMIT");
  }
  if (!/SET\s+LOCAL\s+statement_timeout\s*=/i.test(executable)) {
    issues.push("evidence SQL lacks a local statement timeout");
  }
  if (!/SET\s+LOCAL\s+lock_timeout\s*=/i.test(executable)) {
    issues.push("evidence SQL lacks a local lock timeout");
  }
  const forbiddenStatement = executable.match(
    /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|COPY)\b/im
  );
  if (forbiddenStatement) {
    issues.push(`evidence SQL contains a mutating statement: ${forbiddenStatement[1]?.toUpperCase()}`);
  }
  if (
    /\bFROM\s+(?:public\.)?(?:documents|document_versions|users|sessions|security_events|siem_delivery_outbox|content_sources)\b/i.test(
      executable
    )
  ) {
    issues.push("evidence SQL directly selects an application/security data table");
  }
  if (!/\bpassed\b/i.test(executable) || !/\bdefinition_sha256\b/i.test(executable)) {
    issues.push("evidence SQL lacks binary results or definition hashes");
  }
  return issues;
}

export function verifyThreatModel(markdown: string): {
  checked: number;
  issues: string[];
} {
  const issues: string[] = [];
  const threatRows = markdown
    .split(/\r?\n/)
    .filter((line) => /^\|\s*TN-TM-\d{3}\s*\|/.test(line));
  const ids: string[] = [];

  if (threatRows.length < 20) {
    issues.push(`threat model has fewer than 20 threat rows: ${threatRows.length}`);
  }

  for (const row of threatRows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const id = cells[0] ?? "";
    ids.push(id);
    const evidence = cells[4] ?? "";
    const grade = cells[5] ?? "";
    if (!ALLOWED_EVIDENCE_GRADES.has(grade)) {
      issues.push(`${id || "threat row"} has unsupported evidence grade: ${grade || "(empty)"}`);
    }
    if (!/`[^`]*(?:\/|\\)[^`]+`/.test(evidence)) {
      issues.push(`${id || "threat row"} lacks a repository evidence path`);
    }
  }

  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) issues.push("threat model contains duplicate threat IDs");
  for (let index = 0; index < ids.length; index += 1) {
    const expected = `TN-TM-${String(index + 1).padStart(3, "0")}`;
    if (ids[index] !== expected) {
      issues.push(`threat IDs are not contiguous at row ${index + 1}: expected ${expected}`);
      break;
    }
  }

  for (let index = 1; index <= 9; index += 1) {
    const boundary = `TB-${String(index).padStart(2, "0")}`;
    if (!markdown.includes(boundary)) issues.push(`threat model is missing trust boundary ${boundary}`);
  }
  for (const category of [
    "Spoofing",
    "Tampering",
    "Repudiation",
    "Information disclosure",
    "Denial of service",
    "Elevation of privilege",
    "prompt injection",
    "data poisoning"
  ]) {
    if (!markdown.toLowerCase().includes(category.toLowerCase())) {
      issues.push(`threat model is missing required category: ${category}`);
    }
  }

  const blockerSection =
    markdown.match(/### Release\/CDE blockers([\s\S]*?)(?:\n### |\n## |$)/)?.[1] ?? "";
  for (const blocker of ["TN-TM-011", "TN-TM-022", "TN-TM-023"]) {
    if (!blockerSection.includes(blocker)) {
      issues.push(`release/CDE blocker section is missing ${blocker}`);
    }
  }

  return { checked: threatRows.length, issues };
}

export function verifyRecordedSourceHash(
  source: string,
  verificationRecord: string,
  sourceName: string
): string[] {
  return verifyRecordedArtifactHash(source, verificationRecord, sourceName);
}

export function verifyRecordedArtifactHash(
  source: string | Uint8Array,
  verificationRecord: string,
  sourceName: string
): string[] {
  const hash = createHash("sha256").update(source).digest("hex").toUpperCase();
  const recordLine = verificationRecord
    .split(/\r?\n/)
    .find((line) => line.includes(sourceName));
  if (!recordLine) return [`verification record lacks source identity for ${sourceName}`];
  if (!recordLine.includes(hash)) {
    return [`verification record SHA-256 is stale for ${sourceName}; expected ${hash}`];
  }
  return [];
}

export function verifyPublicEvidenceGrades(html: string): {
  checked: number;
  issues: string[];
} {
  const issues: string[] = [];
  const tagPattern = /<span class="tag [^"]+">([^<]+)<\/span>/g;
  const tags = [...html.matchAll(tagPattern)];

  if (tags.length === 0) issues.push("public brief contains no evidence-grade tags");

  for (const tag of tags) {
    const grade = (tag[1] ?? "").trim();
    if (!ALLOWED_EVIDENCE_GRADES.has(grade)) {
      issues.push(`unsupported evidence grade: ${grade || "(empty)"}`);
    }

    const start = tag.index ?? 0;
    const cellEnd = html.indexOf("</td>", start);
    const nextCell = html.indexOf("<td", start + tag[0].length);
    const withinSameCell =
      cellEnd !== -1 && (nextCell === -1 || cellEnd < nextCell)
        ? html.slice(start + tag[0].length, cellEnd)
        : "";
    if (!/<span class="grade-scope">[^<]+<\/span>/.test(withinSameCell)) {
      issues.push(`evidence grade lacks an adjacent scope label: ${grade}`);
    }
  }

  return { checked: tags.length, issues };
}

export function verifyPublicEvidencePaths(
  repoRoot: string,
  html: string
): EvidenceIssue[] {
  const issues: EvidenceIssue[] = [];
  const evidenceCells = html.match(/<td class="evidence">[\s\S]*?<\/td>/g) ?? [];
  for (const cell of evidenceCells) {
    for (const match of cell.matchAll(/<code>([^<]+)<\/code>/g)) {
      const target = (match[1] ?? "").trim();
      if (!target || (!target.includes("/") && !target.includes("\\"))) continue;
      const resolvedTarget = resolve(repoRoot, target.replace(/^[/\\]+/, ""));
      if (!existsSync(resolvedTarget)) {
        issues.push({
          source: "docs/security/truenote-security-capabilities.html",
          message: `Public evidence target does not exist: ${target}`
        });
      }
    }
  }
  return issues;
}

export function verifySessionVerificationCounts(html: string): string[] {
  const issues: string[] = [];
  const section = html.match(/<section id="verification">([\s\S]*?)<\/section>/)?.[1];
  if (!section) return ["session ledger verification section is missing"];

  const tableCounts: number[] = [];
  for (const suite of ["Frontend", "API", "Scripts"] as const) {
    const card = section.match(new RegExp(
      `<p class="number">(\\d+)<\\/p><p class="label">${suite} tests current to integrated worktree<\\/p>`
    ));
    const table = section.match(new RegExp(
      `<tr><td>${suite} tests<\\/td><td><span class="status done">(\\d+)\\/(\\d+) pass<\\/span>`
    ));
    if (!card) issues.push(`${suite} current-test card is missing`);
    if (!table) {
      issues.push(`${suite} current-test detail row is missing`);
      continue;
    }
    const passed = Number(table[1]);
    const total = Number(table[2]);
    if (passed !== total) issues.push(`${suite} current-test detail row is not all-pass`);
    tableCounts.push(passed);
    if (card && Number(card[1]) !== passed) {
      issues.push(`${suite} current-test card ${card[1]} does not match detail row ${passed}`);
    }
  }

  const totalCard = section.match(
    /<p class="number">(\d+)<\/p><p class="label">Current tests passed across all three suites<\/p>/
  );
  if (!totalCard) issues.push("combined current-test card is missing");
  else if (tableCounts.length === 3) {
    const expected = tableCounts.reduce((sum, count) => sum + count, 0);
    if (Number(totalCard[1]) !== expected) {
      issues.push(`combined current-test card ${totalCard[1]} does not equal suite sum ${expected}`);
    }
  }
  return issues;
}

export function verifyPciEvidence(repoRoot: string): EvidenceVerificationResult {
  const pciDirectory = resolve(repoRoot, "docs/compliance/pci");
  const publicBriefPath = resolve(
    repoRoot,
    "docs/security/truenote-security-capabilities.html"
  );
  const workflowPath = resolve(repoRoot, ".github/workflows/security.yml");
  const pullRequestTemplatePath = resolve(repoRoot, ".github/pull_request_template.md");
  const workspacePath = resolve(repoRoot, "pnpm-workspace.yaml");
  const rootPackagePath = resolve(repoRoot, "package.json");
  const productionEvidenceSqlPath = resolve(
    repoRoot,
    "docs/compliance/pci/production-control-verification.sql"
  );
  const threatModelPath = resolve(repoRoot, "docs/compliance/pci/threat-model.md");
  const verificationRecordPath = resolve(
    repoRoot,
    "docs/compliance/pci/verification-record-2026-07-16.md"
  );
  const sessionLedgerPath = resolve(
    repoRoot,
    "docs/compliance/pci/security-readiness-session-report-2026-07-16.html"
  );
  const vulnerabilityBaselinePath = resolve(
    repoRoot,
    "docs/compliance/pci/codeql-baseline-2026-07-16.json"
  );
  const vulnerabilityRegisterPath = resolve(
    repoRoot,
    "docs/compliance/pci/vulnerability-register.md"
  );
  const vulnerabilitySourceRegisterPath = resolve(
    repoRoot,
    "docs/compliance/pci/vulnerability-source-register-2026-07-16.json"
  );
  const openRouterGuardrailRecordPath = resolve(
    repoRoot,
    "docs/compliance/pci/openrouter-guardrail-evidence.md"
  );
  const openRouterGuardrailArtifacts = [
    resolve(
      repoRoot,
      "docs/compliance/pci/evidence/openrouter-prompt-injection-guardrail-2026-07-16.png"
    ),
    resolve(
      repoRoot,
      "docs/compliance/pci/evidence/openrouter-sensitive-info-detection-2026-07-16.png"
    )
  ];
  const issues: EvidenceIssue[] = [];

  for (const [path, label] of [
    [pciDirectory, "PCI evidence directory"],
    [publicBriefPath, "public security brief"],
    [workflowPath, "security workflow"],
    [pullRequestTemplatePath, "pull-request change-record template"],
    [workspacePath, "pnpm workspace settings"],
    [rootPackagePath, "root package manifest"],
    [productionEvidenceSqlPath, "production control verification SQL"],
    [threatModelPath, "application and PCI-impact threat model"],
    [verificationRecordPath, "repository verification record"],
    [sessionLedgerPath, "security-readiness session ledger"],
    [vulnerabilityBaselinePath, "safe CodeQL finding baseline"],
    [vulnerabilityRegisterPath, "vulnerability register"],
    [vulnerabilitySourceRegisterPath, "vulnerability source-coverage register"],
    [openRouterGuardrailRecordPath, "OpenRouter guardrail evidence record"],
    ...openRouterGuardrailArtifacts.map((path) => [path, "OpenRouter guardrail screenshot"] as const)
  ] as const) {
    if (!existsSync(path)) issues.push({ source: relative(repoRoot, path), message: `${label} is missing` });
  }
  if (issues.length > 0) {
    return {
      checkedMarkdownFiles: 0,
      checkedPublicGrades: 0,
      checkedReadOnlySqlArtifacts: 0,
      checkedHashBoundArtifacts: 0,
      checkedThreats: 0,
      checkedVulnerabilityFindings: 0,
      checkedVulnerabilitySources: 0,
      issues
    };
  }
  if (!statSync(pciDirectory).isDirectory()) {
    return {
      checkedMarkdownFiles: 0,
      checkedPublicGrades: 0,
      checkedReadOnlySqlArtifacts: 0,
      checkedHashBoundArtifacts: 0,
      checkedThreats: 0,
      checkedVulnerabilityFindings: 0,
      checkedVulnerabilitySources: 0,
      issues: [{ source: relative(repoRoot, pciDirectory), message: "PCI evidence path is not a directory" }]
    };
  }

  const markdown = verifyMarkdownLinks(repoRoot, pciDirectory);
  issues.push(...markdown.issues);

  const sessionLedger = readFileSync(sessionLedgerPath, "utf8");
  issues.push(
    ...verifySessionVerificationCounts(sessionLedger).map((message) => ({
      source: relative(repoRoot, sessionLedgerPath),
      message
    }))
  );

  const workflow = readFileSync(workflowPath, "utf8");
  issues.push(
    ...verifySecurityWorkflow(workflow).map((message) => ({
      source: relative(repoRoot, workflowPath),
      message
    }))
  );

  const pullRequestTemplate = readFileSync(pullRequestTemplatePath, "utf8");
  issues.push(
    ...verifyChangeRecordTemplate(pullRequestTemplate).map((message) => ({
      source: relative(repoRoot, pullRequestTemplatePath),
      message
    }))
  );

  const productionEvidenceSql = readFileSync(productionEvidenceSqlPath, "utf8");
  issues.push(
    ...verifyReadOnlyEvidenceSql(productionEvidenceSql).map((message) => ({
      source: relative(repoRoot, productionEvidenceSqlPath),
      message
    }))
  );

  const threatModelSource = readFileSync(threatModelPath, "utf8");
  const threatModel = verifyThreatModel(threatModelSource);
  issues.push(
    ...threatModel.issues.map((message) => ({
      source: relative(repoRoot, threatModelPath),
      message
    }))
  );

  const verificationRecord = readFileSync(verificationRecordPath, "utf8");
  for (const [source, name] of [
    [productionEvidenceSql, "production-control-verification.sql"],
    [threatModelSource, "threat-model.md"]
  ] as const) {
    issues.push(
      ...verifyRecordedSourceHash(source, verificationRecord, name).map(
        (message) => ({ source: relative(repoRoot, verificationRecordPath), message })
      )
    );
  }

  const openRouterGuardrailRecord = readFileSync(openRouterGuardrailRecordPath, "utf8");
  for (const artifactPath of openRouterGuardrailArtifacts) {
    const artifactName = artifactPath.split(/[\\/]/).at(-1) ?? artifactPath;
    issues.push(
      ...verifyRecordedArtifactHash(
        readFileSync(artifactPath),
        openRouterGuardrailRecord,
        artifactName
      ).map((message) => ({
        source: relative(repoRoot, openRouterGuardrailRecordPath),
        message
      }))
    );
  }

  const workspaceSettings = readFileSync(workspacePath, "utf8");
  const rootPackageJson = readFileSync(rootPackagePath, "utf8");
  issues.push(
    ...verifySupplyChainSettings(workspaceSettings, rootPackageJson).map(
      (message) => ({ source: relative(repoRoot, workspacePath), message })
    )
  );

  let vulnerabilityBaseline: unknown;
  try {
    vulnerabilityBaseline = JSON.parse(readFileSync(vulnerabilityBaselinePath, "utf8"));
  } catch {
    vulnerabilityBaseline = null;
    issues.push({
      source: relative(repoRoot, vulnerabilityBaselinePath),
      message: "safe CodeQL finding baseline is not valid JSON"
    });
  }
  const vulnerabilityRegister = readFileSync(vulnerabilityRegisterPath, "utf8");
  const vulnerabilityVerification = verifyVulnerabilityBaseline(
    vulnerabilityBaseline,
    vulnerabilityRegister
  );
  let vulnerabilitySourceRegister: unknown;
  try {
    vulnerabilitySourceRegister = JSON.parse(readFileSync(vulnerabilitySourceRegisterPath, "utf8"));
  } catch {
    vulnerabilitySourceRegister = null;
    issues.push({
      source: relative(repoRoot, vulnerabilitySourceRegisterPath),
      message: "vulnerability source-coverage register is not valid JSON"
    });
  }
  const vulnerabilitySources = verifyVulnerabilitySources(vulnerabilitySourceRegister);
  issues.push(
    ...vulnerabilitySources.issues.map((message) => ({
      source: relative(repoRoot, vulnerabilitySourceRegisterPath),
      message
    })),
    ...vulnerabilitySourceLocalEvidencePaths(vulnerabilitySourceRegister)
      .filter((path) => !existsSync(resolve(repoRoot, path)))
      .map((path) => ({
        source: relative(repoRoot, vulnerabilitySourceRegisterPath),
        message: `vulnerability source evidence path does not exist: ${path}`
      }))
  );
  issues.push(
    ...vulnerabilityVerification.issues.map((message) => ({
      source: relative(repoRoot, vulnerabilityBaselinePath),
      message
    }))
  );

  const publicBrief = readFileSync(publicBriefPath, "utf8");
  const grades = verifyPublicEvidenceGrades(publicBrief);
  issues.push(
    ...grades.issues.map((message) => ({
      source: relative(repoRoot, publicBriefPath),
      message
    })),
    ...verifyPublicEvidencePaths(repoRoot, publicBrief)
  );

  return {
    checkedMarkdownFiles: markdown.checked,
    checkedPublicGrades: grades.checked,
    checkedReadOnlySqlArtifacts: 1,
    checkedHashBoundArtifacts: openRouterGuardrailArtifacts.length,
    checkedThreats: threatModel.checked,
    checkedVulnerabilityFindings: vulnerabilityVerification.checked,
    checkedVulnerabilitySources: vulnerabilitySources.checked,
    issues
  };
}

function main(): void {
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(thisFile), "../..");
  const result = verifyPciEvidence(repoRoot);
  if (result.issues.length > 0) {
    console.error("PCI evidence verification failed:");
    for (const issue of result.issues) {
      console.error(`- ${issue.source}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `PCI evidence verification passed: ${result.checkedMarkdownFiles} Markdown files, ${result.checkedPublicGrades} public evidence grades, ${result.checkedReadOnlySqlArtifacts} read-only SQL artifact, ${result.checkedHashBoundArtifacts} hash-bound vendor screenshots, ${result.checkedThreats} threat rows, ${result.checkedVulnerabilityFindings} vulnerability fingerprints, and ${result.checkedVulnerabilitySources} required vulnerability source categories checked.`
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
