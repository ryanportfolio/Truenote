import { describe, expect, it } from "vitest";
import {
  canAccessProgram,
  canManageUser,
  type CurrentUser,
} from "../../auth/current-user.js";
import { applyVersionActivity, type LinkedSource } from "../../citations.js";
import { canReadClassification } from "../classification.js";
import {
  canApproveDocumentVersion,
  evaluateDocumentApproval,
  evaluateDocumentPurge,
} from "../document-policy.js";

function user(
  id: string,
  role: CurrentUser["role"],
  programId: string | null,
): CurrentUser {
  return {
    id,
    email: `${id}@example.com`,
    role,
    programId,
    name: id,
    mustResetPassword: false,
  };
}

const source: LinkedSource = {
  citation_index: 1,
  chunk_id: "11111111-1111-4111-8111-111111111111",
  doc_id: "22222222-2222-4222-8222-222222222222",
  document_version_id: "33333333-3333-4333-8333-333333333333",
  doc_title: "Controlled document",
  version_number: 1,
  excerpt: "Controlled excerpt",
  source_start: null,
  source_end: null,
  superseded: false,
};

describe("negative security controls", () => {
  it("denies cross-program access and malformed unscoped principals", () => {
    expect(canAccessProgram(user("manager", "manager", "program-a"), "program-b")).toBe(
      false,
    );
    expect(canAccessProgram(user("manager", "manager", null), "program-a")).toBe(
      false,
    );
  });

  it("denies user self-administration, cross-program targets, and privileged targets", () => {
    const manager = user("manager", "manager", "program-a");
    expect(
      canManageUser(manager, {
        id: manager.id,
        role: "manager",
        programId: "program-a",
      }),
    ).toBe(false);
    expect(
      canManageUser(manager, {
        id: "csr-b",
        role: "csr",
        programId: "program-b",
      }),
    ).toBe(false);
    expect(
      canManageUser(manager, {
        id: "admin",
        role: "super_user",
        programId: null,
      }),
    ).toBe(false);
  });

  it("denies content above server-owned clearance", () => {
    expect(canReadClassification("internal", "confidential")).toBe(false);
    expect(canReadClassification("confidential", "restricted")).toBe(false);
  });

  it("offers pending-review approval to senior managers and super users", () => {
    expect(canApproveDocumentVersion("senior_manager", "pending_review")).toBe(true);
    expect(canApproveDocumentVersion("super_user", "pending_review")).toBe(true);
    expect(canApproveDocumentVersion("manager", "pending_review")).toBe(false);
    expect(canApproveDocumentVersion("super_user", "active")).toBe(false);
  });

  it("denies unsafe scans, blocking findings, and stale sources", () => {
    const base = {
      lifecycleState: "pending_review",
      parseStatus: "ready",
      scanStatus: "clean",
      sourceId: "source-1",
      sourceActive: true,
      sourceApprovedAt: new Date("2026-07-14T00:00:00Z"),
      findings: [],
      acknowledgeFindings: false,
    };
    expect(evaluateDocumentApproval({ ...base, scanStatus: "failed" }).allowed).toBe(
      false,
    );
    expect(
      evaluateDocumentApproval({
        ...base,
        findings: [{ rule: "private-key", blocking: true }],
        acknowledgeFindings: true,
      }).allowed,
    ).toBe(false);
    expect(
      evaluateDocumentApproval({ ...base, sourceActive: false }).allowed,
    ).toBe(false);
    expect(evaluateDocumentApproval(base)).toEqual({ allowed: true });
    const disabledScan = {
      ...base,
      scanStatus: "disabled",
      findings: [{ ruleId: "malware.scanning_disabled", blocking: false }]
    };
    expect(evaluateDocumentApproval(disabledScan)).toEqual({ allowed: true });
  });

  it("denies purge without title match, retirement, or elapsed retention", () => {
    const base = {
      title: "Controlled document",
      confirmTitle: "Controlled document",
      lifecycleState: "retired",
      retentionElapsed: true,
      retentionOverrideEnabled: false,
    };
    expect(
      evaluateDocumentPurge({ ...base, confirmTitle: "Wrong title" }).allowed,
    ).toBe(false);
    expect(evaluateDocumentPurge({ ...base, lifecycleState: "active" }).allowed).toBe(
      false,
    );
    expect(evaluateDocumentPurge({ ...base, retentionElapsed: false }).allowed).toBe(
      false,
    );
    expect(evaluateDocumentPurge(base)).toEqual({ allowed: true });
  });

  it("removes revoked content from durable citation history", () => {
    expect(
      applyVersionActivity(
        [source],
        new Map([
          [
            "33333333-3333-4333-8333-333333333333",
            { isActive: false, lifecycleState: "revoked" },
          ],
        ]),
      ),
    ).toEqual([]);
  });
});
