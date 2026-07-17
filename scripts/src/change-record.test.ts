import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHANGE_RECORD_FIELDS,
  CHANGE_RECORD_HEADINGS,
  verifyChangeRecord,
  verifyChangeRecordTemplate
} from "./change-record.js";

function validRecord(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    "Change ID": "TN-CHG-2026-001",
    "Change type": "normal",
    Author: "@author",
    "Target release/commit": "pull request head SHA",
    "Target environment": "production after approval",
    "Significant change": "yes",
    "Significant-change rationale": "Changes security controls and PCI evidence.",
    Purpose: "Harden the controlled release path.",
    "Affected components and data boundaries": "CI, repository evidence, no customer content.",
    "CDE impact": "possible",
    "CDE-impact rationale": "Change may affect software entering the assessed CDE.",
    "Security impact and threat considered": "Prevents incomplete change evidence from merging.",
    "6.5.1 bespoke/custom security testing": "completed",
    "6.5.1 evidence or rationale": "Scripts test receipt in this pull request.",
    "6.5.2 completion revalidation": "planned",
    "6.5.2 evidence owner and plan/result": "PCI owner validates applicable controls after release.",
    "6.5.3 pre-production separation": "confirmed",
    "6.5.3 evidence or rationale": "CI test environment is separate from production.",
    "6.5.4 role/function separation": "confirmed",
    "6.5.4 evidence or accountability rationale": "Reviewer and change authority differ from author.",
    "6.5.5 live PAN in pre-production": "no live PAN",
    "6.5.5 evidence or rationale": "Synthetic test data only.",
    "6.5.6 test data/accounts removal": "planned",
    "6.5.6 evidence owner and plan/result": "Platform removes synthetic accounts after verification.",
    "Commands and results": "scripts check and tests passed.",
    "Negative/security tests": "Change-record rejection cases passed.",
    "Runtime/integration verification": "Pending: Engineering owner runs hosted CI.",
    "Evidence not collected locally": "Hosted run: Engineering owner expects required checks to pass.",
    "Dependency/SBOM impact": "No dependency change.",
    "Finding/exception links": "None: no new scanner finding accepted by this change.",
    "Deployment/configuration/DDL steps": "Merge after approval; no DDL.",
    "Post-deployment verification": "Engineering confirms required check and released commit.",
    "Failure signal": "Required check failure or missing evidence receipt.",
    "Secure recovery procedure": "Revert the reviewed change through a new pull request.",
    "Incident ID": "Not applicable: normal change.",
    "Emergency authority": "Not applicable: normal change.",
    "Retrospective review due": "Not applicable: normal change.",
    "Non-author reviewer": "@reviewer",
    "Review evidence": "GitHub pull-request review receipt.",
    "Specialist approval": "PCI owner approval receipt.",
    "Release/change-authority decision": "approved",
    ...overrides
  };
  return [
    CHANGE_RECORD_HEADINGS[0],
    ...CHANGE_RECORD_FIELDS.slice(0, 7).map((label) => `- ${label}: ${values[label]}`),
    CHANGE_RECORD_HEADINGS[1],
    ...CHANGE_RECORD_FIELDS.slice(7, 9).map((label) => `- ${label}: ${values[label]}`),
    CHANGE_RECORD_HEADINGS[2],
    ...CHANGE_RECORD_FIELDS.slice(9, 12).map((label) => `- ${label}: ${values[label]}`),
    CHANGE_RECORD_HEADINGS[3],
    ...CHANGE_RECORD_FIELDS.slice(12, 24).map((label) => `- ${label}: ${values[label]}`),
    CHANGE_RECORD_HEADINGS[4],
    ...CHANGE_RECORD_FIELDS.slice(24, 28).map((label) => `- ${label}: ${values[label]}`),
    CHANGE_RECORD_HEADINGS[5],
    ...CHANGE_RECORD_FIELDS.slice(28, 30).map((label) => `- ${label}: ${values[label]}`),
    CHANGE_RECORD_HEADINGS[6],
    ...CHANGE_RECORD_FIELDS.slice(30, 37).map((label) => `- ${label}: ${values[label]}`),
    CHANGE_RECORD_HEADINGS[7],
    ...CHANGE_RECORD_FIELDS.slice(37).map((label) => `- ${label}: ${values[label]}`)
  ].join("\n");
}

describe("PCI change-record gate", () => {
  it("accepts a complete normal change with distinct approval identities", () => {
    assert.deepEqual(verifyChangeRecord(validRecord()), {
      changeId: "TN-CHG-2026-001",
      issues: []
    });
  });

  it("rejects placeholders, unresolved CDE scope, and missing sections", () => {
    const broken = validRecord({
      "CDE impact": "not yet determined",
      Purpose: "<describe purpose>"
    }).replace("## Verification\n", "");
    const issues = verifyChangeRecord(broken).issues;
    assert.ok(issues.includes("missing section: ## Verification"));
    assert.ok(issues.includes("field is incomplete: Purpose"));
    assert.ok(issues.some((issue) => issue.startsWith("CDE impact must be exactly one of")));
  });

  it("rejects author self-review and incomplete significant-change revalidation", () => {
    const issues = verifyChangeRecord(validRecord({
      "Non-author reviewer": "@author",
      "6.5.2 completion revalidation": "not applicable"
    })).issues;
    assert.ok(issues.includes("Non-author reviewer must differ from Author"));
    assert.ok(issues.includes("significant changes cannot mark 6.5.2 completion revalidation not applicable"));
  });

  it("allows an honestly pending PR record without weakening strict approval", () => {
    const pending = validRecord({
      "Non-author reviewer": "Unassigned: repository has no second collaborator",
      "Review evidence": "Pending: independent review has not occurred",
      "Release/change-authority decision": "pending"
    });
    assert.deepEqual(verifyChangeRecord(pending, { allowPendingApproval: true }), {
      changeId: "TN-CHG-2026-001",
      issues: []
    });
    const strictIssues = verifyChangeRecord(pending).issues;
    assert.ok(strictIssues.some((issue) => issue.startsWith(
      "Release/change-authority decision must be exactly one of"
    )));
    assert.ok(strictIssues.includes(
      "Non-author reviewer must be a GitHub username beginning with @"
    ));
  });

  it("removes overlapping HTML comments without exposing hidden fields", () => {
    const hiddenDuplicate = "<!<!-- -->--- Change ID: `TN-CHG-2026-999`-->";
    const result = verifyChangeRecord(`${validRecord()}\n${hiddenDuplicate}`);
    assert.deepEqual(result, {
      changeId: "TN-CHG-2026-001",
      issues: []
    });
  });

  it("requires emergency authority, incident identity, and retrospective date", () => {
    const issues = verifyChangeRecord(validRecord({
      "Change type": "emergency",
      "Incident ID": "Not applicable: normal change.",
      "Emergency authority": "Not applicable: normal change.",
      "Retrospective review due": "tomorrow"
    })).issues;
    assert.ok(issues.includes("emergency changes require an incident ID"));
    assert.ok(issues.includes("emergency changes require an emergency authority"));
    assert.ok(issues.includes("emergency changes require a YYYY-MM-DD retrospective review due date"));
  });

  it("verifies that the repository template retains every required field and section", () => {
    const template = validRecord();
    assert.deepEqual(verifyChangeRecordTemplate(template), []);
    assert.ok(verifyChangeRecordTemplate(template.replace("- Change ID:", "- Removed ID:")).includes(
      "change-record template is missing field: Change ID"
    ));
  });
});
