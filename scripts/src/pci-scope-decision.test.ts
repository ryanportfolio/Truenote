import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PCI_SCOPE_FLOW_IDS,
  PCI_SCOPE_PROVIDER_IDS,
  verifyPciScopeDecision
} from "./pci-scope-decision.js";

function digest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").toUpperCase();
}

function bytes(input: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(input));
}

function inventoryReceipt(
  reference: string,
  inventoryCategory: string,
  artifactType: "inventory" | "absence_attestation" = "inventory"
) {
  return {
    reference,
    sha256: digest({ reference, inventoryCategory, artifactType }),
    artifactType,
    inventoryCategory,
    environmentReference: "TN-TEST-ENVIRONMENT-2026-001",
    architectureReleaseReference: "TN-ARCH-RELEASE-2026-001",
    reviewerPrincipalId: "group:scope-inventory-reviewers",
    reviewedAt: "2026-07-16T16:00:00.000Z"
  };
}

function provisionalDecision() {
  return {
    schemaVersion: 1,
    recordId: "TN-PCI-SCOPE-2026-001",
    decisionDate: "2026-07-16",
    decisionStage: "provisional_test_authorization",
    supersedesRecordId: null as string | null,
    provisionalRecordSha256: null as string | null,
    preparedBy: "Architecture Working Group",
    preparedByPrincipalId: "group:architecture-working-group",
    scope: {
      cdeRelationship: "security_impacting",
      validationPath: "existing_cde_assessment",
      canImpactCdeSecurity: true,
      rationale: "TrueNote would become custom software governed within the existing assessed CDE process.",
      accountableParties: {
        assessedEntityReference: "TN-ASSESSMENT-ENTITY-2026-001",
        applicationOperatorReference: "TN-APPLICATION-OPERATOR-2026-001",
        customerCdeOwnerReference: "TN-CDE-OWNER-2026-001"
      },
      infrastructureInventories: {
        administrativeAndSupportPaths: {
          status: "present",
          rationale: "Administrative and support paths can affect the proposed deployment and require explicit scope treatment.",
          evidenceReceipts: [inventoryReceipt("TN-ADMIN-PATH-INVENTORY-2026-001", "administrative_and_support_paths")]
        },
        networkAndManagementPaths: {
          status: "present",
          rationale: "Network and management-plane paths can affect connectivity to the assessed environment.",
          evidenceReceipts: [inventoryReceipt("TN-NETWORK-PATH-INVENTORY-2026-001", "network_and_management_paths")]
        },
        dataStores: {
          status: "present",
          rationale: "Application data stores and backups require explicit inventory and data-classification review.",
          evidenceReceipts: [inventoryReceipt("TN-DATA-STORE-INVENTORY-2026-001", "data_stores")]
        },
        backupsAndRecoveryCopies: {
          status: "present",
          rationale: "Backup and recovery copies require a distinct inventory because their paths and retention can differ from live data stores.",
          evidenceReceipts: [inventoryReceipt("TN-BACKUP-INVENTORY-2026-001", "backups_and_recovery_copies")]
        }
      },
      inScopeComponents: [
        "application_api",
        "administrative_access",
        "deployment_pipeline",
        "database",
        "object_storage",
        "backups_and_recovery"
      ],
      outOfScopeComponents: ["public_documentation"],
      connectedSystems: ["cde_identity_services", "cde_network_services"],
      flowDecisions: PCI_SCOPE_FLOW_IDS.map((id) => ({
        id,
        decision: "in_scope",
        rationale: `The current architecture includes ${id} in the bounded trace.`,
        evidenceReference: `TN-FLOW-DECISION-${id}`
      }))
    },
    panPolicy: {
      policy: "prohibited",
      allowedPaths: [] as string[],
      prohibitedPaths: ["All questions, documents, logs, providers, and exports"],
      enforcementReferences: ["SEC-POLICY-DATA#pan-prohibition", "TN-CONTROL-PROVIDER-FIREWALL"]
    },
    segmentation: {
      reliedUpon: false,
      boundaries: [] as string[],
      controlReference: null as string | null,
      testApplicability: "not_required",
      testPlanReference: null as string | null
    },
    providers: PCI_SCOPE_PROVIDER_IDS.map((id) => ({
      id,
      name: `Approved inventory entry for ${id}`,
      decision: "shared_responsibility",
      rationale: "Service responsibility and data path were reviewed for the proposed deployment.",
      responsibilityReference: `TN-PROVIDER-${id}`
    })),
    requirements: [
      {
        id: "6.4.2",
        applicability: "applicable",
        rationale: "The proposed deployment includes a public-facing web application in the assessed environment.",
        controlPlanReference: "TN-PCI-CONTROL-6.4.2"
      },
      {
        id: "6.4.3",
        applicability: "not_applicable",
        rationale: "TrueNote does not provide, embed, or manage payment-page scripts in the approved architecture.",
        controlPlanReference: null
      },
      {
        id: "11.4",
        applicability: "applicable",
        rationale: "Application and API penetration testing applies even though this decision does not rely on segmentation.",
        controlPlanReference: "TN-INDEPENDENT-TESTING-PLAN"
      }
    ],
    evidence: {
      dataFlowReference: "TN-DATA-FLOW-2026-001",
      scopeInventoryReference: "TN-SCOPE-INVENTORY-2026-001",
      syntheticTraceReference: null as string | null,
      architectureReleaseReference: "TN-ARCH-RELEASE-2026-001",
      qsaOrAssessorDirectionReference: "TN-QSA-DIRECTION-2026-001"
    },
    syntheticTestAuthorization: {
      status: "authorized",
      environmentReference: "TN-TEST-ENVIRONMENT-2026-001",
      testAccountReference: "TN-TEST-ACCOUNT-2026-001",
      authorizedFlowIds: [...PCI_SCOPE_FLOW_IDS] as string[],
      syntheticDataOnly: true,
      panProhibited: true,
      destructiveTestingProhibited: true,
      authorizationReference: "TN-SYNTHETIC-AUTHORIZATION-2026-001",
      issuedAt: "2026-07-16T18:30:00.000Z",
      expiresAt: "2026-07-30T23:59:59.000Z",
      traceFlowIds: [] as string[],
      traceReceiptReference: null as string | null,
      traceReceiptSha256: null as string | null,
      startedAt: null as string | null,
      completedAt: null as string | null
    },
    unresolvedQuestions: ["Execute the authorized synthetic trace and reconcile its receipts"],
    decision: "authorized_for_synthetic_testing",
    signoffs: [
      {
        role: "pci_scope_owner",
        identity: "PCI Scope Owner Team",
        principalId: "group:pci-scope-owners",
        decision: "authorized",
        decidedAt: "2026-07-16T17:00:00.000Z",
        evidenceReference: "TN-AUTHORIZATION-PCI-2026-001"
      },
      {
        role: "compliance_accepting_entity",
        identity: "Compliance Acceptance Team",
        principalId: "group:compliance-acceptance",
        decision: "authorized",
        decidedAt: "2026-07-16T18:00:00.000Z",
        evidenceReference: "TN-AUTHORIZATION-COMPLIANCE-2026-001"
      }
    ]
  };
}

