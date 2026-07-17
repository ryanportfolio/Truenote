import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  verifyMarkdownLinks,
  verifyPublicEvidenceGrades,
  verifyReadOnlyEvidenceSql,
  verifyRecordedArtifactHash,
  verifyRecordedSourceHash,
  verifySessionVerificationCounts,
  verifySecurityWorkflow,
  verifySupplyChainSettings,
  verifyThreatModel
} from "./verify-pci-evidence.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRepo(): string {
  const directory = mkdtempSync(resolve(tmpdir(), "truenote-pci-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("verifyMarkdownLinks", () => {
  it("accepts existing local targets and reports missing targets", () => {
    const repo = temporaryRepo();
    const docs = resolve(repo, "docs/compliance/pci");
    mkdirSync(docs, { recursive: true });
    writeFileSync(resolve(docs, "target.md"), "# Target\n");
    writeFileSync(
      resolve(docs, "index.md"),
      "[works](./target.md) [web](https://example.com) [missing](./absent.md)\n"
    );

    const result = verifyMarkdownLinks(repo, docs);

    assert.equal(result.checked, 2);
    assert.deepEqual(result.issues, [
      {
        source: join("docs", "compliance", "pci", "index.md"),
        message: "Local Markdown target does not exist: ./absent.md"
      }
    ]);
  });
});

describe("verifySecurityWorkflow", () => {
  it("requires PR coverage, CodeQL upload/retention, and the evidence gate", () => {
    const valid = `on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
jobs:
  verify:
    steps:
      - run: pnpm run verify:pci-evidence
      - name: Change record
        if: github.event_name == 'pull_request'
        run: corepack pnpm --filter @workspace/scripts run verify:change-record -- --event "$GITHUB_EVENT_PATH" --allow-pending
      - run: corepack pnpm --filter @workspace/scripts run verify:vulnerabilities
      - name: Managed release
        if: github.event_name == 'workflow_dispatch' && inputs.managed_release_gate
        run: corepack pnpm --filter @workspace/scripts run verify:vulnerabilities:release
      - name: Branch enforcement
        if: github.event_name == 'workflow_dispatch' && inputs.branch_enforcement_gate
        run: corepack pnpm --filter @workspace/scripts run verify:branch-enforcement -- docs/compliance/pci/branch-enforcement-evidence-current.json
  codeql:
    permissions:
      security-events: write
    steps:
      - uses: github/codeql-action/analyze@v4
        with:
          upload: always
      - name: Retain CodeQL SARIF evidence
        if: always()
`;
    assert.deepEqual(verifySecurityWorkflow(valid), []);

    const issues = verifySecurityWorkflow("on:\n  push:\n");
    assert.ok(issues.includes("pull-request trigger is missing"));
    assert.ok(issues.includes("verify job is missing"));
    assert.ok(issues.includes("CodeQL job is missing"));
  });

  it("rejects commented, misplaced, disabled, and PR-excluded evidence steps", () => {
    const bypassed = `on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths-ignore: ["docs/**"]
jobs:
  verify:
    if: false
    steps:
      # - run: pnpm run verify:pci-evidence
      - name: Change record
        if: github.event_name != 'pull_request'
        run: corepack pnpm --filter @workspace/scripts run verify:change-record -- --event "$GITHUB_EVENT_PATH" --allow-pending
  codeql:
    permissions:
      security-events: write
    steps:
      - run: pnpm run verify:pci-evidence
      - run: corepack pnpm --filter @workspace/scripts run verify:vulnerabilities
      - uses: github/codeql-action/analyze@v4
        with:
          upload: never
      - name: Retain CodeQL SARIF evidence
        if: false
`;
    const issues = verifySecurityWorkflow(bypassed);
    assert.ok(issues.includes("security workflow excludes pull-request paths"));
    assert.ok(issues.includes("pull-request trigger does not rerun when the change record is edited"));
    assert.ok(issues.includes("verify job must not have a job-level condition"));
    assert.ok(issues.includes("PCI evidence verifier is not an unconditional verify-job step"));
    assert.ok(issues.includes("vulnerability baseline verifier is not an unconditional verify-job step"));
    assert.ok(issues.includes("change-record verifier is not scoped exactly to pull-request events"));
    assert.ok(issues.includes("managed-release vulnerability gate is not a verify-job step"));
    assert.ok(issues.includes("branch-enforcement evidence gate is not a verify-job step"));
    assert.ok(issues.includes("CodeQL analyze step is not configured to upload always"));
    assert.ok(issues.includes("SARIF retention step is not unconditional"));
  });
});

describe("verifyPublicEvidenceGrades", () => {
  it("requires exact evidence vocabulary and a scope in the same cell", () => {
    const valid = `<td><span class="tag verified">Verified</span><span class="grade-scope">Repository tests</span></td>`;
    assert.deepEqual(verifyPublicEvidenceGrades(valid), {
      checked: 1,
      issues: []
    });

    const invalid = `<td><span class="tag unknown">Mostly verified</span></td>`;
    assert.deepEqual(verifyPublicEvidenceGrades(invalid), {
      checked: 1,
      issues: [
        "unsupported evidence grade: Mostly verified",
        "evidence grade lacks an adjacent scope label: Mostly verified"
      ]
    });

    const consistentLedger = `<section id="verification">
      <p class="number">62</p><p class="label">Frontend tests current to integrated worktree</p>
      <p class="number">258</p><p class="label">API tests current to integrated worktree</p>
      <p class="number">76</p><p class="label">Scripts tests current to integrated worktree</p>
      <p class="number">396</p><p class="label">Current tests passed across all three suites</p>
      <tr><td>Frontend tests</td><td><span class="status done">62/62 pass</span></td></tr>
      <tr><td>API tests</td><td><span class="status done">258/258 pass</span></td></tr>
      <tr><td>Scripts tests</td><td><span class="status done">76/76 pass</span></td></tr>
    </section>`;
    assert.deepEqual(verifySessionVerificationCounts(consistentLedger), []);
    assert.deepEqual(
      verifySessionVerificationCounts(
        consistentLedger
          .replace(">258</p><p class=\"label\">API", ">255</p><p class=\"label\">API")
          .replace(">396</p><p class=\"label\">Current", ">394</p><p class=\"label\">Current")
      ),
      [
        "API current-test card 255 does not match detail row 258",
        "combined current-test card 394 does not equal suite sum 396"
      ]
    );
  });
});

