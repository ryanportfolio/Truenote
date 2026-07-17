import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildSafeCodeqlBaseline } from "./codeql-sarif-baseline.js";
import { atomicWriteIfUnchanged } from "./import-codeql-sarif.js";
import { verifyVulnerabilityBaseline } from "./vulnerability-baseline.js";

const mapping = new Map([
  ["js/example-high", "TN-VULN-2026-001"],
  ["js/example-medium", "TN-VULN-2026-002"]
]);

const source = {
  repository: "ryanportfolio/Truenote",
  runId: 123,
  commit: "a".repeat(40),
  commitBinding: "external-run-receipt" as const,
  runReceiptUrl: "https://github.com/ryanportfolio/Truenote/actions/runs/123",
  artifactId: 456,
  artifactName: "truenote-codeql-sarif/javascript.sarif",
  artifactSha256: "B".repeat(64),
  artifactExpiresAt: "2026-08-15T00:00:00Z",
  verifiedAvailableAt: "2026-07-16T00:00:00Z"
};

function sarif(
  findings: Array<{
    ruleId: string;
    uri: string;
    lineHash: string;
    columnFingerprint: string;
    startLine?: number;
    message?: string;
  }>
): unknown {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "CodeQL",
            rules: [
              { id: "js/example-high", properties: { "security-severity": "7.5" } },
              { id: "js/example-medium", properties: { "security-severity": "6.0" } }
            ]
          }
        },
        results: findings.map((finding) => ({
          ruleId: finding.ruleId,
          message: { text: finding.message ?? "scanner detail must not be copied" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: finding.uri },
                region: { startLine: finding.startLine ?? 10, startColumn: 4 }
              }
            }
          ],
          partialFingerprints: {
            primaryLocationLineHash: finding.lineHash,
            primaryLocationStartColumnFingerprint: finding.columnFingerprint
          }
        }))
      }
    ]
  };
}

const originalSarif = sarif([
  {
    ruleId: "js/example-high",
    uri: "restricted/customer/Acme.ts",
    lineHash: "line-hash-a",
    columnFingerprint: "4",
    message: "API_KEY=do-not-publish"
  },
  {
    ruleId: "js/example-medium",
    uri: "src/example.ts",
    lineHash: "line-hash-b",
    columnFingerprint: "8"
  }
]);