function traceReceipt(provisional = provisionalDecision()) {
  return {
    schemaVersion: 1,
    receiptId: "TN-SYNTHETIC-TRACE-2026-001",
    provisionalRecordId: provisional.recordId,
    provisionalRecordSha256: digest(provisional),
    authorizationReference: provisional.syntheticTestAuthorization.authorizationReference,
    environmentReference: provisional.syntheticTestAuthorization.environmentReference,
    testAccountReference: provisional.syntheticTestAuthorization.testAccountReference,
    flowIds: [...PCI_SCOPE_FLOW_IDS],
    startedAt: "2026-07-16T19:00:00.000Z",
    completedAt: "2026-07-16T20:00:00.000Z",
    result: "passed",
    coverageGaps: [] as string[],
    operatorPrincipalId: "user:synthetic-trace-operator",
    reviewerPrincipalId: "user:synthetic-trace-reviewer",
    reviewedAt: "2026-07-16T21:00:00.000Z",
    restrictedArtifactReference: "TN-RESTRICTED-TRACE-ARTIFACT-2026-001"
  };
}

function finalDecision(provisional = provisionalDecision(), receipt = traceReceipt(provisional)) {
  const final = structuredClone(provisional);
  final.recordId = "TN-PCI-SCOPE-2026-002";
  final.decisionDate = "2026-07-17";
  final.decisionStage = "final_scope_acceptance";
  final.supersedesRecordId = provisional.recordId;
  final.provisionalRecordSha256 = digest(provisional);
  final.evidence.syntheticTraceReference = "TN-SYNTHETIC-TRACE-2026-001";
  final.syntheticTestAuthorization.status = "completed";
  final.syntheticTestAuthorization.traceFlowIds = [...PCI_SCOPE_FLOW_IDS];
  final.syntheticTestAuthorization.traceReceiptReference = "TN-SYNTHETIC-TRACE-2026-001";
  final.syntheticTestAuthorization.traceReceiptSha256 = digest(receipt);
  final.syntheticTestAuthorization.startedAt = receipt.startedAt;
  final.syntheticTestAuthorization.completedAt = receipt.completedAt;
  final.unresolvedQuestions = [];
  final.decision = "approved";
  final.signoffs = [
    {
      role: "pci_scope_owner",
      identity: "PCI Scope Owner Team",
      principalId: "group:pci-scope-owners",
      decision: "approved",
      decidedAt: "2026-07-17T20:00:00.000Z",
      evidenceReference: "TN-APPROVAL-PCI-2026-002"
    },
    {
      role: "compliance_accepting_entity",
      identity: "Compliance Acceptance Team",
      principalId: "group:compliance-acceptance",
      decision: "approved",
      decidedAt: "2026-07-17T21:00:00.000Z",
      evidenceReference: "TN-APPROVAL-COMPLIANCE-2026-002"
    }
  ];
  return final;
}

