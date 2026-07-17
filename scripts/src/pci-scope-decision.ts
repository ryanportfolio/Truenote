import { createHash } from "node:crypto";
import { isIP } from "node:net";

export const PCI_SCOPE_PROVIDER_IDS = [
  "application_hosting",
  "database",
  "object_storage",
  "source_and_ci",
  "model_gateway",
  "embeddings",
  "reranking",
  "document_parsing",
  "malware_scanning",
  "email",
  "identity_provider",
  "siem"
] as const;

export const PCI_SCOPE_REQUIREMENT_IDS = ["6.4.2", "6.4.3", "11.4"] as const;

export const PCI_SCOPE_FLOW_IDS = [
  "TN-FLOW-01",
  "TN-FLOW-02",
  "TN-FLOW-03",
  "TN-FLOW-04",
  "TN-FLOW-05"
] as const;

export const PCI_SCOPE_COMPONENT_IDS = [
  "public_frontend",
  "application_api",
  "background_worker",
  "administrative_access",
  "deployment_pipeline",
  "database",
  "object_storage",
  "identity_integration",
  "security_monitoring",
  "email_delivery",
  "public_documentation",
  "backups_and_recovery"
] as const;

export const PCI_SCOPE_CONNECTED_SYSTEM_IDS = [
  "cde_identity_services",
  "cde_network_services",
  "cde_security_monitoring",
  "cde_change_management"
] as const;

export interface PciScopeDecisionVerification {
  issues: string[];
  structurallyAccepted: boolean;
  structurallyFinalAccepted: boolean;
  stage: string | null;
}

export interface PciScopeDecisionVerificationOptions {
  now: Date;
  provisionalRecordBytes?: Uint8Array;
  traceReceiptBytes?: Uint8Array;
}

const ROOT_KEYS = new Set([
  "schemaVersion",
  "recordId",
  "decisionDate",
  "decisionStage",
  "supersedesRecordId",
  "provisionalRecordSha256",
  "preparedBy",
  "preparedByPrincipalId",
  "scope",
  "panPolicy",
  "segmentation",
  "providers",
  "requirements",
  "evidence",
  "syntheticTestAuthorization",
  "unresolvedQuestions",
  "decision",
  "signoffs"
]);
const SCOPE_KEYS = new Set([
  "cdeRelationship",
  "validationPath",
  "canImpactCdeSecurity",
  "rationale",
  "accountableParties",
  "infrastructureInventories",
  "inScopeComponents",
  "outOfScopeComponents",
  "connectedSystems",
  "flowDecisions"
]);
const ACCOUNTABLE_PARTY_KEYS = new Set([
  "assessedEntityReference",
  "applicationOperatorReference",
  "customerCdeOwnerReference"
]);
const INFRASTRUCTURE_INVENTORY_KEYS = new Set([
  "administrativeAndSupportPaths",
  "networkAndManagementPaths",
  "dataStores",
  "backupsAndRecoveryCopies"
]);
const INVENTORY_DECISION_KEYS = new Set(["status", "rationale", "evidenceReceipts"]);
const INVENTORY_RECEIPT_KEYS = new Set([
  "reference",
  "sha256",
  "artifactType",
  "inventoryCategory",
  "environmentReference",
  "architectureReleaseReference",
  "reviewerPrincipalId",
  "reviewedAt"
]);
const FLOW_DECISION_KEYS = new Set(["id", "decision", "rationale", "evidenceReference"]);
const PAN_KEYS = new Set(["policy", "allowedPaths", "prohibitedPaths", "enforcementReferences"]);
const SEGMENTATION_KEYS = new Set([
  "reliedUpon",
  "boundaries",
  "controlReference",
  "testApplicability",
  "testPlanReference"
]);
const PROVIDER_KEYS = new Set(["id", "name", "decision", "rationale", "responsibilityReference"]);
const REQUIREMENT_KEYS = new Set(["id", "applicability", "rationale", "controlPlanReference"]);
const EVIDENCE_KEYS = new Set([
  "dataFlowReference",
  "scopeInventoryReference",
  "syntheticTraceReference",
  "architectureReleaseReference",
  "qsaOrAssessorDirectionReference"
]);
const TEST_AUTHORIZATION_KEYS = new Set([
  "status",
  "environmentReference",
  "testAccountReference",
  "authorizedFlowIds",
  "syntheticDataOnly",
  "panProhibited",
  "destructiveTestingProhibited",
  "authorizationReference",
  "issuedAt",
  "expiresAt",
  "traceFlowIds",
  "traceReceiptReference",
  "traceReceiptSha256",
  "startedAt",
  "completedAt"
]);
const SIGNOFF_KEYS = new Set(["role", "identity", "principalId", "decision", "decidedAt", "evidenceReference"]);
const TRACE_RECEIPT_KEYS = new Set([
  "schemaVersion",
  "receiptId",
  "provisionalRecordId",
  "provisionalRecordSha256",
  "authorizationReference",
  "environmentReference",
  "testAccountReference",
  "flowIds",
  "startedAt",
  "completedAt",
  "result",
  "coverageGaps",
  "operatorPrincipalId",
  "reviewerPrincipalId",
  "reviewedAt",
  "restrictedArtifactReference"
]);
const PLACEHOLDER = /<[^>]+>|\b(?:tbd|todo|pending|unassigned|unknown|placeholder|n\/a|not yet determined)\b/i;
const SHA256 = /^[A-Fa-f0-9]{64}$/;
const PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{2,127}$/;
const CONTROLLED_REFERENCE = /^[A-Z][A-Z0-9]{1,15}-[A-Z0-9][A-Z0-9-]{1,127}$/;
const MAX_AUTHORIZATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_INVENTORY_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function identity(value: unknown): string | null {
  return nonBlank(value) ? value.trim().toLowerCase() : null;
}

function dateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function unsupported(value: Record<string, unknown>, allowed: Set<string>, label: string, issues: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${label} contains unsupported field: ${key}`);
}

function requireRecord(value: unknown, label: string, issues: string[]): Record<string, unknown> {
  const parsed = record(value);
  if (!parsed) issues.push(`${label} must be an object`);
  return parsed ?? {};
}

function requireText(value: unknown, label: string, issues: string[]): value is string {
  if (!nonBlank(value)) {
    issues.push(`${label} must be non-blank`);
    return false;
  }
  if (PLACEHOLDER.test(value)) {
    issues.push(`${label} must not contain placeholder text`);
    return false;
  }
  return true;
}

function requirePrincipalId(value: unknown, label: string, issues: string[]): value is string {
  if (!requireText(value, label, issues)) return false;
  if (!PRINCIPAL_ID.test(value)) {
    issues.push(`${label} must be a stable principal identifier`);
    return false;
  }
  return true;
}

function requireControlledReference(
  value: unknown,
  label: string,
  issues: string[],
  allowedPrefixes: readonly string[] = []
): value is string {
  if (!requireText(value, label, issues)) return false;
  if (
    !CONTROLLED_REFERENCE.test(value) ||
    (allowedPrefixes.length > 0 && !allowedPrefixes.some((prefix) => value.startsWith(prefix)))
  ) {
    issues.push(`${label} must be an opaque controlled reference ID`);
    return false;
  }
  return true;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableValue).sort().join(",")}]`;
  }
  const parsed = record(value);
  if (parsed) {
    return `{${Object.keys(parsed).sort().map((key) => `${JSON.stringify(key)}:${stableValue(parsed[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parsePciJsonText(text: string): unknown {
  let index = 0;
  const whitespace = /\s/;
  const skipWhitespace = (): void => {
    while (index < text.length && whitespace.test(text[index]!)) index += 1;
  };
  const scanString = (): string => {
    const start = index;
    if (text[index] !== '"') throw new Error(`expected JSON string at offset ${index}`);
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
      } else if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index)) as string;
      } else {
        index += 1;
      }
    }
    throw new Error(`unterminated JSON string at offset ${start}`);
  };
  const scanValue = (): void => {
    skipWhitespace();
    const token = text[index];
    if (token === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        skipWhitespace();
        const key = scanString();
        if (keys.has(key)) throw new Error(`duplicate JSON key: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") throw new Error(`expected JSON colon at offset ${index}`);
        index += 1;
        scanValue();
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new Error(`expected JSON object separator at offset ${index}`);
        index += 1;
      }
      throw new Error("unterminated JSON object");
    }
    if (token === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        scanValue();
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new Error(`expected JSON array separator at offset ${index}`);
        index += 1;
      }
      throw new Error("unterminated JSON array");
    }
    if (token === '"') {
      scanString();
      return;
    }
    const start = index;
    while (index < text.length && !/[\s,}\]]/.test(text[index]!)) index += 1;
    if (index === start) throw new Error(`expected JSON value at offset ${index}`);
  };
  scanValue();
  skipWhitespace();
  if (index !== text.length) throw new Error(`unexpected JSON content at offset ${index}`);
  return JSON.parse(text) as unknown;
}

function parseJsonBytes(
  bytes: Uint8Array,
  label: string,
  issues: string[]
): { input: unknown; sha256: string } | null {
  try {
    return {
      input: parsePciJsonText(Buffer.from(bytes).toString("utf8")),
      sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase()
    };
  } catch (error) {
    issues.push(`${label} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function stringList(value: unknown, label: string, issues: string[], allowEmpty = false): string[] {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
    return [];
  }
  if (!allowEmpty && value.length === 0) issues.push(`${label} must not be empty`);
  if (value.some((item) => !nonBlank(item) || PLACEHOLDER.test(item))) {
    issues.push(`${label} must contain only non-placeholder strings`);
  }
  return value.filter((item): item is string => nonBlank(item));
}

function canonicalStringList(
  value: unknown,
  allowed: readonly string[],
  label: string,
  issues: string[],
  allowEmpty = false
): string[] {
  const values = stringList(value, label, issues, allowEmpty);
  const seen = new Set<string>();
  for (const item of values) {
    if (!allowed.includes(item)) issues.push(`${label} contains unsupported ID: ${item}`);
    if (seen.has(item)) issues.push(`${label} contains duplicate ID: ${item}`);
    seen.add(item);
  }
  return values;
}

function repositoryUnsafeReason(value: string): string | null {
  if (/\b[A-Z][A-Z0-9+.-]*:\/\//i.test(value) || /www\./i.test(value)) return "URL";
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) return "email address";
  const ipv4Candidates = value.match(/(?:\d{1,3}\.){3}\d{1,3}/g) ?? [];
  if (ipv4Candidates.some((candidate) => isIP(candidate) === 4)) return "IPv4 address";
  const ipv6Candidates = value.match(/[0-9A-F]*(?::[0-9A-F]*){2,}/gi) ?? [];
  if (ipv6Candidates.some((candidate) => isIP(candidate) === 6)) return "IPv6 address";
  if (/\b(?:IP-)?(?:\d{1,3}-){3}\d{1,3}\b/i.test(value)) return "hyphen-encoded IP address";
  if (/(?:password|secret|token|api[-_ ]?key|credential)\s*[:=]\s*\S+/i.test(value)) return "credential-like assignment";
  if (/(?:account|tenant|subscription|project)[-_ ]?(?:id|number)\s*[:=]\s*[A-Z0-9_-]+/i.test(value)) {
    return "account identifier";
  }
  if (/\b\d{12}\b/.test(value)) return "12-digit account identifier";
  const dottedTokens = value.match(/\b[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b/gi) ?? [];
  if (dottedTokens.some((token) => /[A-Z]/i.test(token))) return "hostname-like value";
  if (/\b(?:DB|APP|API|WEB|HOST|SERVER|NODE|PROD|STAGE|STAGING|DEV)-[A-Z0-9-]*[A-Z0-9]\b/i.test(value)) {
    return "single-label hostname-like value";
  }
  return null;
}

function requireRepositorySafeRationale(value: unknown, label: string, issues: string[]): value is string {
  if (!requireText(value, label, issues)) return false;
  if (value.trim().length < 30 || /^(?:none|no|not present|absent)$/i.test(value.trim())) {
    issues.push(`${label} must contain a substantive review rationale`);
    return false;
  }
  const unsafeReason = repositoryUnsafeReason(value);
  if (unsafeReason) {
    issues.push(`${label} must not contain a repository-unsafe ${unsafeReason}`);
    return false;
  }
  return true;
}

interface InventoryVerificationContext {
  now: Date;
  decisionDate: unknown;
  preparerPrincipalId: unknown;
  category: string;
  evidenceReferencePrefix: string;
  environmentReference: unknown;
  architectureReleaseReference: unknown;
}

function verifyInventoryDecision(
  value: unknown,
  label: string,
  issues: string[],
  context: InventoryVerificationContext
): Record<string, unknown> {
  const inventory = requireRecord(value, label, issues);
  unsupported(inventory, INVENTORY_DECISION_KEYS, label, issues);
  const status = String(inventory.status);
  if (!new Set(["present", "none_verified"]).has(status)) {
    issues.push(`${label} status must be present or none_verified`);
  }
  requireRepositorySafeRationale(inventory.rationale, `${label} rationale`, issues);

  const receipts = Array.isArray(inventory.evidenceReceipts) ? inventory.evidenceReceipts : [];
  if (!Array.isArray(inventory.evidenceReceipts)) issues.push(`${label} evidenceReceipts must be an array`);
  if (receipts.length === 0) issues.push(`${label} evidenceReceipts must not be empty`);
  const seenReferences = new Set<string>();
  const seenHashes = new Set<string>();
  let hasInventoryReceipt = false;
  let hasAbsenceAttestation = false;
  for (const [index, value] of receipts.entries()) {
    const receiptLabel = `${label} evidence receipt ${index + 1}`;
    const receipt = requireRecord(value, receiptLabel, issues);
    unsupported(receipt, INVENTORY_RECEIPT_KEYS, receiptLabel, issues);
    if (requireControlledReference(
      receipt.reference,
      `${receiptLabel} reference`,
      issues,
      [context.evidenceReferencePrefix]
    )) {
      const normalized = receipt.reference.trim().toUpperCase();
      if (seenReferences.has(normalized)) issues.push(`${label} evidence receipt references must be distinct`);
      seenReferences.add(normalized);
    }
    if (!nonBlank(receipt.sha256) || !SHA256.test(receipt.sha256)) {
      issues.push(`${receiptLabel} sha256 must be a 64-character hexadecimal digest`);
    } else {
      const normalized = receipt.sha256.toUpperCase();
      if (seenHashes.has(normalized)) issues.push(`${label} evidence receipt hashes must be distinct`);
      seenHashes.add(normalized);
    }
    if (!new Set(["inventory", "absence_attestation"]).has(String(receipt.artifactType))) {
      issues.push(`${receiptLabel} artifactType must be inventory or absence_attestation`);
    }
    if (receipt.artifactType === "inventory") hasInventoryReceipt = true;
    if (receipt.artifactType === "absence_attestation") hasAbsenceAttestation = true;
    if (receipt.inventoryCategory !== context.category) {
      issues.push(`${receiptLabel} inventoryCategory must equal ${context.category}`);
    }
    if (requireControlledReference(
      receipt.environmentReference,
      `${receiptLabel} environmentReference`,
      issues,
      ["TN-TEST-ENVIRONMENT-"]
    ) && receipt.environmentReference !== context.environmentReference) {
      issues.push(`${receiptLabel} environmentReference must match syntheticTestAuthorization environmentReference`);
    }
    if (requireControlledReference(
      receipt.architectureReleaseReference,
      `${receiptLabel} architectureReleaseReference`,
      issues,
      ["TN-ARCH-RELEASE-"]
    ) && receipt.architectureReleaseReference !== context.architectureReleaseReference) {
      issues.push(`${receiptLabel} architectureReleaseReference must match evidence architectureReleaseReference`);
    }
    if (
      requirePrincipalId(receipt.reviewerPrincipalId, `${receiptLabel} reviewerPrincipalId`, issues) &&
      identity(receipt.reviewerPrincipalId) === identity(context.preparerPrincipalId)
    ) {
      issues.push(`${receiptLabel} reviewerPrincipalId must differ from the scope-record preparer`);
    }
    if (!timestamp(receipt.reviewedAt)) {
      issues.push(`${receiptLabel} reviewedAt must be a canonical UTC ISO timestamp`);
    } else {
      if (receipt.reviewedAt > context.now.toISOString()) issues.push(`${receiptLabel} reviewedAt must not be in the future`);
      if (dateOnly(context.decisionDate) && receipt.reviewedAt.slice(0, 10) > context.decisionDate) {
        issues.push(`${receiptLabel} reviewedAt must not follow the scope decisionDate`);
      }
      if (dateOnly(context.decisionDate)) {
        const decisionEnd = Date.parse(`${context.decisionDate}T23:59:59.999Z`);
        if (decisionEnd - Date.parse(receipt.reviewedAt) > MAX_INVENTORY_AGE_MS) {
          issues.push(`${receiptLabel} reviewedAt must be within 90 days of the scope decisionDate`);
        }
      }
    }
  }
  if (status === "present" && !hasInventoryReceipt) {
    issues.push(`${label} status present requires an inventory evidence receipt`);
  }
  if (status === "none_verified" && !hasAbsenceAttestation) {
    issues.push(`${label} status none_verified requires an absence_attestation evidence receipt`);
  }
  return inventory;
}

export function verifyPciScopeDecision(
  input: unknown,
  options: PciScopeDecisionVerificationOptions
): PciScopeDecisionVerification {
  const issues: string[] = [];
  const root = record(input);
  if (!root) return {
    issues: ["PCI scope decision record must be an object"],
    structurallyAccepted: false,
    structurallyFinalAccepted: false,
    stage: null
  };
  unsupported(root, ROOT_KEYS, "scope decision", issues);
  if (root.schemaVersion !== 1) issues.push("scope decision schemaVersion must equal 1");
  const idMatch = nonBlank(root.recordId) ? /^TN-PCI-SCOPE-(\d{4})-(\d{3,})$/.exec(root.recordId) : null;
  if (!idMatch) issues.push("scope decision recordId must match TN-PCI-SCOPE-YYYY-NNN");
  if (!dateOnly(root.decisionDate)) {
    issues.push("scope decision decisionDate must be a real YYYY-MM-DD date");
  } else {
    if (idMatch && idMatch[1] !== root.decisionDate.slice(0, 4)) issues.push("scope decision recordId year must match decisionDate");
    const today = options.now.toISOString().slice(0, 10);
    if (root.decisionDate > today) issues.push("scope decision decisionDate must not be in the future");
  }
  if (root.supersedesRecordId !== null && (
    !nonBlank(root.supersedesRecordId) ||
    !/^TN-PCI-SCOPE-\d{4}-\d{3,}$/.test(root.supersedesRecordId) ||
    root.supersedesRecordId === root.recordId
  )) issues.push("scope decision supersedesRecordId must be null or a different valid scope record ID");
  requireText(root.preparedBy, "scope decision preparedBy", issues);
  requirePrincipalId(root.preparedByPrincipalId, "scope decision preparedByPrincipalId", issues);
  const stage = nonBlank(root.decisionStage) ? root.decisionStage : null;
  if (!new Set(["provisional_test_authorization", "final_scope_acceptance"]).has(String(stage))) {
    issues.push("scope decision decisionStage must be provisional_test_authorization or final_scope_acceptance");
  }
  const expectedDecision = stage === "provisional_test_authorization"
    ? "authorized_for_synthetic_testing"
    : stage === "final_scope_acceptance"
      ? "approved"
      : null;
  if (expectedDecision === null || root.decision !== expectedDecision) {
    issues.push(`scope decision decision must equal ${expectedDecision ?? "the value required by decisionStage"}`);
  }
  if (stage === "provisional_test_authorization") {
    if (root.provisionalRecordSha256 !== null) {
      issues.push("provisional scope authorization requires null provisionalRecordSha256");
    }
  } else if (stage === "final_scope_acceptance") {
    if (!nonBlank(root.supersedesRecordId)) {
      issues.push("final scope acceptance requires supersedesRecordId for the provisional record");
    }
    if (!nonBlank(root.provisionalRecordSha256) || !SHA256.test(root.provisionalRecordSha256)) {
      issues.push("final scope acceptance requires a valid provisionalRecordSha256");
    }
  }

  const scope = requireRecord(root.scope, "scope decision scope", issues);
  unsupported(scope, SCOPE_KEYS, "scope decision scope", issues);
  const relationship = String(scope.cdeRelationship);
  if (!new Set(["inside_cde", "connected_to_cde", "security_impacting", "segmented_out", "no_cde_impact"]).has(relationship)) {
    issues.push("scope decision cdeRelationship is invalid");
  }
  const validationPath = String(scope.validationPath);
  if (!new Set(["existing_cde_assessment", "separate_assessment", "out_of_scope_determination"]).has(validationPath)) {
    issues.push("scope decision validationPath is invalid");
  }
  if (typeof scope.canImpactCdeSecurity !== "boolean") issues.push("scope decision canImpactCdeSecurity must be boolean");
  requireText(scope.rationale, "scope decision scope rationale", issues);

  const accountableParties = requireRecord(
    scope.accountableParties,
    "scope decision accountableParties",
    issues
  );
  unsupported(accountableParties, ACCOUNTABLE_PARTY_KEYS, "scope decision accountableParties", issues);
  requireControlledReference(
    accountableParties.assessedEntityReference,
    "scope decision accountableParties assessedEntityReference",
    issues,
    ["TN-ASSESSMENT-ENTITY-"]
  );
  requireControlledReference(
    accountableParties.applicationOperatorReference,
    "scope decision accountableParties applicationOperatorReference",
    issues,
    ["TN-APPLICATION-OPERATOR-"]
  );
  requireControlledReference(
    accountableParties.customerCdeOwnerReference,
    "scope decision accountableParties customerCdeOwnerReference",
    issues,
    ["TN-CDE-OWNER-"]
  );

  const infrastructureInventories = requireRecord(
    scope.infrastructureInventories,
    "scope decision infrastructureInventories",
    issues
  );
  unsupported(
    infrastructureInventories,
    INFRASTRUCTURE_INVENTORY_KEYS,
    "scope decision infrastructureInventories",
    issues
  );
  const rootAuthorizationForInventory = record(root.syntheticTestAuthorization);
  const rootEvidenceForInventory = record(root.evidence);
  const inventoryContext = {
    now: options.now,
    decisionDate: root.decisionDate,
    preparerPrincipalId: root.preparedByPrincipalId,
    environmentReference: rootAuthorizationForInventory?.environmentReference,
    architectureReleaseReference: rootEvidenceForInventory?.architectureReleaseReference
  };
  const administrativeInventory = verifyInventoryDecision(
    infrastructureInventories.administrativeAndSupportPaths,
    "scope decision administrativeAndSupportPaths inventory",
    issues,
    {
      ...inventoryContext,
      category: "administrative_and_support_paths",
      evidenceReferencePrefix: "TN-ADMIN-PATH-"
    }
  );
  const networkInventory = verifyInventoryDecision(
    infrastructureInventories.networkAndManagementPaths,
    "scope decision networkAndManagementPaths inventory",
    issues,
    {
      ...inventoryContext,
      category: "network_and_management_paths",
      evidenceReferencePrefix: "TN-NETWORK-PATH-"
    }
  );
  const dataStoreInventory = verifyInventoryDecision(
    infrastructureInventories.dataStores,
    "scope decision dataStores inventory",
    issues,
    {
      ...inventoryContext,
      category: "data_stores",
      evidenceReferencePrefix: "TN-DATA-STORE-"
    }
  );
  const backupInventory = verifyInventoryDecision(
    infrastructureInventories.backupsAndRecoveryCopies,
    "scope decision backupsAndRecoveryCopies inventory",
    issues,
    {
      ...inventoryContext,
      category: "backups_and_recovery_copies",
      evidenceReferencePrefix: "TN-BACKUP-"
    }
  );

  const inScope = canonicalStringList(
    scope.inScopeComponents,
    PCI_SCOPE_COMPONENT_IDS,
    "scope decision inScopeComponents",
    issues,
    relationship === "no_cde_impact"
  );
  const outOfScope = canonicalStringList(
    scope.outOfScopeComponents,
    PCI_SCOPE_COMPONENT_IDS,
    "scope decision outOfScopeComponents",
    issues,
    true
  );
  const connectedSystems = canonicalStringList(
    scope.connectedSystems,
    PCI_SCOPE_CONNECTED_SYSTEM_IDS,
    "scope decision connectedSystems",
    issues,
    relationship === "no_cde_impact"
  );
  for (const componentId of inScope) {
    if (outOfScope.includes(componentId)) issues.push(`scope component cannot be both in scope and out of scope: ${componentId}`);
  }
  if (new Set(["inside_cde", "connected_to_cde", "security_impacting"]).has(relationship)) {
    if (scope.canImpactCdeSecurity !== true) issues.push("in-scope or security-impacting relationship requires canImpactCdeSecurity=true");
    if (inScope.length === 0) issues.push("in-scope or security-impacting relationship requires in-scope components");
  }
  if (relationship === "no_cde_impact") {
    if (scope.canImpactCdeSecurity !== false) issues.push("no_cde_impact requires canImpactCdeSecurity=false");
    if (validationPath !== "out_of_scope_determination") issues.push("no_cde_impact requires out_of_scope_determination validationPath");
    if (inScope.length > 0) issues.push("no_cde_impact requires empty inScopeComponents");
  }
  if (
    new Set(["inside_cde", "connected_to_cde", "security_impacting"]).has(relationship) &&
    validationPath === "out_of_scope_determination"
  ) {
    issues.push("in-scope, connected, or security-impacting relationships cannot use out_of_scope_determination");
  }

  const flowDecisions = Array.isArray(scope.flowDecisions) ? scope.flowDecisions : [];
  if (!Array.isArray(scope.flowDecisions)) issues.push("scope decision flowDecisions must be an array");
  const seenFlowDecisions = new Set<string>();
  const inScopeFlowIds: string[] = [];
  for (const [index, value] of flowDecisions.entries()) {
    const flow = requireRecord(value, `scope decision flow ${index + 1}`, issues);
    unsupported(flow, FLOW_DECISION_KEYS, `scope decision flow ${index + 1}`, issues);
    if (!PCI_SCOPE_FLOW_IDS.includes(flow.id as typeof PCI_SCOPE_FLOW_IDS[number])) {
      issues.push(`scope decision flow ${index + 1} has invalid id`);
    } else if (seenFlowDecisions.has(String(flow.id))) {
      issues.push(`duplicate scope decision flow id: ${String(flow.id)}`);
    } else {
      seenFlowDecisions.add(String(flow.id));
      if (flow.decision === "in_scope") inScopeFlowIds.push(String(flow.id));
    }
    if (!new Set(["in_scope", "excluded"]).has(String(flow.decision))) {
      issues.push(`scope decision flow ${index + 1} decision is invalid`);
    }
    requireText(flow.rationale, `scope decision flow ${index + 1} rationale`, issues);
    requireText(flow.evidenceReference, `scope decision flow ${index + 1} evidenceReference`, issues);
  }
  for (const id of PCI_SCOPE_FLOW_IDS) {
    if (!seenFlowDecisions.has(id)) issues.push(`missing scope decision flow: ${id}`);
  }
  if (inScopeFlowIds.length === 0) issues.push("scope decision requires at least one in-scope flow");

  const pan = requireRecord(root.panPolicy, "scope decision panPolicy", issues);
  unsupported(pan, PAN_KEYS, "scope decision panPolicy", issues);
  if (!new Set(["prohibited", "permitted_named_paths"]).has(String(pan.policy))) {
    issues.push("scope decision PAN policy must be prohibited or permitted_named_paths");
  }
  const allowedPaths = stringList(pan.allowedPaths, "scope decision PAN allowedPaths", issues, pan.policy === "prohibited");
  const prohibitedPaths = stringList(pan.prohibitedPaths, "scope decision PAN prohibitedPaths", issues);
  stringList(pan.enforcementReferences, "scope decision PAN enforcementReferences", issues);
  if (pan.policy === "prohibited" && allowedPaths.length > 0) issues.push("prohibited PAN policy requires empty allowedPaths");
  if (pan.policy === "permitted_named_paths" && allowedPaths.length === 0) issues.push("permitted PAN policy requires named allowedPaths");
  if (prohibitedPaths.length === 0) issues.push("PAN policy requires explicit prohibitedPaths");

  const segmentation = requireRecord(root.segmentation, "scope decision segmentation", issues);
  unsupported(segmentation, SEGMENTATION_KEYS, "scope decision segmentation", issues);
  if (typeof segmentation.reliedUpon !== "boolean") issues.push("scope decision segmentation reliedUpon must be boolean");
  const boundaries = stringList(segmentation.boundaries, "scope decision segmentation boundaries", issues, segmentation.reliedUpon === false);
  if (!new Set(["required", "not_required"]).has(String(segmentation.testApplicability))) {
    issues.push("scope decision segmentation testApplicability is invalid");
  }
  if (segmentation.reliedUpon === true || relationship === "segmented_out") {
    if (boundaries.length === 0) issues.push("segmentation reliance requires named boundaries");
    requireText(segmentation.controlReference, "scope decision segmentation controlReference", issues);
    requireText(segmentation.testPlanReference, "scope decision segmentation testPlanReference", issues);
    if (segmentation.testApplicability !== "required") issues.push("segmentation reliance requires Requirement 11.4 testing");
  } else {
    if (segmentation.controlReference !== null) {
      requireText(segmentation.controlReference, "scope decision segmentation controlReference", issues);
    }
    if (segmentation.testPlanReference !== null) {
      requireText(segmentation.testPlanReference, "scope decision segmentation testPlanReference", issues);
    }
  }
  if (relationship === "no_cde_impact" && segmentation.reliedUpon === true) {
    issues.push("no_cde_impact cannot rely on segmentation; use segmented_out for that decision");
  }

  const providers = Array.isArray(root.providers) ? root.providers : [];
  if (!Array.isArray(root.providers)) issues.push("scope decision providers must be an array");
  const providerIds = new Set<string>();
  const providerDecisionById = new Map<string, string>();
  for (const [index, value] of providers.entries()) {
    const provider = requireRecord(value, `scope decision provider ${index + 1}`, issues);
    unsupported(provider, PROVIDER_KEYS, `scope decision provider ${index + 1}`, issues);
    if (!PCI_SCOPE_PROVIDER_IDS.includes(provider.id as typeof PCI_SCOPE_PROVIDER_IDS[number])) {
      issues.push(`scope decision provider ${index + 1} has invalid id`);
    } else if (providerIds.has(String(provider.id))) {
      issues.push(`duplicate scope decision provider id: ${String(provider.id)}`);
    } else {
      providerIds.add(String(provider.id));
      providerDecisionById.set(String(provider.id), String(provider.decision));
    }
    requireText(provider.name, `scope decision provider ${index + 1} name`, issues);
    if (!new Set(["in_scope", "out_of_scope", "shared_responsibility"]).has(String(provider.decision))) {
      issues.push(`scope decision provider ${index + 1} decision is invalid`);
    }
    requireText(provider.rationale, `scope decision provider ${index + 1} rationale`, issues);
    requireText(provider.responsibilityReference, `scope decision provider ${index + 1} responsibilityReference`, issues);
  }
  for (const id of PCI_SCOPE_PROVIDER_IDS) if (!providerIds.has(id)) issues.push(`missing scope decision provider: ${id}`);

  const requirePresentInventory = (
    inventory: Record<string, unknown>,
    label: string,
    implicated: boolean,
    reason: string
  ): void => {
    if (implicated && inventory.status !== "present") {
      issues.push(`${label} must be present because ${reason}`);
    }
  };
  requirePresentInventory(
    administrativeInventory,
    "scope decision administrativeAndSupportPaths inventory",
    inScope.includes("administrative_access") ||
      inScope.includes("deployment_pipeline") ||
      providerDecisionById.get("source_and_ci") !== "out_of_scope",
    "administrative/deployment components or source_and_ci responsibility are included"
  );
  requirePresentInventory(
    networkInventory,
    "scope decision networkAndManagementPaths inventory",
    connectedSystems.length > 0 ||
      inScopeFlowIds.length > 0 ||
      [...providerDecisionById.values()].some((decision) => decision !== "out_of_scope"),
    "connected systems, in-scope flows, or provider responsibilities require network connectivity"
  );
  requirePresentInventory(
    dataStoreInventory,
    "scope decision dataStores inventory",
    inScope.includes("database") ||
      inScope.includes("object_storage") ||
      providerDecisionById.get("database") !== "out_of_scope" ||
      providerDecisionById.get("object_storage") !== "out_of_scope" ||
      inScopeFlowIds.length > 0,
    "data-store components, providers, or stable in-scope flows persist or retrieve data"
  );
  requirePresentInventory(
    backupInventory,
    "scope decision backupsAndRecoveryCopies inventory",
    inScope.includes("backups_and_recovery"),
    "backups_and_recovery is an in-scope component"
  );

  const requirements = Array.isArray(root.requirements) ? root.requirements : [];
  if (!Array.isArray(root.requirements)) issues.push("scope decision requirements must be an array");
  const requirementIds = new Set<string>();
  const requirementById = new Map<string, Record<string, unknown>>();
  for (const [index, value] of requirements.entries()) {
    const requirement = requireRecord(value, `scope decision requirement ${index + 1}`, issues);
    unsupported(requirement, REQUIREMENT_KEYS, `scope decision requirement ${index + 1}`, issues);
    if (!PCI_SCOPE_REQUIREMENT_IDS.includes(requirement.id as typeof PCI_SCOPE_REQUIREMENT_IDS[number])) {
      issues.push(`scope decision requirement ${index + 1} has invalid id`);
    } else if (requirementIds.has(String(requirement.id))) {
      issues.push(`duplicate scope decision requirement id: ${String(requirement.id)}`);
    } else {
      requirementIds.add(String(requirement.id));
      requirementById.set(String(requirement.id), requirement);
    }
    if (!new Set(["applicable", "not_applicable"]).has(String(requirement.applicability))) {
      issues.push(`scope decision requirement ${index + 1} applicability is invalid`);
    }
    requireText(requirement.rationale, `scope decision requirement ${index + 1} rationale`, issues);
    if (requirement.applicability === "applicable") {
      requireText(requirement.controlPlanReference, `scope decision requirement ${index + 1} controlPlanReference`, issues);
    } else if (requirement.controlPlanReference !== null) {
      issues.push(`not-applicable requirement ${String(requirement.id)} must have null controlPlanReference`);
    }
  }
  for (const id of PCI_SCOPE_REQUIREMENT_IDS) if (!requirementIds.has(id)) issues.push(`missing scope decision requirement: ${id}`);
  if ((segmentation.reliedUpon === true || relationship === "segmented_out") && requirementById.get("11.4")?.applicability !== "applicable") {
    issues.push("segmentation reliance requires Requirement 11.4 applicability=applicable");
  }

  const evidence = requireRecord(root.evidence, "scope decision evidence", issues);
  unsupported(evidence, EVIDENCE_KEYS, "scope decision evidence", issues);
  for (const key of EVIDENCE_KEYS) {
    if (key !== "syntheticTraceReference") {
      requireText(evidence[key], `scope decision evidence ${key}`, issues);
    }
  }
  if (stage === "provisional_test_authorization") {
    if (evidence.syntheticTraceReference !== null) {
      issues.push("provisional scope authorization requires null syntheticTraceReference");
    }
  } else if (stage === "final_scope_acceptance") {
    requireText(
      evidence.syntheticTraceReference,
      "scope decision evidence syntheticTraceReference",
      issues
    );
  }

  const testAuthorization = requireRecord(
    root.syntheticTestAuthorization,
    "scope decision syntheticTestAuthorization",
    issues
  );
  let traceReceiptReviewedAt: string | null = null;
  unsupported(
    testAuthorization,
    TEST_AUTHORIZATION_KEYS,
    "scope decision syntheticTestAuthorization",
    issues
  );
  const expectedAuthorizationStatus = stage === "provisional_test_authorization"
    ? "authorized"
    : stage === "final_scope_acceptance"
      ? "completed"
      : null;
  if (expectedAuthorizationStatus === null || testAuthorization.status !== expectedAuthorizationStatus) {
    issues.push(
      `scope decision syntheticTestAuthorization status must equal ${expectedAuthorizationStatus ?? "the value required by decisionStage"}`
    );
  }
  requireText(
    testAuthorization.environmentReference,
    "scope decision syntheticTestAuthorization environmentReference",
    issues
  );
  requireText(
    testAuthorization.testAccountReference,
    "scope decision syntheticTestAuthorization testAccountReference",
    issues
  );
  const authorizedFlowIds = stringList(
    testAuthorization.authorizedFlowIds,
    "scope decision syntheticTestAuthorization authorizedFlowIds",
    issues
  );
  const seenFlowIds = new Set<string>();
  for (const flowId of authorizedFlowIds) {
    if (!PCI_SCOPE_FLOW_IDS.includes(flowId as typeof PCI_SCOPE_FLOW_IDS[number])) {
      issues.push(`scope decision syntheticTestAuthorization has invalid flow id: ${flowId}`);
    } else if (seenFlowIds.has(flowId)) {
      issues.push(`duplicate scope decision syntheticTestAuthorization flow id: ${flowId}`);
    } else {
      seenFlowIds.add(flowId);
    }
  }
  if (!sameStringSet(authorizedFlowIds, inScopeFlowIds)) {
    issues.push("scope decision syntheticTestAuthorization authorizedFlowIds must exactly match in-scope flow decisions");
  }
  if (testAuthorization.syntheticDataOnly !== true) {
    issues.push("scope decision syntheticTestAuthorization requires syntheticDataOnly=true");
  }
  if (testAuthorization.panProhibited !== true) {
    issues.push("scope decision syntheticTestAuthorization requires panProhibited=true");
  }
  if (testAuthorization.destructiveTestingProhibited !== true) {
    issues.push("scope decision syntheticTestAuthorization requires destructiveTestingProhibited=true");
  }
  requireText(
    testAuthorization.authorizationReference,
    "scope decision syntheticTestAuthorization authorizationReference",
    issues
  );
  if (!timestamp(testAuthorization.issuedAt)) {
    issues.push("scope decision syntheticTestAuthorization issuedAt must be a canonical UTC ISO timestamp");
  } else if (
    Number.isFinite(options.now.valueOf()) &&
    Date.parse(testAuthorization.issuedAt) > options.now.valueOf()
  ) {
    issues.push("scope decision syntheticTestAuthorization issuedAt must not be in the future");
  }
  if (!timestamp(testAuthorization.expiresAt)) {
    issues.push("scope decision syntheticTestAuthorization expiresAt must be a canonical UTC ISO timestamp");
  } else {
    if (
      stage === "provisional_test_authorization" &&
      Number.isFinite(options.now.valueOf()) &&
      Date.parse(testAuthorization.expiresAt) <= options.now.valueOf()
    ) {
      issues.push("provisional scope authorization requires unexpired synthetic testing authorization");
    }
    if (
      stage === "provisional_test_authorization" &&
      dateOnly(root.decisionDate) &&
      testAuthorization.expiresAt.slice(0, 10) < root.decisionDate
    ) {
      issues.push("scope decision syntheticTestAuthorization expiresAt must not precede decisionDate");
    }
    if (timestamp(testAuthorization.issuedAt)) {
      const duration = Date.parse(testAuthorization.expiresAt) - Date.parse(testAuthorization.issuedAt);
      if (duration <= 0) {
        issues.push("scope decision syntheticTestAuthorization expiresAt must follow issuedAt");
      } else if (duration > MAX_AUTHORIZATION_MS) {
        issues.push("scope decision syntheticTestAuthorization authorization window must not exceed 30 days");
      }
    }
  }
  const traceFlowIds = stringList(
    testAuthorization.traceFlowIds,
    "scope decision syntheticTestAuthorization traceFlowIds",
    issues,
    stage === "provisional_test_authorization"
  );
  const seenTraceFlowIds = new Set<string>();
  for (const flowId of traceFlowIds) {
    if (!PCI_SCOPE_FLOW_IDS.includes(flowId as typeof PCI_SCOPE_FLOW_IDS[number])) {
      issues.push(`scope decision syntheticTestAuthorization has invalid trace flow id: ${flowId}`);
    } else if (seenTraceFlowIds.has(flowId)) {
      issues.push(`duplicate scope decision syntheticTestAuthorization trace flow id: ${flowId}`);
    } else {
      seenTraceFlowIds.add(flowId);
    }
  }
  if (stage === "provisional_test_authorization") {
    if (traceFlowIds.length > 0) {
      issues.push("provisional scope authorization requires empty syntheticTestAuthorization traceFlowIds");
    }
    if (testAuthorization.traceReceiptReference !== null) {
      issues.push("provisional scope authorization requires null syntheticTestAuthorization traceReceiptReference");
    }
    if (testAuthorization.traceReceiptSha256 !== null) {
      issues.push("provisional scope authorization requires null syntheticTestAuthorization traceReceiptSha256");
    }
    if (testAuthorization.startedAt !== null) {
      issues.push("provisional scope authorization requires null syntheticTestAuthorization startedAt");
    }
    if (testAuthorization.completedAt !== null) {
      issues.push("provisional scope authorization requires null syntheticTestAuthorization completedAt");
    }
  } else if (stage === "final_scope_acceptance") {
    if (!sameStringSet(traceFlowIds, authorizedFlowIds)) {
      issues.push("final scope acceptance requires traceFlowIds to exactly match authorizedFlowIds");
    }
    requireText(
      testAuthorization.traceReceiptReference,
      "scope decision syntheticTestAuthorization traceReceiptReference",
      issues
    );
    if (!nonBlank(testAuthorization.traceReceiptSha256) || !SHA256.test(testAuthorization.traceReceiptSha256)) {
      issues.push("final scope acceptance requires a valid synthetic trace receipt SHA-256");
    }
    if (
      nonBlank(evidence.syntheticTraceReference) &&
      nonBlank(testAuthorization.traceReceiptReference) &&
      evidence.syntheticTraceReference !== testAuthorization.traceReceiptReference
    ) {
      issues.push("scope decision syntheticTraceReference must equal traceReceiptReference");
    }
    if (!timestamp(testAuthorization.startedAt)) {
      issues.push("final scope acceptance requires canonical syntheticTestAuthorization startedAt");
    } else {
      if (
        Number.isFinite(options.now.valueOf()) &&
        Date.parse(testAuthorization.startedAt) > options.now.valueOf()
      ) {
        issues.push("scope decision syntheticTestAuthorization startedAt must not be in the future");
      }
      if (
        timestamp(testAuthorization.issuedAt) &&
        Date.parse(testAuthorization.startedAt) < Date.parse(testAuthorization.issuedAt)
      ) {
        issues.push("final scope acceptance requires synthetic trace start on or after authorization issuance");
      }
    }
    if (!timestamp(testAuthorization.completedAt)) {
      issues.push("final scope acceptance requires canonical syntheticTestAuthorization completedAt");
    } else {
      if (
        Number.isFinite(options.now.valueOf()) &&
        Date.parse(testAuthorization.completedAt) > options.now.valueOf()
      ) {
        issues.push("scope decision syntheticTestAuthorization completedAt must not be in the future");
      }
      if (
        timestamp(testAuthorization.expiresAt) &&
        Date.parse(testAuthorization.completedAt) > Date.parse(testAuthorization.expiresAt)
      ) {
        issues.push("final scope acceptance requires synthetic trace completion on or before authorization expiry");
      }
      if (
        timestamp(testAuthorization.startedAt) &&
        Date.parse(testAuthorization.completedAt) < Date.parse(testAuthorization.startedAt)
      ) {
        issues.push("final scope acceptance requires synthetic trace completion on or after trace start");
      }
    }
    if (!options.traceReceiptBytes) {
      issues.push("final scope acceptance requires the synthetic trace receipt bytes");
    } else {
      const parsedReceipt = parseJsonBytes(
        options.traceReceiptBytes,
        "synthetic trace receipt",
        issues
      );
      if (parsedReceipt) {
        if (
          nonBlank(testAuthorization.traceReceiptSha256) &&
          testAuthorization.traceReceiptSha256.toUpperCase() !== parsedReceipt.sha256
        ) {
          issues.push("final scope acceptance traceReceiptSha256 does not match the supplied trace receipt");
        }
        const receipt = record(parsedReceipt.input);
        if (!receipt) {
          issues.push("synthetic trace receipt must be an object");
        } else {
          unsupported(receipt, TRACE_RECEIPT_KEYS, "synthetic trace receipt", issues);
          if (receipt.schemaVersion !== 1) issues.push("synthetic trace receipt schemaVersion must equal 1");
          const receiptIdMatch = nonBlank(receipt.receiptId)
            ? /^TN-SYNTHETIC-TRACE-(\d{4})-(\d{3,})$/.exec(receipt.receiptId)
            : null;
          if (!receiptIdMatch) {
            issues.push("synthetic trace receipt receiptId must match TN-SYNTHETIC-TRACE-YYYY-NNN");
          }
          if (receipt.receiptId !== testAuthorization.traceReceiptReference) {
            issues.push("synthetic trace receipt receiptId must equal traceReceiptReference");
          }
          if (receipt.provisionalRecordId !== root.supersedesRecordId) {
            issues.push("synthetic trace receipt provisionalRecordId must equal final supersedesRecordId");
          }
          if (
            !nonBlank(receipt.provisionalRecordSha256) ||
            !SHA256.test(receipt.provisionalRecordSha256)
          ) {
            issues.push("synthetic trace receipt provisionalRecordSha256 must be a valid SHA-256");
          } else if (
            nonBlank(root.provisionalRecordSha256) &&
            receipt.provisionalRecordSha256.toUpperCase() !== root.provisionalRecordSha256.toUpperCase()
          ) {
            issues.push("synthetic trace receipt provisionalRecordSha256 must equal the final provisionalRecordSha256");
          }
          for (const key of [
            "authorizationReference",
            "environmentReference",
            "testAccountReference",
            "startedAt",
            "completedAt"
          ] as const) {
            if (receipt[key] !== testAuthorization[key]) {
              issues.push(`synthetic trace receipt ${key} must match the final authorization record`);
            }
          }
          const receiptFlowIds = stringList(receipt.flowIds, "synthetic trace receipt flowIds", issues);
          if (!sameStringSet(receiptFlowIds, traceFlowIds)) {
            issues.push("synthetic trace receipt flowIds must exactly match traceFlowIds");
          }
          if (receipt.result !== "passed") issues.push("synthetic trace receipt result must equal passed");
          const coverageGaps = stringList(receipt.coverageGaps, "synthetic trace receipt coverageGaps", issues, true);
          if (coverageGaps.length > 0) issues.push("synthetic trace receipt coverageGaps must be empty");
          const operator = requirePrincipalId(
            receipt.operatorPrincipalId,
            "synthetic trace receipt operatorPrincipalId",
            issues
          ) ? String(receipt.operatorPrincipalId).trim().toLowerCase() : null;
          const reviewer = requirePrincipalId(
            receipt.reviewerPrincipalId,
            "synthetic trace receipt reviewerPrincipalId",
            issues
          ) ? String(receipt.reviewerPrincipalId).trim().toLowerCase() : null;
          if (operator && reviewer && operator === reviewer) {
            issues.push("synthetic trace receipt operator and reviewer principal IDs must be distinct");
          }
          if (!timestamp(receipt.reviewedAt)) {
            issues.push("synthetic trace receipt reviewedAt must be a canonical UTC ISO timestamp");
          } else {
            traceReceiptReviewedAt = receipt.reviewedAt;
            if (
              timestamp(testAuthorization.completedAt) &&
              Date.parse(receipt.reviewedAt) < Date.parse(testAuthorization.completedAt)
            ) {
              issues.push("synthetic trace receipt reviewedAt must not precede trace completion");
            }
            if (
              Number.isFinite(options.now.valueOf()) &&
              Date.parse(receipt.reviewedAt) > options.now.valueOf()
            ) {
              issues.push("synthetic trace receipt reviewedAt must not be in the future");
            }
            if (receiptIdMatch && receiptIdMatch[1] !== receipt.reviewedAt.slice(0, 4)) {
              issues.push("synthetic trace receipt receiptId year must match reviewedAt");
            }
            if (dateOnly(root.decisionDate) && root.decisionDate < receipt.reviewedAt.slice(0, 10)) {
              issues.push("final scope acceptance decisionDate must not precede trace receipt review");
            }
          }
          requireText(
            receipt.restrictedArtifactReference,
            "synthetic trace receipt restrictedArtifactReference",
            issues
          );
        }
      }
    }
  }

  const unresolved = stringList(root.unresolvedQuestions, "scope decision unresolvedQuestions", issues, true);
  if (stage === "final_scope_acceptance" && unresolved.length > 0) {
    issues.push("final scope acceptance requires no unresolved questions");
  }

  const signoffs = Array.isArray(root.signoffs) ? root.signoffs : [];
  if (!Array.isArray(root.signoffs)) issues.push("scope decision signoffs must be an array");
  const requiredRoles = new Set(["pci_scope_owner", "compliance_accepting_entity"]);
  const seenRoles = new Set<string>();
  const seenIdentities = new Set<string>();
  const seenPrincipals = new Set<string>();
  const seenSignoffEvidence = new Set<string>();
  for (const [index, value] of signoffs.entries()) {
    const signoff = requireRecord(value, `scope decision signoff ${index + 1}`, issues);
    unsupported(signoff, SIGNOFF_KEYS, `scope decision signoff ${index + 1}`, issues);
    if (!requiredRoles.has(String(signoff.role))) issues.push(`scope decision signoff ${index + 1} role is invalid`);
    else if (seenRoles.has(String(signoff.role))) issues.push(`duplicate scope decision signoff role: ${String(signoff.role)}`);
    else seenRoles.add(String(signoff.role));
    requireText(signoff.identity, `scope decision signoff ${index + 1} identity`, issues);
    const normalized = identity(signoff.identity);
    if (normalized && seenIdentities.has(normalized)) issues.push("scope decision signoff identities must be distinct");
    if (normalized) seenIdentities.add(normalized);
    if (normalized && normalized === identity(root.preparedBy)) issues.push("scope decision preparer cannot approve the record");
    const principal = requirePrincipalId(
      signoff.principalId,
      `scope decision signoff ${index + 1} principalId`,
      issues
    ) ? String(signoff.principalId).toLowerCase() : null;
    if (principal && seenPrincipals.has(principal)) issues.push("scope decision signoff principal IDs must be distinct");
    if (principal) seenPrincipals.add(principal);
    if (principal && principal === identity(root.preparedByPrincipalId)) {
      issues.push("scope decision preparer principal cannot approve the record");
    }
    const expectedSignoffDecision = stage === "provisional_test_authorization"
      ? "authorized"
      : stage === "final_scope_acceptance"
        ? "approved"
        : null;
    if (expectedSignoffDecision === null || signoff.decision !== expectedSignoffDecision) {
      issues.push(
        `scope decision signoff ${index + 1} decision must equal ${expectedSignoffDecision ?? "the value required by decisionStage"}`
      );
    }
    if (!timestamp(signoff.decidedAt)) issues.push(`scope decision signoff ${index + 1} decidedAt must be a canonical UTC ISO timestamp`);
    else {
      if (Number.isFinite(options.now.valueOf()) && Date.parse(signoff.decidedAt) > options.now.valueOf()) {
        issues.push(`scope decision signoff ${index + 1} decidedAt must not be in the future`);
      }
      if (dateOnly(root.decisionDate) && signoff.decidedAt.slice(0, 10) < root.decisionDate) {
        issues.push(`scope decision signoff ${index + 1} decidedAt must not precede decisionDate`);
      }
      if (
        stage === "provisional_test_authorization" &&
        timestamp(testAuthorization.issuedAt) &&
        Date.parse(signoff.decidedAt) > Date.parse(testAuthorization.issuedAt)
      ) {
        issues.push(`scope decision signoff ${index + 1} decidedAt must not follow authorization issuedAt`);
      }
      if (
        stage === "final_scope_acceptance" &&
        timestamp(testAuthorization.completedAt) &&
        Date.parse(signoff.decidedAt) < Date.parse(testAuthorization.completedAt)
      ) {
        issues.push(`scope decision signoff ${index + 1} decidedAt must not precede trace completion`);
      }
      if (
        stage === "final_scope_acceptance" &&
        traceReceiptReviewedAt !== null &&
        Date.parse(signoff.decidedAt) < Date.parse(traceReceiptReviewedAt)
      ) {
        issues.push(`scope decision signoff ${index + 1} decidedAt must not precede trace receipt review`);
      }
    }
    if (requireText(signoff.evidenceReference, `scope decision signoff ${index + 1} evidenceReference`, issues)) {
      const evidenceReference = String(signoff.evidenceReference).trim().toLowerCase();
      if (seenSignoffEvidence.has(evidenceReference)) {
        issues.push("scope decision signoff evidence references must be distinct");
      }
      seenSignoffEvidence.add(evidenceReference);
    }
  }
  for (const role of requiredRoles) if (!seenRoles.has(role)) issues.push(`missing scope decision signoff role: ${role}`);

  if (stage === "final_scope_acceptance") {
    const linked = options.provisionalRecordBytes
      ? parseJsonBytes(options.provisionalRecordBytes, "linked provisional record", issues)
      : null;
    if (!options.provisionalRecordBytes) {
      issues.push("final scope acceptance requires the linked provisional record input");
    }
    if (linked) {
      if (
        nonBlank(root.provisionalRecordSha256) &&
        root.provisionalRecordSha256.toUpperCase() !== linked.sha256
      ) {
        issues.push("final scope acceptance provisionalRecordSha256 does not match the supplied provisional record");
      }
      const provisional = record(linked.input);
      if (!provisional) {
        issues.push("linked provisional record must be an object");
      } else {
        const provisionalAuthorization = record(provisional.syntheticTestAuthorization);
        const historicalNow = provisionalAuthorization && timestamp(provisionalAuthorization.issuedAt)
          ? new Date(provisionalAuthorization.issuedAt)
          : options.now;
        const provisionalResult = verifyPciScopeDecision(provisional, { now: historicalNow });
        if (!provisionalResult.structurallyAccepted || provisionalResult.stage !== "provisional_test_authorization") {
          issues.push("linked provisional record must be a structurally accepted provisional_test_authorization");
          for (const issue of provisionalResult.issues) issues.push(`linked provisional record: ${issue}`);
        }
        if (root.supersedesRecordId !== provisional.recordId) {
          issues.push("final scope acceptance supersedesRecordId must equal the linked provisional recordId");
        }
        if (
          dateOnly(root.decisionDate) &&
          dateOnly(provisional.decisionDate) &&
          root.decisionDate < provisional.decisionDate
        ) {
          issues.push("final scope acceptance decisionDate must not precede the provisional decisionDate");
        }
        if (
          dateOnly(root.decisionDate) &&
          timestamp(testAuthorization.completedAt) &&
          root.decisionDate < testAuthorization.completedAt.slice(0, 10)
        ) {
          issues.push("final scope acceptance decisionDate must not precede trace completion");
        }
        for (const key of ["scope", "panPolicy", "segmentation", "providers", "requirements"] as const) {
          if (stableValue(root[key]) !== stableValue(provisional[key])) {
            issues.push(`final scope acceptance must preserve provisional ${key}`);
          }
        }
        const provisionalEvidence = record(provisional.evidence);
        if (provisionalEvidence) {
          for (const key of [
            "dataFlowReference",
            "scopeInventoryReference",
            "architectureReleaseReference",
            "qsaOrAssessorDirectionReference"
          ] as const) {
            if (evidence[key] !== provisionalEvidence[key]) {
              issues.push(`final scope acceptance must preserve provisional evidence ${key}`);
            }
          }
        }
        if (provisionalAuthorization) {
          for (const key of [
            "environmentReference",
            "testAccountReference",
            "authorizedFlowIds",
            "syntheticDataOnly",
            "panProhibited",
            "destructiveTestingProhibited",
            "authorizationReference",
            "issuedAt",
            "expiresAt"
          ] as const) {
            if (stableValue(testAuthorization[key]) !== stableValue(provisionalAuthorization[key])) {
              issues.push(`final scope acceptance must preserve provisional syntheticTestAuthorization ${key}`);
            }
          }
        }
        const provisionalSignoffs = Array.isArray(provisional.signoffs) ? provisional.signoffs : [];
        const provisionalEvidenceReferences = new Set(
          provisionalSignoffs
            .map((value) => record(value)?.evidenceReference)
            .filter(nonBlank)
            .map((value) => value.trim().toLowerCase())
        );
        for (const evidenceReference of seenSignoffEvidence) {
          if (provisionalEvidenceReferences.has(evidenceReference)) {
            issues.push("final scope acceptance approval artifacts must differ from provisional authorization artifacts");
          }
        }
      }
    }
  }

  return {
    issues,
    structurallyAccepted: issues.length === 0,
    structurallyFinalAccepted: issues.length === 0 && stage === "final_scope_acceptance",
    stage
  };
}
