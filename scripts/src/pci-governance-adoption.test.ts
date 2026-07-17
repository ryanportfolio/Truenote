import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  PCI_GOVERNANCE_POLICY_SPECS,
  PCI_GOVERNANCE_ROLE_IDS,
  verifyPciPolicyAdoption,
  verifyPciRoleAssignments
} from "./pci-governance-adoption.js";

const NOW = new Date("2026-07-16T23:00:00.000Z");

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function roleRecord() {
  return {
    schemaVersion: 1,
    recordId: "TN-PCI-ROLES-2026-001",
    effectiveAt: "2026-07-15T00:00:00.000Z",
    nextReviewDate: "2027-07-15",
    preparedByPrincipalId: "group:governance-record-keepers",
    roles: PCI_GOVERNANCE_ROLE_IDS.map((id, index) => ({
      id,
      assigneePrincipalId: `group:${id}`,
      delegatePrincipalId: `group:${id}:delegate`,
      appointmentReference: `TN-APPOINT-2026-${String(index + 1).padStart(3, "0")}`,
      assigneeAcknowledgementReference: `TN-ACK-2026-${String((index * 2) + 1).padStart(3, "0")}`,
      delegateAcknowledgementReference: `TN-ACK-2026-${String((index * 2) + 2).padStart(3, "0")}`,
      acceptedAt: "2026-07-14T16:00:00.000Z"
    })),
    unresolvedItems: [] as string[],
    decision: "approved",
    signoffs: [
      {
        role: "executive_appointing_authority",
        principalId: "group:executive-appointing-authority",
        decision: "approved",
        decidedAt: "2026-07-14T18:00:00.000Z",
        evidenceReference: "TN-ROLE-APPROVAL-2026-001"
      },
      {
        role: "compliance_accepting_entity",
        principalId: "group:compliance-accepting-authority",
        decision: "approved",
        decidedAt: "2026-07-14T19:00:00.000Z",
        evidenceReference: "TN-ROLE-APPROVAL-2026-002"
      }
    ]
  };
}

function policyDocuments(recordId = "TN-PCI-POLICY-2026-001"): Record<string, Uint8Array> {
  return Object.fromEntries(PCI_GOVERNANCE_POLICY_SPECS.map((spec) => [
    spec.id,
    Buffer.from(`# ${spec.id}\n\n**Status:** Approved\n**Adoption record:** ${recordId}\n\nControlled test policy.\n`)
  ]));
}

function policyRecord(roleBytes: Uint8Array, documents = policyDocuments()) {
  return {
    schemaVersion: 1,
    recordId: "TN-PCI-POLICY-2026-001",
    effectiveAt: "2026-07-15T12:00:00.000Z",
    nextReviewDate: "2027-07-15",
    preparedByPrincipalId: "group:policy-record-keepers",
    roleAssignmentRecordId: "TN-PCI-ROLES-2026-001",
    roleAssignmentRecordSha256: digest(roleBytes),
    policies: PCI_GOVERNANCE_POLICY_SPECS.map((spec, index) => ({
      id: spec.id,
      repositoryPath: spec.path,
      repositorySha256: digest(documents[spec.id]!),
      version: "2026.1",
      decision: "approved",
      approvalReference: `TN-POLICY-APPROVAL-2026-${String(index + 1).padStart(3, "0")}`,
      exceptions: [] as Array<Record<string, unknown>>
    })),
    communicationReferences: ["TN-POLICY-COMMUNICATION-2026-001"],
    trainingPlanReference: "TN-TRAINING-PLAN-2026-001",
    unresolvedItems: [] as string[],
    decision: "approved",
    signoffs: [
      "engineering_owner",
      "product_security",
      "pci_scope_owner",
      "qsa_or_compliance_accepting_entity"
    ].map((role, index) => ({
      role,
      principalId: `group:${role}`,
      decision: "approved",
      decidedAt: `2026-07-15T${String(8 + index).padStart(2, "0")}:00:00.000Z`,
      evidenceReference: `TN-POLICY-SIGNOFF-2026-${String(index + 1).padStart(3, "0")}`
    }))
  };
}

