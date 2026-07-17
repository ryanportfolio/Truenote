import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  REQUIRED_PRODUCTION_EXERCISES,
  verifyProductionControlEvidence
} from "./production-control-evidence.js";

const scope = {
  schemaVersion: 1,
  recordId: "TN-PCI-SCOPE-2026-002",
  decisionStage: "final_scope_acceptance",
  decision: "accepted"
};
const scopeBytes = Buffer.from(JSON.stringify(scope));
const scopeHash = createHash("sha256").update(scopeBytes).digest("hex");
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function evidence() {
  return {
    schemaVersion: 1,
    recordId: "TN-PROD-2026-001",
    capturedAt: "2026-07-16T12:00:00.000Z",
    completedAt: "2026-07-16T18:00:00.000Z",
    environmentReference: "TN-ENV-2026-001",
    releaseReference: "TN-RELEASE-2026-001",
    releaseCommitSha: "a".repeat(40),
    changeEvidenceReference: "TN-CHANGE-2026-001",
    scopeDecision: {
      recordId: scope.recordId,
      recordSha256: scopeHash,
      decisionStage: "final_scope_acceptance"
    },
    operatorPrincipalId: "user:TN-PROD-OPERATOR",
    independentReviewerPrincipalId: "user:TN-PROD-REVIEWER",
    exercises: REQUIRED_PRODUCTION_EXERCISES.map(([id, runbookSection, workstreamId], index) => ({
      id,
      runbookSection,
      workstreamId,
      applicability: "required",
      applicabilityRationale: "Required for the approved TrueNote release evidence boundary.",
      applicabilityApprovalReference: null,
      status: "passed",
      authorizationReference: `TN-AUTH-2026-${String(index + 1).padStart(3, "0")}`,
      executedAt: "2026-07-16T14:00:00.000Z",
      executedByPrincipalId: "user:TN-PROD-OPERATOR",
      reviewedAt: "2026-07-16T17:00:00.000Z",
      reviewedByPrincipalId: "user:TN-PROD-REVIEWER",
      environmentReference: "TN-ENV-2026-001",
      releaseCommitSha: "a".repeat(40),
      scopeDecisionSha256: scopeHash,
      restrictedEvidenceReference: `TN-PROD-EVIDENCE-2026-${String(index + 1).padStart(3, "0")}`,
      evidenceSha256: hash(`synthetic production receipt ${index + 1}`),
      findingId: null
    })),
    findings: [] as Array<Record<string, unknown>>,
    decision: "accepted",
    decisionAt: "2026-07-16T19:00:00.000Z",
    decisionAuthorityPrincipalId: "group:TN-PCI-AUTHORITY",
    decisionEvidenceReference: "TN-APPROVAL-2026-001"
  };
}

const options = {
  now: new Date("2026-07-17T00:00:00.000Z"),
  finalScopeRecordBytes: scopeBytes,
  finalScopeStructurallyAccepted: true
};

describe("production control evidence", () => {
  it("accepts exact release/scope-bound results for every declared exercise", () => {
    assert.deepEqual(verifyProductionControlEvidence(evidence(), options), {
      issues: [],
      structurallyAccepted: true
    });
  });

  it("distinguishes approved not-applicable from required passed results", () => {
    const valid = evidence();
    const exercise = valid.exercises.find((item) => item.id === "throttle_multi_replica_consistency")!;
    exercise.applicability = "not_applicable";
    exercise.applicabilityRationale = "Approved architecture decision excludes this contextual control for the named release.";
    exercise.applicabilityApprovalReference = "TN-APPROVAL-2026-002" as never;
    exercise.status = "not_run";
    exercise.authorizationReference = null as never;
    exercise.executedAt = null as never;
    exercise.executedByPrincipalId = null as never;
    exercise.restrictedEvidenceReference = null as never;
    exercise.evidenceSha256 = null as never;
    assert.equal(verifyProductionControlEvidence(valid, options).structurallyAccepted, true);
  });

  it("rejects skipped required work, weak not-applicable claims, drift, and self-review", () => {
    const invalid = evidence();
    invalid.exercises[0]!.status = "not_run";
    invalid.exercises[1]!.applicability = "not_applicable";
    invalid.exercises[1]!.applicabilityRationale = "N/A";
    invalid.exercises[1]!.applicabilityApprovalReference = null;
    invalid.exercises[2]!.releaseCommitSha = "b".repeat(40);
    invalid.exercises[3]!.scopeDecisionSha256 = hash("different scope");
    invalid.exercises[4]!.reviewedByPrincipalId = invalid.exercises[4]!.executedByPrincipalId;
    const result = verifyProductionControlEvidence(invalid, options);
    assert.ok(result.issues.includes("required production control exercise 1 status must equal passed"));
    assert.ok(result.issues.includes("not-applicable production control exercise 2 needs a substantive repository-safe applicabilityRationale"));
    assert.ok(result.issues.includes("not-applicable production control exercise 2 requires an applicabilityApprovalReference"));
    assert.ok(result.issues.includes("production control exercise 3 releaseCommitSha must match the record"));
    assert.ok(result.issues.includes("production control exercise 4 scopeDecisionSha256 must match the final scope record"));
    assert.ok(result.issues.includes("production control exercise 5 executor and reviewer must be distinct"));
    assert.equal(result.structurallyAccepted, false);
  });

  it("requires exact final-scope bytes, a separately passing final scope, complete coverage, and no open finding", () => {
    const invalid = evidence();
    invalid.exercises.pop();
    invalid.findings.push({
      id: "TN-FINDING-2026-001",
      ownerPrincipalId: "user:TN-FINDING-OWNER",
      dueDate: "2026-08-01",
      status: "open",
      retestReference: null
    });
    const result = verifyProductionControlEvidence(invalid, {
      ...options,
      finalScopeRecordBytes: Buffer.from("{}"),
      finalScopeStructurallyAccepted: false
    });
    assert.ok(result.issues.includes("production control evidence final scope record hash does not match exact bytes"));
    assert.ok(result.issues.includes("production control evidence final scope record must separately pass the linked final-stage scope validator"));
    assert.ok(result.issues.includes("missing required production control exercise declaration: openrouter_output_sensitive_data_handling"));
    assert.ok(result.issues.includes("accepted production control evidence cannot contain open findings"));

    const repositoryTemplate = JSON.parse(readFileSync(
      new URL("../../docs/compliance/pci/production-control-verification-record-template.json", import.meta.url),
      "utf8"
    )) as unknown;
    assert.equal(verifyProductionControlEvidence(repositoryTemplate, { now: options.now }).structurallyAccepted, false);
  });
});