describe("verifySupplyChainSettings", () => {
  it("requires workspace-level overrides and a narrow build allowlist", () => {
    const valid = `allowBuilds:\n  esbuild: true\noverrides:\n  "form-data@2.5.5": "2.5.6"\n  "form-data@4.0.5": "4.0.6"\n`;
    assert.deepEqual(verifySupplyChainSettings(valid, "{}"), []);

    const wrongSections = `allowBuilds:\n  esbuild: true\n  unreviewed-installer: true\ncatalog:\n  "form-data@2.5.5": "2.5.6"\n  "form-data@4.0.5": "4.0.6"\n`;
    assert.deepEqual(verifySupplyChainSettings(wrongSections, "{}"), [
      "esbuild is not the explicitly allowed dependency build",
      "required dependency override is missing: form-data@2.5.5 -> 2.5.6",
      "required dependency override is missing: form-data@4.0.5 -> 4.0.6"
    ]);

    assert.deepEqual(verifySupplyChainSettings("", '{"pnpm":{}}'), [
      "esbuild is not the explicitly allowed dependency build",
      "required dependency override is missing: form-data@2.5.5 -> 2.5.6",
      "required dependency override is missing: form-data@4.0.5 -> 4.0.6",
      "pnpm project settings must live in pnpm-workspace.yaml"
    ]);
  });
});

describe("verifyReadOnlyEvidenceSql", () => {
  it("requires bounded read-only catalog evidence and rejects data mutation", () => {
    const valid = `BEGIN TRANSACTION READ ONLY;\nSET LOCAL statement_timeout = '30s';\nSET LOCAL lock_timeout = '5s';\nSELECT true AS passed, 'hash' AS definition_sha256 FROM pg_catalog.pg_class;\nCOMMIT;\n`;
    assert.deepEqual(verifyReadOnlyEvidenceSql(valid), []);

    const invalid = `BEGIN;\nDELETE FROM users;\nCOMMIT;\n`;
    const issues = verifyReadOnlyEvidenceSql(invalid);
    assert.ok(issues.includes("evidence SQL does not begin a read-only transaction"));
    assert.ok(issues.includes("evidence SQL contains a mutating statement: DELETE"));
    assert.ok(issues.includes("evidence SQL directly selects an application/security data table"));

    const source = "SELECT catalog evidence;\n";
    const hash = createHash("sha256").update(source).digest("hex").toUpperCase();
    assert.deepEqual(
      verifyRecordedSourceHash(source, `| \`evidence.sql\` SHA-256 \`${hash}\` |`, "evidence.sql"),
      []
    );
    assert.ok(
      verifyRecordedSourceHash(source, "| `evidence.sql` SHA-256 `STALE` |", "evidence.sql")[0]?.includes(
        "is stale"
      )
    );

    const binary = new Uint8Array([0, 1, 2, 255]);
    const binaryHash = createHash("sha256").update(binary).digest("hex").toUpperCase();
    assert.deepEqual(
      verifyRecordedArtifactHash(
        binary,
        `| \`artifact.png\` | \`${binaryHash}\` |`,
        "artifact.png"
      ),
      []
    );
    assert.ok(
      verifyRecordedArtifactHash(binary, "| `artifact.png` | `STALE` |", "artifact.png")[0]?.includes(
        "is stale"
      )
    );
  });
});

describe("verifyThreatModel", () => {
  it("requires contiguous threats, exact grades, evidence paths, boundaries, and blockers", () => {
    const rows = Array.from({ length: 20 }, (_, index) => {
      const id = `TN-TM-${String(index + 1).padStart(3, "0")}`;
      return `| ${id} | Spoofing / Tampering / Repudiation / Information disclosure / Denial of service / Elevation of privilege / prompt injection / data poisoning | Threat | TB-01 | \`src/control.ts\` | Verified | Owner |`;
    }).join("\n");
    const valid = `TB-02 TB-03 TB-04 TB-05 TB-06 TB-07 TB-08 TB-09\n${rows}\n### Release/CDE blockers\nTN-TM-011 TN-TM-022 TN-TM-023\n`;
    assert.deepEqual(verifyThreatModel(valid), { checked: 20, issues: [] });

    const invalid = valid
      .replace("TN-TM-002", "TN-TM-001")
      .replace("| Verified |", "| Mostly verified |")
      .replace("`src/control.ts`", "no evidence");
    const issues = verifyThreatModel(invalid).issues;
    assert.ok(issues.some((issue) => issue.includes("unsupported evidence grade")));
    assert.ok(issues.some((issue) => issue.includes("lacks a repository evidence path")));
    assert.ok(issues.includes("threat model contains duplicate threat IDs"));
  });
});