function roleBytes(record = roleRecord()): Uint8Array {
  return Buffer.from(JSON.stringify(record));
}

describe("PCI governance adoption records", () => {
  it("accepts complete role assignments and exact-byte-linked approved policies", () => {
    const roles = roleRecord();
    const rolesBytes = roleBytes(roles);
    const documents = policyDocuments();
    const policy = policyRecord(rolesBytes, documents);
    assert.equal(verifyPciRoleAssignments(roles, { now: NOW }).structurallyAccepted, true);
    assert.equal(verifyPciPolicyAdoption(policy, {
      now: NOW,
      roleAssignmentRecordBytes: rolesBytes,
      policyDocumentBytes: documents
    }).structurallyAccepted, true);
  });

  it("rejects incomplete appointments, critical separation failures, and self-approval", () => {
    const roles = roleRecord();
    roles.roles.pop();
    roles.roles.push({ ...roles.roles[0]! });
    const engineering = roles.roles.find((role) => role.id === "engineering_owner")!;
    const reviewer = roles.roles.find((role) => role.id === "independent_code_reviewer")!;
    reviewer.assigneePrincipalId = engineering.assigneePrincipalId;
    reviewer.delegatePrincipalId = reviewer.assigneePrincipalId;
    roles.unresolvedItems = ["Appointment conflict remains open"];
    roles.nextReviewDate = "2026-07-15";
    roles.signoffs[0]!.principalId = roles.preparedByPrincipalId;
    roles.signoffs[1]!.principalId = roles.signoffs[0]!.principalId;
    const result = verifyPciRoleAssignments(roles, { now: NOW });
    assert.ok(result.issues.includes("duplicate PCI role assignment: pci_scope_owner"));
    assert.ok(result.issues.includes("missing PCI role assignment: vendor_risk_owner"));
    assert.ok(result.issues.includes("PCI role separation requires non-overlapping assignee/delegate principals for engineering_owner and independent_code_reviewer"));
    assert.ok(result.issues.some((issue) => issue.includes("assignee and delegate principal IDs must differ")));
    assert.ok(result.issues.includes("PCI role-assignment unresolvedItems must be empty before approval"));
    assert.ok(result.issues.includes("PCI role-assignment record nextReviewDate must not be past due"));
    assert.ok(result.issues.some((issue) => issue.includes("principalId must differ from the preparer")));
    assert.ok(result.issues.includes("PCI role-assignment signoff principals must be distinct"));

    const delegatedCollision = roleRecord();
    const pciOwner = delegatedCollision.roles.find((role) => role.id === "pci_scope_owner")!;
    const qsa = delegatedCollision.roles.find((role) => role.id === "qsa_or_compliance_accepting_entity")!;
    qsa.delegatePrincipalId = pciOwner.delegatePrincipalId;
    assert.ok(verifyPciRoleAssignments(delegatedCollision, { now: NOW }).issues.includes(
      "PCI role separation requires non-overlapping assignee/delegate principals for pci_scope_owner and qsa_or_compliance_accepting_entity"
    ));
  });

  it("rejects mutated role/policy bytes, draft headers, and unlinked signers", () => {
    const rolesBytes = roleBytes();
    const documents = policyDocuments();
    const policy = policyRecord(rolesBytes, documents);
    policy.roleAssignmentRecordSha256 = "A".repeat(64);
    policy.effectiveAt = "2026-07-14T12:00:00.000Z";
    policy.signoffs[0]!.principalId = "group:alternate-engineering-approver";
    policy.signoffs[0]!.decidedAt = "2026-07-14T10:00:00.000Z";
    const mutatedDocuments = { ...documents };
    mutatedDocuments.secure_development_lifecycle = Buffer.from(
      "# secure_development_lifecycle\n\n**Status:** Approved\n**Status:** Draft\n**Adoption record:** TN-PCI-POLICY-2026-001\n**Adoption record:** TN-PCI-POLICY-2026-999\n"
    );
    const result = verifyPciPolicyAdoption(policy, {
      now: NOW,
      roleAssignmentRecordBytes: rolesBytes,
      policyDocumentBytes: mutatedDocuments
    });
    assert.ok(result.issues.includes("PCI policy adoption roleAssignmentRecordSha256 must match the exact linked role bytes"));
    assert.ok(result.issues.includes("PCI policy adoption effectiveAt must not precede linked role assignments"));
    assert.ok(result.issues.includes("PCI policy adoption 1 repositorySha256 must match the exact policy document bytes"));
    assert.ok(result.issues.includes("PCI policy adoption 1 policy header must contain exactly one Status: Approved declaration"));
    assert.ok(result.issues.includes("PCI policy adoption 1 policy header must contain exactly one matching adoption-record declaration"));
    assert.ok(result.issues.includes("PCI policy-adoption signoff 1 principalId must match the linked role assignee"));
    assert.ok(result.issues.includes("PCI policy-adoption signoff 1 decidedAt must not precede linked role assignments"));
  });

  it("requires communication, training, controlled exceptions, and complete policy coverage", () => {
    const rolesBytes = roleBytes();
    const documents = policyDocuments();
    const policy = policyRecord(rolesBytes, documents);
    policy.policies.pop();
    policy.policies.push({ ...policy.policies[0]! });
    policy.communicationReferences = [];
    policy.trainingPlanReference = "pending";
    policy.unresolvedItems = ["Training scope is open"];
    policy.policies[0]!.exceptions = [{
      id: "TN-PCI-EXCEPTION-2026-001",
      rationale: "short",
      ownerPrincipalId: "group:not-an-assigned-role",
      expiresAt: "2027-08-01T00:00:00.000Z",
      approvalReference: "TN-EXCEPTION-APPROVAL-2026-001",
      status: "pending"
    }, {
      id: "TN-PCI-EXCEPTION-2026-002",
      rationale: "This otherwise controlled exception is deliberately expired for validator coverage.",
      ownerPrincipalId: "group:engineering_owner",
      expiresAt: "2026-07-16T12:00:00.000Z",
      approvalReference: "TN-EXCEPTION-APPROVAL-2026-001",
      status: "approved"
    }];
    const result = verifyPciPolicyAdoption(policy, {
      now: NOW,
      roleAssignmentRecordBytes: rolesBytes,
      policyDocumentBytes: documents
    });
    assert.ok(result.issues.includes("duplicate PCI policy adoption: secure_development_lifecycle"));
    assert.ok(result.issues.includes("missing PCI policy adoption: third_party_responsibility_matrix"));
    assert.ok(result.issues.includes("PCI policy-adoption communicationReferences must not be empty"));
    assert.ok(result.issues.includes("PCI policy-adoption trainingPlanReference must not contain placeholder text"));
    assert.ok(result.issues.includes("PCI policy-adoption unresolvedItems must be empty before approval"));
    assert.ok(result.issues.some((issue) => issue.includes("rationale must be substantive")));
    assert.ok(result.issues.some((issue) => issue.includes("ownerPrincipalId must be an assigned governance-role principal")));
    assert.ok(result.issues.some((issue) => issue.includes("expiresAt must not follow nextReviewDate")));
    assert.ok(result.issues.some((issue) => issue.includes("expiresAt must not be expired")));
    assert.ok(result.issues.includes("PCI policy and exception approval references must be distinct"));
    assert.ok(result.issues.some((issue) => issue.includes("status must equal approved")));
  });

  it("rejects repository-unsafe governance principals, references, and exception content", () => {
    const roles = roleRecord();
    roles.roles[0]!.assigneePrincipalId = "alice@example.com";
    roles.roles[0]!.appointmentReference = "TN-APPOINT-DB-PROD-2026-001";
    const roleResult = verifyPciRoleAssignments(roles, { now: NOW });
    assert.ok(roleResult.issues.some((issue) => issue.includes("assigneePrincipalId must be a stable principal identifier")));
    assert.ok(roleResult.issues.some((issue) => issue.includes("appointmentReference must be an opaque controlled reference ID")));

    const rolesBytes = roleBytes();
    const documents = policyDocuments();
    const unsafeCases = [
      ["The approved exception would expose PAN 4111 1111 1111 1111 in repository metadata.", "PAN-like value"],
      ["The approved exception includes token=ABC123 and therefore exposes credential material.", "credential-like assignment"],
      ["The approved exception targets 10.0.0.1 and therefore exposes a private network address.", "IPv4 address"],
      ["The approved exception targets postgres://db-prod-01/app and exposes a service endpoint.", "URL"],
      ["The approved exception names alice@example.com and therefore exposes personal contact data.", "email address"],
      ["The approved exception targets DB-PROD-01 and therefore exposes a single-label hostname.", "single-label hostname-like value"],
      ["The approved exception contains SSN 123 45 6789 and therefore exposes a spaced SSN value.", "SSN-like value"],
      ["The approved exception contains SSN 123456789 and therefore exposes a compact SSN value.", "SSN-like value"],
      ["The approved exception contains account 123456789012 and therefore exposes a raw account number.", "12-digit account identifier"]
    ] as const;
    for (const [rationale, reason] of unsafeCases) {
      const policy = policyRecord(rolesBytes, documents);
      policy.policies[0]!.exceptions = [{
        id: "TN-PCI-EXCEPTION-2026-001",
        rationale,
        ownerPrincipalId: "group:engineering_owner",
        expiresAt: "2027-01-15T00:00:00.000Z",
        approvalReference: "TN-EXCEPTION-APPROVAL-2026-001",
        status: "approved"
      }];
      const result = verifyPciPolicyAdoption(policy, {
        now: NOW,
        roleAssignmentRecordBytes: rolesBytes,
        policyDocumentBytes: documents
      });
      assert.ok(
        result.issues.includes(`PCI policy adoption 1 exception 1 rationale must not contain a repository-unsafe ${reason}`),
        `${reason} should be rejected`
      );
    }
  });

  it("enforces the combined CLI and duplicate-key-free exact input files", () => {
    const directory = mkdtempSync(join(tmpdir(), "truenote-pci-governance-"));
    try {
      const roles = roleRecord();
      const rolesText = `${JSON.stringify(roles, null, 2)}\n`;
      const documents = policyDocuments();
      for (const spec of PCI_GOVERNANCE_POLICY_SPECS) {
        const path = join(directory, spec.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, documents[spec.id]!);
      }
      const policy = policyRecord(Buffer.from(rolesText), documents);
      const rolesPath = join(directory, "roles.json");
      const policyPath = join(directory, "policy.json");
      const duplicateRolesPath = join(directory, "duplicate-roles.json");
      writeFileSync(rolesPath, rolesText, "utf8");
      writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
      writeFileSync(
        duplicateRolesPath,
        rolesText.replace('"decision": "approved",', '"decision": "approved",\n  "decision": "pending",'),
        "utf8"
      );
      const cli = fileURLToPath(new URL("./verify-pci-governance-adoption.ts", import.meta.url));
      const run = (...args: string[]) => spawnSync(
        process.execPath,
        ["--import", "tsx", cli, ...args],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, INIT_CWD: directory }
        }
      );
      const accepted = run("--roles", rolesPath, "--policy", policyPath);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.match(accepted.stdout, /6 policies and linked role assignments structurally accepted/);
      assert.equal(run("--roles", rolesPath).status, 2);
      assert.equal(run("--roles", rolesPath, "--policy", policyPath, "--unknown").status, 2);
      const duplicate = run("--roles", duplicateRolesPath, "--policy", policyPath);
      assert.equal(duplicate.status, 1);
      assert.match(duplicate.stderr, /duplicate JSON key: decision/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
