import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  REQUIRED_BRANCH_CHECKS,
  REQUIRED_BRANCH_ENFORCEMENT_TESTS,
  verifyBranchEnforcementEvidence
} from "./branch-enforcement-evidence.js";

function evidence() {
  const codeownersText = "# All paths require the named security owner\n* @ryanportfolio\n";
  return {
    schemaVersion: 2,
    recordId: "TN-BRANCH-2026-001",
    repository: "ryanportfolio/kbase",
    defaultBranch: "main",
    capturedAt: "2026-07-16T18:00:00.000Z",
    capturedBy: "Platform Evidence Operator",
    captureMethod: "github_api",
    apiEndpoints: [
      "/repos/ryanportfolio/kbase/rulesets",
      "/repos/ryanportfolio/kbase/branches/main/protection"
    ],
    apiResponses: [
      {
        endpoint: "/repos/ryanportfolio/kbase/rulesets",
        method: "GET",
        httpStatus: 200,
        capturedAt: "2026-07-16T18:00:01.000Z",
        requestId: "REQ-RULESETS-2026-001",
        pageCount: 1,
        paginationComplete: true,
        bodySha256: createHash("sha256").update("synthetic ruleset response").digest("hex")
      },
      {
        endpoint: "/repos/ryanportfolio/kbase/branches/main/protection",
        method: "GET",
        httpStatus: 200,
        capturedAt: "2026-07-16T18:00:02.000Z",
        requestId: "REQ-PROTECTION-2026-001",
        pageCount: 1,
        paginationComplete: true,
        bodySha256: createHash("sha256").update("synthetic protection response").digest("hex")
      }
    ],
    evidence: {
      restrictedArtifactId: "SEC-EVIDENCE-BRANCH-2026-001",
      artifactSha256: createHash("sha256").update("synthetic restricted API response bundle").digest("hex"),
      safeReference: "PCI-EVIDENCE-INDEX-BRANCH-2026-001",
      rulesetReference: "TN-RULESET-2026-001"
    },
    codeowners: {
      path: ".github/CODEOWNERS",
      coverage: "all_repository_paths",
      ownerTokens: ["@ryanportfolio"],
      sourceSha256: createHash("sha256").update(codeownersText).digest("hex")
    },
    rules: {
      enforcement: "active",
      targetBranch: "refs/heads/main",
      requirePullRequest: true,
      requiredApprovals: 1,
      dismissStaleReviews: true,
      requireCodeOwnerReview: true,
      requireLastPushApproval: true,
      requireConversationResolution: true,
      requireStatusChecks: true,
      requireBranchesUpToDate: true,
      enforceAdmins: true,
      restrictDirectPushes: true,
      blockForcePushes: true,
      blockDeletions: true,
      bypassActors: [] as string[],
      requiredChecks: REQUIRED_BRANCH_CHECKS.map((check) => ({
        ...check,
        context: check.jobName,
        integrationId: 15368,
        required: true
      }))
    },
    enforcementTests: REQUIRED_BRANCH_ENFORCEMENT_TESTS.map((test, index) => ({
      id: test.id,
      expectedResult: test.expectedResult,
      actualResult: test.expectedResult,
      executedAt: `2026-07-16T18:${String(10 + index).padStart(2, "0")}:00.000Z`,
      executedBy: "Branch Test Operator Team",
      reviewedAt: `2026-07-16T18:${String(20 + index).padStart(2, "0")}:00.000Z`,
      reviewedBy: "Branch Test Reviewer Team",
      targetReference: `TN-BRANCH-TARGET-2026-${String(index + 1).padStart(3, "0")}`,
      restrictedArtifactId: `TN-BRANCH-RECEIPT-2026-${String(index + 1).padStart(3, "0")}`,
      artifactSha256: createHash("sha256").update(`synthetic branch test receipt ${index + 1}`).digest("hex"),
      configurationArtifactSha256: createHash("sha256").update("synthetic restricted API response bundle").digest("hex"),
      rulesetReference: "TN-RULESET-2026-001",
      exercisedCheckIds: test.id === "denied_missing_required_check"
        ? REQUIRED_BRANCH_CHECKS.map((check) => check.id)
        : []
    })),
    decision: "accepted",
    gaps: [] as string[],
    signoffs: [
      {
        role: "engineering_owner",
        identity: "Engineering Owner Team",
        decision: "accepted",
        reviewedAt: "2026-07-16T19:00:00.000Z",
        evidenceReference: "SEC-APPROVAL-BRANCH-2026-001"
      },
      {
        role: "security_reviewer",
        identity: "Security Reviewer Team",
        decision: "accepted",
        reviewedAt: "2026-07-16T20:00:00.000Z",
        evidenceReference: "SEC-APPROVAL-BRANCH-2026-002"
      }
    ]
  };
}