const provisionalOptions = { now: new Date("2026-07-17T00:00:00.000Z") };

function finalOptions(
  provisional = provisionalDecision(),
  now = "2026-07-18T00:00:00.000Z",
  receipt = traceReceipt(provisional)
) {
  return {
    now: new Date(now),
    provisionalRecordBytes: bytes(provisional),
    traceReceiptBytes: bytes(receipt)
  };
}

describe("PCI scope decision record", () => {
  it("accepts a complete final record bound to a valid provisional authorization", () => {
    const provisional = provisionalDecision();
    assert.deepEqual(verifyPciScopeDecision(finalDecision(provisional), finalOptions(provisional)), {
      issues: [],
      structurallyAccepted: true,
      structurallyFinalAccepted: true,
      stage: "final_scope_acceptance"
    });

    const reviewedAfterAuthorizationExpiry = finalDecision(provisional);
    reviewedAfterAuthorizationExpiry.decisionDate = "2026-08-01";
    reviewedAfterAuthorizationExpiry.signoffs[0]!.decidedAt = "2026-08-01T20:00:00.000Z";
    reviewedAfterAuthorizationExpiry.signoffs[1]!.decidedAt = "2026-08-01T21:00:00.000Z";
    assert.equal(
      verifyPciScopeDecision(
        reviewedAfterAuthorizationExpiry,
        finalOptions(provisional, "2026-08-02T00:00:00.000Z")
      ).structurallyFinalAccepted,
      true
    );
  });

  it("accepts only bounded provisional authorization without final acceptance", () => {
    assert.deepEqual(verifyPciScopeDecision(provisionalDecision(), provisionalOptions), {
      issues: [],
      structurallyAccepted: true,
      structurallyFinalAccepted: false,
      stage: "provisional_test_authorization"
    });
  });

  it("rejects future, placeholder, unresolved, and self-approved decisions", () => {
    const provisional = provisionalDecision();
    const invalid = finalDecision(provisional);
    invalid.decisionDate = "2026-07-19";
    invalid.preparedBy = "PCI Scope Owner Team";
    invalid.preparedByPrincipalId = "group:pci-scope-owners";
    invalid.scope.rationale = "TBD";
    invalid.unresolvedQuestions = ["Confirm network route"];
    invalid.signoffs[0]!.decidedAt = "2026-07-19T20:00:00.000Z";
    const result = verifyPciScopeDecision(invalid, finalOptions(provisional));
    assert.ok(result.issues.includes("scope decision decisionDate must not be in the future"));
    assert.ok(result.issues.includes("scope decision scope rationale must not contain placeholder text"));
    assert.ok(result.issues.includes("final scope acceptance requires no unresolved questions"));
    assert.ok(result.issues.includes("scope decision preparer cannot approve the record"));
    assert.ok(result.issues.includes("scope decision preparer principal cannot approve the record"));
    assert.ok(result.issues.includes("scope decision signoff 1 decidedAt must not be in the future"));

    const repositoryTemplate = JSON.parse(readFileSync(
      new URL("../../docs/compliance/pci/pci-scope-decision-record-template.json", import.meta.url),
      "utf8"
    )) as unknown;
    const templateResult = verifyPciScopeDecision(repositoryTemplate, provisionalOptions);
    assert.equal(templateResult.structurallyAccepted, false);
    assert.ok(templateResult.issues.some((issue) => issue.includes("decisionStage")));
    assert.ok(templateResult.issues.some((issue) => issue.includes("placeholder text")));
  });

  it("rejects unsafe or expired provisional authorization and incomplete final acceptance", () => {
    const provisional = provisionalDecision();
    provisional.syntheticTestAuthorization.syntheticDataOnly = false;
    provisional.syntheticTestAuthorization.authorizedFlowIds = ["TN-FLOW-99"];
    provisional.syntheticTestAuthorization.expiresAt = "2026-07-16T12:00:00.000Z";
    provisional.syntheticTestAuthorization.completedAt = "2026-07-16T11:00:00.000Z";
    const provisionalResult = verifyPciScopeDecision(provisional, provisionalOptions);
    assert.ok(provisionalResult.issues.includes("scope decision syntheticTestAuthorization requires syntheticDataOnly=true"));
    assert.ok(provisionalResult.issues.includes("scope decision syntheticTestAuthorization has invalid flow id: TN-FLOW-99"));
    assert.ok(provisionalResult.issues.includes("provisional scope authorization requires unexpired synthetic testing authorization"));
    assert.ok(provisionalResult.issues.includes("provisional scope authorization requires null syntheticTestAuthorization completedAt"));

    const linked = provisionalDecision();
    const final = finalDecision(linked);
    final.evidence.syntheticTraceReference = null;
    final.unresolvedQuestions = ["Trace reconciliation remains open"];
    final.syntheticTestAuthorization.expiresAt = "2026-07-16T19:30:00.000Z";
    const finalResult = verifyPciScopeDecision(final, finalOptions(linked));
    assert.ok(finalResult.issues.includes("scope decision evidence syntheticTraceReference must be non-blank"));
    assert.ok(finalResult.issues.includes("final scope acceptance requires no unresolved questions"));
    assert.ok(finalResult.issues.includes("final scope acceptance requires synthetic trace completion on or before authorization expiry"));
  });

  it("enforces conditional PAN-path, segmentation, and CDE-path decisions", () => {
    const invalid = provisionalDecision();
    invalid.panPolicy.policy = "permitted_named_paths";
    invalid.scope.cdeRelationship = "security_impacting";
    invalid.scope.validationPath = "out_of_scope_determination";
    invalid.segmentation.reliedUpon = true;
    invalid.requirements[2]!.applicability = "not_applicable";
    invalid.requirements[2]!.controlPlanReference = null;
    const result = verifyPciScopeDecision(invalid, provisionalOptions);
    assert.ok(result.issues.includes("permitted PAN policy requires named allowedPaths"));
    assert.ok(result.issues.includes("in-scope, connected, or security-impacting relationships cannot use out_of_scope_determination"));
    assert.ok(result.issues.includes("segmentation reliance requires named boundaries"));
    assert.ok(result.issues.includes("segmentation reliance requires Requirement 11.4 testing"));
    assert.ok(result.issues.includes("segmentation reliance requires Requirement 11.4 applicability=applicable"));
  });

  it("requires every provider, requirement, and flow decision exactly once", () => {
    const invalid = provisionalDecision();
    invalid.providers.pop();
    invalid.providers.push({ ...invalid.providers[0]! });
    invalid.requirements.pop();
    invalid.requirements.push({ ...invalid.requirements[0]! });
    invalid.scope.flowDecisions.pop();
    invalid.scope.flowDecisions.push({ ...invalid.scope.flowDecisions[0]! });
    const result = verifyPciScopeDecision(invalid, provisionalOptions);
    assert.ok(result.issues.some((issue) => issue.startsWith("duplicate scope decision provider id")));
    assert.ok(result.issues.includes("missing scope decision provider: siem"));
    assert.ok(result.issues.some((issue) => issue.startsWith("duplicate scope decision requirement id")));
    assert.ok(result.issues.includes("missing scope decision requirement: 11.4"));
    assert.ok(result.issues.some((issue) => issue.startsWith("duplicate scope decision flow id")));
    assert.ok(result.issues.includes("missing scope decision flow: TN-FLOW-05"));
  });

  it("requires evidenced accountable parties and infrastructure inventories", () => {
    const verifiedAbsent = provisionalDecision();
    verifiedAbsent.scope.inScopeComponents = verifiedAbsent.scope.inScopeComponents.filter(
      (id) => id !== "backups_and_recovery"
    );
    verifiedAbsent.scope.infrastructureInventories.backupsAndRecoveryCopies = {
      status: "none_verified",
      rationale: "The reviewed backup configuration and recovery model contain no separate backup or recovery copy for this bounded architecture.",
      evidenceReceipts: [inventoryReceipt("TN-BACKUP-ABSENCE-2026-001", "backups_and_recovery_copies", "absence_attestation")]
    };
    assert.equal(verifyPciScopeDecision(verifiedAbsent, provisionalOptions).structurallyAccepted, true);

    const invalid = provisionalDecision();
    delete (invalid.scope.accountableParties as unknown as Record<string, unknown>).assessedEntityReference;
    invalid.scope.accountableParties.applicationOperatorReference = "Platform Team";
    invalid.scope.infrastructureInventories.administrativeAndSupportPaths.status = "none_verified";
    invalid.scope.infrastructureInventories.administrativeAndSupportPaths.evidenceReceipts = [
      inventoryReceipt("TN-ADMIN-PATH-ABSENCE-2026-001", "administrative_and_support_paths", "absence_attestation")
    ];
    invalid.scope.infrastructureInventories.networkAndManagementPaths.status = "none_verified";
    invalid.scope.infrastructureInventories.networkAndManagementPaths.evidenceReceipts = [
      inventoryReceipt("TN-NETWORK-PATH-ABSENCE-2026-001", "network_and_management_paths", "absence_attestation")
    ];
    invalid.scope.infrastructureInventories.dataStores.status = "none_verified";
    invalid.scope.infrastructureInventories.dataStores.evidenceReceipts = [
      inventoryReceipt("TN-DATA-STORE-ABSENCE-2026-001", "data_stores", "absence_attestation")
    ];
    invalid.scope.infrastructureInventories.backupsAndRecoveryCopies.status = "none_verified";
    invalid.scope.infrastructureInventories.backupsAndRecoveryCopies.evidenceReceipts = [
      inventoryReceipt("TN-BACKUP-ABSENCE-2026-001", "backups_and_recovery_copies", "absence_attestation")
    ];
    invalid.scope.infrastructureInventories.dataStores.evidenceReceipts[0]!.reference = "HOST-DB.INTERNAL";
    (invalid.scope.infrastructureInventories.dataStores as unknown as Record<string, unknown>).rawTopology = "db.internal";
    const result = verifyPciScopeDecision(invalid, provisionalOptions);
    assert.ok(result.issues.includes("scope decision accountableParties assessedEntityReference must be non-blank"));
    assert.ok(result.issues.includes("scope decision accountableParties applicationOperatorReference must be an opaque controlled reference ID"));
    assert.ok(result.issues.includes("scope decision dataStores inventory evidence receipt 1 reference must be an opaque controlled reference ID"));
    assert.ok(result.issues.includes("scope decision dataStores inventory contains unsupported field: rawTopology"));
    assert.ok(result.issues.some((issue) => issue.startsWith("scope decision administrativeAndSupportPaths inventory must be present")));
    assert.ok(result.issues.some((issue) => issue.startsWith("scope decision networkAndManagementPaths inventory must be present")));
    assert.ok(result.issues.some((issue) => issue.startsWith("scope decision dataStores inventory must be present")));
    assert.ok(result.issues.some((issue) => issue.startsWith("scope decision backupsAndRecoveryCopies inventory must be present")));

    const malformedReceipt = provisionalDecision();
    malformedReceipt.scope.infrastructureInventories.administrativeAndSupportPaths.evidenceReceipts = [];
    malformedReceipt.scope.infrastructureInventories.backupsAndRecoveryCopies.evidenceReceipts[0]!.sha256 = "not-a-hash";
    malformedReceipt.scope.infrastructureInventories.backupsAndRecoveryCopies.evidenceReceipts[0]!.artifactType = "absence_attestation";
    malformedReceipt.scope.infrastructureInventories.backupsAndRecoveryCopies.evidenceReceipts[0]!.reviewerPrincipalId =
      malformedReceipt.preparedByPrincipalId;
    malformedReceipt.scope.infrastructureInventories.backupsAndRecoveryCopies.evidenceReceipts[0]!.reviewedAt =
      "2026-07-17T16:00:00.000Z";
    const malformedResult = verifyPciScopeDecision(malformedReceipt, provisionalOptions);
    assert.ok(malformedResult.issues.includes("scope decision administrativeAndSupportPaths inventory evidenceReceipts must not be empty"));
    assert.ok(malformedResult.issues.includes("scope decision administrativeAndSupportPaths inventory status present requires an inventory evidence receipt"));
    assert.ok(malformedResult.issues.includes("scope decision backupsAndRecoveryCopies inventory evidence receipt 1 sha256 must be a 64-character hexadecimal digest"));
    assert.ok(malformedResult.issues.includes("scope decision backupsAndRecoveryCopies inventory status present requires an inventory evidence receipt"));
    assert.ok(malformedResult.issues.includes("scope decision backupsAndRecoveryCopies inventory evidence receipt 1 reviewerPrincipalId must differ from the scope-record preparer"));
    assert.ok(malformedResult.issues.includes("scope decision backupsAndRecoveryCopies inventory evidence receipt 1 reviewedAt must not be in the future"));
    assert.ok(malformedResult.issues.includes("scope decision backupsAndRecoveryCopies inventory evidence receipt 1 reviewedAt must not follow the scope decisionDate"));

    const mismatchedReceipt = provisionalDecision();
    const receipt = mismatchedReceipt.scope.infrastructureInventories.administrativeAndSupportPaths.evidenceReceipts[0]!;
    receipt.inventoryCategory = "data_stores";
    receipt.environmentReference = "TN-TEST-ENVIRONMENT-2026-999";
    receipt.architectureReleaseReference = "TN-ARCH-RELEASE-2026-999";
    receipt.reviewedAt = "2026-01-01T16:00:00.000Z";
    const mismatchedResult = verifyPciScopeDecision(mismatchedReceipt, provisionalOptions);
    assert.ok(mismatchedResult.issues.includes("scope decision administrativeAndSupportPaths inventory evidence receipt 1 inventoryCategory must equal administrative_and_support_paths"));
    assert.ok(mismatchedResult.issues.includes("scope decision administrativeAndSupportPaths inventory evidence receipt 1 environmentReference must match syntheticTestAuthorization environmentReference"));
    assert.ok(mismatchedResult.issues.includes("scope decision administrativeAndSupportPaths inventory evidence receipt 1 architectureReleaseReference must match evidence architectureReleaseReference"));
    assert.ok(mismatchedResult.issues.includes("scope decision administrativeAndSupportPaths inventory evidence receipt 1 reviewedAt must be within 90 days of the scope decisionDate"));
  });

  it("rejects repository-unsafe inventory rationale content", () => {
    const unsafeCases = [
      ["The reviewed recovery target DB.INTERNAL contained a repository-unsafe hostname value.", "hostname-like value"],
      ["The reviewed recovery target used 10.0.0.1 and exposed a repository-unsafe IPv4 value.", "IPv4 address"],
      ["The reviewed recovery target used IP=10.0.0.1 and exposed an assigned IPv4 value.", "IPv4 address"],
      ["The reviewed recovery target used 10.0.0.1:5432 and exposed an IPv4 endpoint value.", "IPv4 address"],
      ["The reviewed recovery target used 2001:0DB8:0000:0000:0000:0000:0000:0001 and exposed an IPv6 value.", "IPv6 address"],
      ["The reviewed recovery target used 2001:db8::1 and exposed a compressed IPv6 value.", "IPv6 address"],
      ["The reviewed recovery endpoint was [2001:db8::1]:443 and exposed a bracketed IPv6 endpoint.", "IPv6 address"],
      ["The reviewed recovery target used address=2001:db8::1 and exposed an assigned IPv6 value.", "IPv6 address"],
      ["The reviewed recovery record was retained at https://evidence.example.invalid/receipt and exposed a URL.", "URL"],
      ["The reviewed recovery target used postgres://db-prod-01/application and exposed a database URI.", "URL"],
      ["The reviewed recovery target used ssh://db-prod-01 and exposed a remote-service URI.", "URL"],
      ["The reviewed recovery contact was operator@example.invalid and exposed an email address.", "email address"],
      ["The reviewed recovery target included account id=ABC123 and exposed an account identifier.", "account identifier"],
      ["The reviewed recovery target included token=ABC123 and exposed a credential-like assignment.", "credential-like assignment"],
      ["The reviewed recovery target used DB-PROD-01 and exposed a single-label host value.", "single-label hostname-like value"],
      ["The reviewed recovery target used IP-10-0-0-1 and exposed an encoded address value.", "hyphen-encoded IP address"]
    ] as const;
    for (const [rationale, reason] of unsafeCases) {
      const invalid = provisionalDecision();
      invalid.scope.infrastructureInventories.backupsAndRecoveryCopies.rationale = rationale;
      const result = verifyPciScopeDecision(invalid, provisionalOptions);
      assert.ok(
        result.issues.includes(`scope decision backupsAndRecoveryCopies inventory rationale must not contain a repository-unsafe ${reason}`),
        `${reason} should be rejected`
      );
    }
  });

  it("rejects standalone or mutated final records and requires exact trace coverage", () => {
    const provisional = provisionalDecision();
    const standalone = verifyPciScopeDecision(finalDecision(provisional), { now: finalOptions(provisional).now });
    assert.ok(standalone.issues.includes("final scope acceptance requires the linked provisional record input"));

    const changed = finalDecision(provisional);
    changed.syntheticTestAuthorization.environmentReference = "TN-OTHER-ENVIRONMENT-2026-001";
    changed.syntheticTestAuthorization.traceFlowIds.pop();
    changed.scope.flowDecisions[0]!.decision = "excluded";
    changed.scope.accountableParties.applicationOperatorReference = "TN-APPLICATION-OPERATOR-2026-002";
    changed.scope.infrastructureInventories.dataStores.evidenceReceipts = [
      inventoryReceipt("TN-DATA-STORE-INVENTORY-2026-002", "data_stores")
    ];
    const result = verifyPciScopeDecision(changed, finalOptions(provisional));
    assert.ok(result.issues.includes("final scope acceptance must preserve provisional scope"));
    assert.ok(result.issues.includes("final scope acceptance must preserve provisional syntheticTestAuthorization environmentReference"));
    assert.ok(result.issues.includes("final scope acceptance requires traceFlowIds to exactly match authorizedFlowIds"));

    const alteredReceipt = traceReceipt(provisional);
    alteredReceipt.flowIds.pop();
    alteredReceipt.receiptId = "x";
    const alteredReceiptResult = verifyPciScopeDecision(
      finalDecision(provisional),
      finalOptions(provisional, "2026-07-18T00:00:00.000Z", alteredReceipt)
    );
    assert.ok(alteredReceiptResult.issues.includes("final scope acceptance traceReceiptSha256 does not match the supplied trace receipt"));
    assert.ok(alteredReceiptResult.issues.includes("synthetic trace receipt receiptId must match TN-SYNTHETIC-TRACE-YYYY-NNN"));
    assert.ok(alteredReceiptResult.issues.includes("synthetic trace receipt flowIds must exactly match traceFlowIds"));

    const staleFinal = finalDecision(provisional);
    staleFinal.decisionDate = "2026-11-01";
    staleFinal.signoffs[0]!.decidedAt = "2026-11-01T17:00:00.000Z";
    staleFinal.signoffs[1]!.decidedAt = "2026-11-01T18:00:00.000Z";
    const staleFinalResult = verifyPciScopeDecision(
      staleFinal,
      finalOptions(provisional, "2026-11-02T00:00:00.000Z")
    );
    assert.ok(staleFinalResult.issues.some((issue) => issue.includes("reviewedAt must be within 90 days of the scope decisionDate")));
  });

  it("rejects overlong authorization, invalid chronology, and reused signoff identity evidence", () => {
    const invalid = provisionalDecision();
    invalid.syntheticTestAuthorization.expiresAt = "2026-09-01T18:30:00.000Z";
    invalid.syntheticTestAuthorization.issuedAt = "2026-07-16T16:30:00.000Z";
    invalid.signoffs[1]!.principalId = invalid.signoffs[0]!.principalId;
    invalid.signoffs[1]!.evidenceReference = ` ${invalid.signoffs[0]!.evidenceReference} `;
    const result = verifyPciScopeDecision(invalid, provisionalOptions);
    assert.ok(result.issues.includes("scope decision syntheticTestAuthorization authorization window must not exceed 30 days"));
    assert.ok(result.issues.includes("scope decision signoff 1 decidedAt must not follow authorization issuedAt"));
    assert.ok(result.issues.includes("scope decision signoff principal IDs must be distinct"));
    assert.ok(result.issues.includes("scope decision signoff evidence references must be distinct"));

    const provisional = provisionalDecision();
    const backdated = finalDecision(provisional);
    backdated.decisionDate = "2026-07-15";
    backdated.signoffs[0]!.evidenceReference = provisional.signoffs[0]!.evidenceReference;
    backdated.signoffs[1]!.evidenceReference = provisional.signoffs[1]!.evidenceReference;
    const backdatedResult = verifyPciScopeDecision(backdated, finalOptions(provisional));
    assert.ok(backdatedResult.issues.includes("final scope acceptance decisionDate must not precede the provisional decisionDate"));
    assert.ok(backdatedResult.issues.includes("final scope acceptance decisionDate must not precede trace completion"));
    assert.ok(backdatedResult.issues.includes("final scope acceptance approval artifacts must differ from provisional authorization artifacts"));

    const lateReceipt = traceReceipt(provisional);
    lateReceipt.reviewedAt = "2026-07-18T12:00:00.000Z";
    const approvedBeforeReceiptReview = finalDecision(provisional, lateReceipt);
    const lateReviewResult = verifyPciScopeDecision(
      approvedBeforeReceiptReview,
      finalOptions(provisional, "2026-07-19T00:00:00.000Z", lateReceipt)
    );
    assert.ok(lateReviewResult.issues.includes("final scope acceptance decisionDate must not precede trace receipt review"));
    assert.ok(lateReviewResult.issues.includes("scope decision signoff 1 decidedAt must not precede trace receipt review"));
    assert.ok(lateReviewResult.issues.includes("scope decision signoff 2 decidedAt must not precede trace receipt review"));

    const contradictory = provisionalDecision();
    contradictory.scope.cdeRelationship = "no_cde_impact";
    contradictory.scope.validationPath = "out_of_scope_determination";
    contradictory.scope.canImpactCdeSecurity = false;
    contradictory.segmentation.reliedUpon = true;
    const contradictoryResult = verifyPciScopeDecision(contradictory, provisionalOptions);
    assert.ok(contradictoryResult.issues.includes("no_cde_impact requires empty inScopeComponents"));
    assert.ok(contradictoryResult.issues.includes("no_cde_impact cannot rely on segmentation; use segmented_out for that decision"));
  });

  it("enforces CLI stage intent and exact final input files end to end", () => {
    const directory = mkdtempSync(join(tmpdir(), "truenote-pci-scope-"));
    try {
      const provisional = provisionalDecision();
      provisional.decisionDate = "2026-07-14";
      provisional.syntheticTestAuthorization.issuedAt = "2026-07-14T18:30:00.000Z";
      provisional.signoffs[0]!.decidedAt = "2026-07-14T17:00:00.000Z";
      provisional.signoffs[1]!.decidedAt = "2026-07-14T18:00:00.000Z";
      for (const inventory of Object.values(provisional.scope.infrastructureInventories)) {
        for (const evidenceReceipt of inventory.evidenceReceipts) {
          evidenceReceipt.reviewedAt = "2026-07-14T16:00:00.000Z";
        }
      }
      const receipt = traceReceipt(provisional);
      receipt.startedAt = "2026-07-15T19:00:00.000Z";
      receipt.completedAt = "2026-07-15T20:00:00.000Z";
      receipt.reviewedAt = "2026-07-15T21:00:00.000Z";
      const provisionalText = `${JSON.stringify(provisional, null, 2)}\n`;
      receipt.provisionalRecordSha256 = createHash("sha256").update(provisionalText).digest("hex").toUpperCase();
      const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
      const final = finalDecision(provisional, receipt);
      final.decisionDate = "2026-07-15";
      final.signoffs[0]!.decidedAt = "2026-07-15T22:00:00.000Z";
      final.signoffs[1]!.decidedAt = "2026-07-15T23:00:00.000Z";
      final.provisionalRecordSha256 = createHash("sha256").update(provisionalText).digest("hex").toUpperCase();
      final.syntheticTestAuthorization.traceReceiptSha256 = createHash("sha256").update(receiptText).digest("hex").toUpperCase();
      const provisionalPath = join(directory, "provisional.json");
      const finalPath = join(directory, "final.json");
      const receiptPath = join(directory, "receipt.json");
      const duplicateDecisionPath = join(directory, "duplicate-decision.json");
      const duplicateProvisionalPath = join(directory, "duplicate-provisional.json");
      const duplicateReceiptPath = join(directory, "duplicate-receipt.json");
      writeFileSync(provisionalPath, provisionalText, "utf8");
      writeFileSync(finalPath, `${JSON.stringify(final, null, 2)}\n`, "utf8");
      writeFileSync(receiptPath, receiptText, "utf8");
      writeFileSync(
        duplicateDecisionPath,
        provisionalText.replace(
          '"decisionStage": "provisional_test_authorization",',
          '"decisionStage": "provisional_test_authorization",\n  "decisionStage": "final_scope_acceptance",'
        ),
        "utf8"
      );
      writeFileSync(
        duplicateProvisionalPath,
        provisionalText.replace(
          '"recordId": "TN-PCI-SCOPE-2026-001",',
          '"recordId": "TN-PCI-SCOPE-2026-001",\n  "recordId": "TN-PCI-SCOPE-2026-999",'
        ),
        "utf8"
      );
      writeFileSync(
        duplicateReceiptPath,
        receiptText.replace(
          '"result": "passed",',
          '"result": "failed",\n  "result": "passed",'
        ),
        "utf8"
      );
      const cli = fileURLToPath(new URL("./verify-pci-scope-decision.ts", import.meta.url));
      const run = (...args: string[]) => spawnSync(
        process.execPath,
        ["--import", "tsx", cli, ...args],
        { cwd: process.cwd(), encoding: "utf8" }
      );

      const provisionalResult = run(
        provisionalPath,
        "--require-stage",
        "provisional_test_authorization"
      );
      assert.equal(provisionalResult.status, 0, provisionalResult.stderr);
      assert.match(provisionalResult.stdout, /structurallyFinalAccepted=false/);

      const finalResult = run(
        finalPath,
        "--require-stage",
        "final_scope_acceptance",
        "--provisional",
        provisionalPath,
        "--trace-receipt",
        receiptPath
      );
      assert.equal(finalResult.status, 0, finalResult.stderr);
      assert.match(finalResult.stdout, /structurallyFinalAccepted=true/);

      assert.equal(run(provisionalPath).status, 2);
      assert.equal(run(finalPath, "--require-stage", "final_scope_acceptance").status, 2);
      assert.equal(run(provisionalPath, "--require-stage", "final_scope_acceptance", "--provisional", provisionalPath, "--trace-receipt", receiptPath).status, 1);
      assert.equal(run(provisionalPath, "--require-stage", "provisional_test_authorization", "--unknown").status, 2);
      const duplicateDecisionResult = run(duplicateDecisionPath, "--require-stage", "provisional_test_authorization");
      assert.equal(duplicateDecisionResult.status, 1);
      assert.match(duplicateDecisionResult.stderr, /duplicate JSON key: decisionStage/);
      const duplicateProvisionalResult = run(finalPath, "--require-stage", "final_scope_acceptance", "--provisional", duplicateProvisionalPath, "--trace-receipt", receiptPath);
      assert.equal(duplicateProvisionalResult.status, 1);
      assert.match(duplicateProvisionalResult.stderr, /duplicate JSON key: recordId/);
      const duplicateReceiptResult = run(finalPath, "--require-stage", "final_scope_acceptance", "--provisional", provisionalPath, "--trace-receipt", duplicateReceiptPath);
      assert.equal(duplicateReceiptResult.status, 1);
      assert.match(duplicateReceiptResult.stderr, /duplicate JSON key: result/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