describe("safe CodeQL SARIF importer", () => {
  it("atomically writes only when the reviewed baseline bytes are unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "truenote-codeql-write-"));
    const output = join(directory, "baseline.json");
    try {
      writeFileSync(output, "reviewed-v1", "utf8");
      const original = readFileSync(output);
      writeFileSync(output, "reviewer-newer", "utf8");
      assert.throws(
        () => atomicWriteIfUnchanged(output, original, "importer-output"),
        /changed during import/
      );
      assert.equal(readFileSync(output, "utf8"), "reviewer-newer");
      const current = readFileSync(output);
      atomicWriteIfUnchanged(output, current, "atomic-final");
      assert.equal(readFileSync(output, "utf8"), "atomic-final");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("emits only safe finding fields and deterministic severity counts", () => {
    const result = buildSafeCodeqlBaseline({ sarif: originalSarif, source, ruleMappings: mapping });
    assert.equal(result.baseline.findings.length, 2);
    assert.deepEqual(result.baseline.source.severityCounts, {
      critical: 0,
      high: 1,
      medium: 1,
      low: 0,
      unknown: 0
    });
    const serialized = JSON.stringify(result.baseline);
    assert.equal(serialized.includes("restricted/customer"), false);
    assert.equal(serialized.includes("do-not-publish"), false);
    assert.equal(serialized.includes("message"), false);
    assert.deepEqual(result.summary.addedFindingIds, ["TN-CQL-2026-001", "TN-CQL-2026-002"]);
  });

  it("preserves stable IDs and management decisions when source lines move", () => {
    const initial = buildSafeCodeqlBaseline({ sarif: originalSarif, source, ruleMappings: mapping });
    const managed = structuredClone(initial.baseline);
    managed.findings[0]!.owner = "Product Security";
    managed.findings[0]!.due = "2026-08-01";
    managed.findings[0]!.disposition = "remediate";
    const shifted = sarif([
      {
        ruleId: "js/example-high",
        uri: "restricted/customer/Acme.ts",
        lineHash: "line-hash-a",
        columnFingerprint: "4",
        startLine: 900
      },
      {
        ruleId: "js/example-medium",
        uri: "src/example.ts",
        lineHash: "line-hash-b",
        columnFingerprint: "8",
        startLine: 700
      },
      {
        ruleId: "js/example-high",
        uri: "src/new-year.ts",
        lineHash: "line-hash-new-year",
        columnFingerprint: "3"
      }
    ]);
    const rescanned = buildSafeCodeqlBaseline({
      sarif: shifted,
      source: {
        ...source,
        runId: 124,
        runReceiptUrl: "https://github.com/ryanportfolio/Truenote/actions/runs/124",
        artifactId: 457,
        verifiedAvailableAt: "2027-01-02T00:00:00Z",
        artifactExpiresAt: "2027-02-02T00:00:00Z"
      },
      existing: managed
    });
    assert.deepEqual(rescanned.summary.preservedFindingIds, [
      "TN-CQL-2026-001",
      "TN-CQL-2026-002"
    ]);
    assert.equal(rescanned.baseline.findings[0]!.owner, "Product Security");
    assert.equal(rescanned.baseline.findings[0]!.due, "2026-08-01");
    assert.equal(rescanned.baseline.findings[0]!.disposition, "remediate");
    assert.deepEqual(rescanned.summary.addedFindingIds, ["TN-CQL-2027-001"]);
    const verification = verifyVulnerabilityBaseline(
      rescanned.baseline,
      "| TN-VULN-2026-001 | CodeQL `js/example-high` (2 results) |\n| TN-VULN-2026-002 | CodeQL `js/example-medium` (1 result) |\n"
    );
    assert.deepEqual(verification.issues, []);
  });

  it("refuses to treat a missing scanner result as automatically closed", () => {
    const initial = buildSafeCodeqlBaseline({ sarif: originalSarif, source, ruleMappings: mapping });
    const oneFinding = sarif([
      {
        ruleId: "js/example-high",
        uri: "restricted/customer/Acme.ts",
        lineHash: "line-hash-a",
        columnFingerprint: "4"
      }
    ]);
    assert.throws(
      () => buildSafeCodeqlBaseline({ sarif: oneFinding, source, existing: initial.baseline }),
      /reconcile\/retest them before using --allow-removed/
    );
    assert.throws(
      () =>
        buildSafeCodeqlBaseline({
          sarif: oneFinding,
          source,
          existing: initial.baseline,
          allowRemoved: true
        }),
      /refuses findings without an owned, approved terminal disposition/
    );
    const reconciled = structuredClone(initial.baseline);
    reconciled.findings[1]!.status = "closed";
    reconciled.findings[1]!.owner = "Product Security";
    reconciled.findings[1]!.disposition = "closed";
    reconciled.findings[1]!.approver = "Security Approver";
    reconciled.findings[1]!.retestArtifact = "restricted://codeql/retest-002";
    const acknowledged = buildSafeCodeqlBaseline({
      sarif: oneFinding,
      source,
      existing: reconciled,
      allowRemoved: true
    });
    assert.deepEqual(acknowledged.summary.removedFindingIds, ["TN-CQL-2026-002"]);
    assert.equal(acknowledged.baseline.findings[0]!.status, "open");
    assert.equal(acknowledged.baseline.historicalFindings[0]!.id, "TN-CQL-2026-002");
    assert.deepEqual(
      verifyVulnerabilityBaseline(
        acknowledged.baseline,
        [
          "## Open items",
          "| TN-VULN-2026-001 | CodeQL `js/example-high` (1 result) |",
          "",
          "## Closed items",
          "| Safe finding ID | Register group | Source | Asset/release | Severity | Disposition | Closed | Retest result | Approver | Restricted evidence |",
          "|---|---|---|---|---|---|---|---|---|---|",
          "| TN-CQL-2026-002 | TN-VULN-2026-002 | CodeQL | API | medium | closed | 2026-07-16 | restricted://codeql/retest-002 | Security Approver | restricted://case/002 |"
        ].join("\n")
      ).issues,
      []
    );
    assert.throws(
      () => buildSafeCodeqlBaseline({ sarif: originalSarif, source, existing: acknowledged.baseline }),
      /re-reports historical finding TN-CQL-2026-002/
    );
    const replacementSarif = sarif([
      {
        ruleId: "js/example-high",
        uri: "restricted/customer/Acme.ts",
        lineHash: "line-hash-a",
        columnFingerprint: "4"
      },
      {
        ruleId: "js/example-medium",
        uri: "src/replacement.ts",
        lineHash: "replacement",
        columnFingerprint: "9"
      }
    ]);
    const replacement = buildSafeCodeqlBaseline({
      sarif: replacementSarif,
      source,
      existing: acknowledged.baseline
    });
    assert.deepEqual(replacement.summary.addedFindingIds, ["TN-CQL-2026-003"]);
  });

  it("refuses active scanner findings marked closed and requires exact closed-register evidence", () => {
    const initial = buildSafeCodeqlBaseline({ sarif: originalSarif, source, ruleMappings: mapping });
    const incorrectlyClosed = structuredClone(initial.baseline);
    incorrectlyClosed.findings[0]!.status = "closed";
    incorrectlyClosed.findings[0]!.disposition = "closed";
    incorrectlyClosed.findings[0]!.owner = "Product Security";
    incorrectlyClosed.findings[0]!.approver = "Security Approver";
    incorrectlyClosed.findings[0]!.retestArtifact = "restricted://codeql/retest-001";
    assert.throws(
      () => buildSafeCodeqlBaseline({ sarif: originalSarif, source, existing: incorrectlyClosed }),
      /still reports closed finding TN-CQL-2026-001/
    );
    const structural = verifyVulnerabilityBaseline(
      incorrectlyClosed,
      "| TN-VULN-2026-001 | CodeQL `js/example-high` (1 result) |\n| TN-VULN-2026-002 | CodeQL `js/example-medium` (1 result) |"
    );
    assert.ok(structural.issues.includes("TN-CQL-2026-001 remains active in SARIF and cannot be closed"));

    const removed = structuredClone(initial.baseline);
    removed.findings[1]!.status = "closed";
    removed.findings[1]!.disposition = "closed";
    removed.findings[1]!.owner = "Product Security";
    removed.findings[1]!.approver = "Security Approver";
    removed.findings[1]!.retestArtifact = "restricted://codeql/retest-002";
    const oneFinding = sarif([
      {
        ruleId: "js/example-high",
        uri: "restricted/customer/Acme.ts",
        lineHash: "line-hash-a",
        columnFingerprint: "4"
      }
    ]);
    const historical = buildSafeCodeqlBaseline({
      sarif: oneFinding,
      source,
      existing: removed,
      allowRemoved: true
    }).baseline;
    const wrongSection = [
      "## Open items",
      "| TN-VULN-2026-001 | CodeQL `js/example-high` (1 result) |",
      "| TN-CQL-2026-002 | TN-VULN-2026-002 | CodeQL | API | medium | closed | 2026-07-16 | restricted://codeql/retest-002 | Security Approver | restricted://case/002 |",
      "",
      "## Closed items",
      "| _None recorded_ | — | — | — | — | — | — | — | — | — |"
    ].join("\n");
    assert.ok(
      verifyVulnerabilityBaseline(historical, wrongSection).issues.includes(
        "TN-CQL-2026-002 is missing from the Closed items section"
      )
    );
  });

  it("rejects stale or replay-mutated scan evidence", () => {
    const initial = buildSafeCodeqlBaseline({ sarif: originalSarif, source, ruleMappings: mapping });
    assert.throws(
      () => buildSafeCodeqlBaseline({
        sarif: originalSarif,
        source: { ...source, runId: 122, runReceiptUrl: "https://github.com/ryanportfolio/Truenote/actions/runs/122", artifactId: 457 },
        existing: initial.baseline
      }),
      /run ID must be newer/
    );
    assert.throws(
      () => buildSafeCodeqlBaseline({
        sarif: originalSarif,
        source: { ...source, runId: 124, runReceiptUrl: "https://github.com/ryanportfolio/Truenote/actions/runs/124", artifactId: 457, verifiedAvailableAt: "2026-07-15T00:00:00Z" },
        existing: initial.baseline
      }),
      /availability time must be later/
    );
  });

  it("requires matching provenance on every SARIF result run", () => {
    const mixed = structuredClone(originalSarif) as {
      runs: Array<Record<string, unknown>>;
    };
    const secondRun = structuredClone(mixed.runs[0]!);
    mixed.runs[0]!.versionControlProvenance = [{ revisionId: source.commit }];
    mixed.runs.push(secondRun);
    assert.throws(
      () => buildSafeCodeqlBaseline({
        sarif: mixed,
        source: { ...source, commitBinding: "sarif-provenance", runReceiptUrl: null },
        ruleMappings: mapping
      }),
      /every SARIF run containing results must include matching commit provenance/
    );
  });

  it("rejects duplicate locations and unmapped new rules", () => {
    const duplicate = sarif([
      {
        ruleId: "js/example-high",
        uri: "src/same.ts",
        lineHash: "same",
        columnFingerprint: "1"
      },
      {
        ruleId: "js/example-high",
        uri: "src/same.ts",
        lineHash: "same",
        columnFingerprint: "1"
      }
    ]);
    assert.throws(
      () => buildSafeCodeqlBaseline({ sarif: duplicate, source, ruleMappings: mapping }),
      /duplicate safe fingerprint/
    );
    const unmapped = sarif([
      {
        ruleId: "js/new-unmapped-rule",
        uri: "src/new.ts",
        lineHash: "new",
        columnFingerprint: "2"
      }
    ]);
    assert.throws(
      () => buildSafeCodeqlBaseline({ sarif: unmapped, source, ruleMappings: mapping }),
      /has no vulnerability-register mapping/
    );
    const suppressed = structuredClone(originalSarif) as {
      runs: Array<{ results: Array<Record<string, unknown>> }>;
    };
    suppressed.runs[0]!.results[0]!.suppressions = [{ kind: "external" }];
    assert.throws(
      () => buildSafeCodeqlBaseline({ sarif: suppressed, source, ruleMappings: mapping }),
      /contains a suppression requiring explicit review/
    );
    const absent = structuredClone(originalSarif) as {
      runs: Array<{ results: Array<Record<string, unknown>> }>;
    };
    absent.runs[0]!.results[0]!.baselineState = "absent";
    assert.throws(
      () => buildSafeCodeqlBaseline({ sarif: absent, source, ruleMappings: mapping }),
      /unsupported SARIF baselineState absent/
    );
    const wrongTool = structuredClone(originalSarif) as {
      runs: Array<{ tool: { driver: { name: string } } }>;
    };
    wrongTool.runs[0]!.tool.driver.name = "Not CodeQL";
    assert.throws(
      () => buildSafeCodeqlBaseline({ sarif: wrongTool, source, ruleMappings: mapping }),
      /tool driver must be CodeQL/
    );
    const mismatchedCommit = structuredClone(originalSarif) as {
      runs: Array<{ versionControlProvenance: Array<{ revisionId: string }> }>;
    };
    mismatchedCommit.runs[0]!.versionControlProvenance = [{ revisionId: "b".repeat(40) }];
    assert.throws(
      () => buildSafeCodeqlBaseline({ sarif: mismatchedCommit, source, ruleMappings: mapping }),
      /provenance does not match the claimed commit/
    );
  });
});