const options = { now: new Date("2026-07-17T00:00:00.000Z") };
const codeownersText = "# All paths require the named security owner\n* @ryanportfolio\n";
const optionsWithCodeowners = { ...options, codeownersText };

describe("branch enforcement evidence", () => {
  it("structurally accepts a current complete declaration with separated signoffs", () => {
    assert.deepEqual(verifyBranchEnforcementEvidence(evidence(), optionsWithCodeowners), {
      issues: [],
      structurallyAccepted: true
    });
  });

  it("rejects stale, future, placeholder, and self-approved evidence", () => {
    const stale = evidence();
    stale.recordId = "TN-BRANCH-2025-001";
    stale.capturedAt = "2026-05-01T18:00:00.000Z";
    stale.capturedBy = "Security Reviewer Team";
    stale.evidence.artifactSha256 = "0".repeat(64);
    stale.evidence.safeReference = "TBD";
    stale.apiEndpoints[0] = "https://attacker.example/repos/ryanportfolio/kbase/rulesets";
    stale.apiResponses[0]!.httpStatus = 403;
    stale.apiResponses[0]!.paginationComplete = false;
    stale.apiResponses[0]!.bodySha256 = "0".repeat(64);
    const staleResult = verifyBranchEnforcementEvidence(stale, optionsWithCodeowners);
    assert.ok(staleResult.issues.includes("branch enforcement recordId year must match capturedAt"));
    assert.ok(staleResult.issues.includes("branch enforcement evidence must be no older than 30 days"));
    assert.ok(staleResult.issues.includes("branch enforcement artifactSha256 must be a non-placeholder SHA-256"));
    assert.ok(staleResult.issues.includes("branch enforcement safeReference must not contain placeholder text"));
    assert.ok(staleResult.issues.includes("branch enforcement capturer cannot approve the evidence"));
    assert.ok(staleResult.issues.includes("branch enforcement apiEndpoints must use exact official GitHub API endpoints"));
    assert.ok(staleResult.issues.includes("branch enforcement API response 1 httpStatus must equal 200"));
    assert.ok(staleResult.issues.includes("branch enforcement API response 1 paginationComplete must equal true"));
    assert.ok(staleResult.issues.includes("branch enforcement API response 1 bodySha256 must be a non-placeholder SHA-256"));

    const future = evidence();
    future.capturedAt = "2026-07-18T18:00:00.000Z";
    future.signoffs[0]!.reviewedAt = "2026-07-18T19:00:00.000Z";
    const futureResult = verifyBranchEnforcementEvidence(future, optionsWithCodeowners);
    assert.ok(futureResult.issues.includes("branch enforcement capturedAt must not be in the future"));
    assert.ok(futureResult.issues.includes("branch enforcement signoff 1 reviewedAt must not be in the future"));

    const repositoryTemplate = JSON.parse(readFileSync(
      new URL("../../docs/compliance/pci/branch-enforcement-evidence-template.json", import.meta.url),
      "utf8"
    )) as unknown;
    const templateResult = verifyBranchEnforcementEvidence(repositoryTemplate, options);
    assert.equal(templateResult.structurallyAccepted, false);
    assert.ok(templateResult.issues.includes("branch enforcement decision must equal accepted"));
    assert.ok(templateResult.issues.some((issue) => issue.includes("placeholder text")));
  });

  it("rejects missing enforcement, bypass actors, and accepted gaps", () => {
    const invalid = evidence();
    invalid.rules.enforcement = "inactive";
    invalid.rules.requirePullRequest = false;
    invalid.rules.requireCodeOwnerReview = false;
    invalid.rules.enforceAdmins = false;
    invalid.rules.requiredApprovals = 0;
    invalid.rules.bypassActors = ["Repository administrator"];
    invalid.gaps = ["Status checks are not yet enforced"];
    const result = verifyBranchEnforcementEvidence(invalid, {
      ...options,
      codeownersText: "docs/** @ryanportfolio\n"
    });
    assert.ok(result.issues.includes("branch enforcement must be active"));
    assert.ok(result.issues.includes("branch enforcement requirePullRequest must equal true"));
    assert.ok(result.issues.includes("branch enforcement requireCodeOwnerReview must equal true"));
    assert.ok(result.issues.includes("branch enforcement enforceAdmins must equal true"));
    assert.ok(result.issues.includes("branch enforcement requiredApprovals must be an integer of at least 1"));
    assert.ok(result.issues.includes("branch enforcement bypassActors must be an empty array"));
    assert.ok(result.issues.includes("accepted branch enforcement evidence requires no gaps"));
    assert.ok(result.issues.includes("branch enforcement CODEOWNERS source hash does not match"));
    assert.ok(result.issues.includes("branch enforcement CODEOWNERS final active rule must cover all repository paths"));
    assert.equal(result.structurallyAccepted, false);
  });

  it("requires each exact workflow/job check once", () => {
    const invalid = evidence();
    const original = invalid.rules.requiredChecks;
    const mutableChecks = original as unknown as Array<{
      id: string;
      workflow: string;
      jobName: string;
      context: string;
      integrationId: number;
      required: boolean;
    }>;
    mutableChecks.splice(
      0,
      mutableChecks.length,
      { ...original[0]!, workflow: "Different workflow" },
      { ...original[0]! },
      { ...original[2]!, jobName: "Different job", integrationId: 99999 }
    );
    const result = verifyBranchEnforcementEvidence(invalid, optionsWithCodeowners);
    assert.ok(result.issues.includes("branch enforcement verify workflow does not match"));
    assert.ok(result.issues.includes("duplicate branch enforcement check id: verify"));
    assert.ok(result.issues.includes("branch enforcement secrets jobName does not match"));
    assert.ok(result.issues.includes("missing required branch check: supply-chain"));
    assert.ok(result.issues.includes("missing required branch check: codeql"));
    assert.ok(result.issues.includes("branch enforcement checks must use one GitHub Actions integrationId"));
    assert.equal(result.structurallyAccepted, false);
  });

  it("requires every behavioral denial and allowed-merge test exactly once", () => {
    const invalid = evidence();
    invalid.enforcementTests[0]!.actualResult = "allowed";
    invalid.enforcementTests[1]!.exercisedCheckIds = ["verify"];
    invalid.enforcementTests[2]!.id = "denied_unapproved_pr";
    invalid.enforcementTests.pop();
    const result = verifyBranchEnforcementEvidence(invalid, optionsWithCodeowners);
    assert.ok(result.issues.includes("branch enforcement denied_unapproved_pr actualResult must equal denied"));
    assert.ok(result.issues.includes("branch enforcement denied_missing_required_check must exercise every required check exactly once"));
    assert.ok(result.issues.includes("duplicate branch enforcement test id: denied_unapproved_pr"));
    assert.ok(result.issues.includes("missing required branch enforcement test: denied_stale_review"));
    assert.ok(result.issues.includes("missing required branch enforcement test: allowed_fully_approved_merge"));
    assert.equal(result.structurallyAccepted, false);
  });

  it("binds test receipts to the captured configuration and enforces chronology and separation", () => {
    const invalid = evidence();
    invalid.enforcementTests[0]!.configurationArtifactSha256 = createHash("sha256").update("different configuration").digest("hex");
    invalid.enforcementTests[1]!.rulesetReference = "TN-RULESET-2026-999";
    invalid.enforcementTests[2]!.executedAt = "2026-07-15T18:00:00.000Z";
    invalid.enforcementTests[3]!.reviewedAt = "2026-07-16T18:00:00.000Z";
    invalid.enforcementTests[4]!.reviewedBy = invalid.enforcementTests[4]!.executedBy;
    invalid.enforcementTests[5]!.targetReference = invalid.enforcementTests[4]!.targetReference;
    invalid.signoffs[0]!.reviewedAt = "2026-07-16T18:05:00.000Z";
    const result = verifyBranchEnforcementEvidence(invalid, optionsWithCodeowners);
    assert.ok(result.issues.includes("branch enforcement test 1 configurationArtifactSha256 must match the captured configuration artifact"));
    assert.ok(result.issues.includes("branch enforcement test 2 rulesetReference must match the captured ruleset reference"));
    assert.ok(result.issues.includes("branch enforcement test 3 executedAt must not precede capturedAt"));
    assert.ok(result.issues.includes("branch enforcement test 4 reviewedAt must not precede executedAt"));
    assert.ok(result.issues.includes("branch enforcement test 5 executor and reviewer must be distinct"));
    assert.ok(result.issues.includes(`duplicate branch enforcement test targetReference: ${invalid.enforcementTests[4]!.targetReference}`));
    assert.ok(result.issues.includes("branch enforcement signoff 1 reviewedAt must not precede enforcement-test review"));
    assert.equal(result.structurallyAccepted, false);
  });
});
