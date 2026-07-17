import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { parsePciJsonText } from "./pci-scope-decision.js";

export const PCI_GOVERNANCE_ROLE_IDS = [
  "pci_scope_owner",
  "qsa_or_compliance_accepting_entity",
  "engineering_owner",
  "product_security",
  "independent_code_reviewer",
  "change_authority",
  "platform_database_owner",
  "iam_owner",
  "security_operations_siem_owner",
  "data_content_owner",
  "vendor_risk_owner"
] as const;

export const PCI_GOVERNANCE_POLICY_SPECS = [
  { id: "secure_development_lifecycle", path: "docs/compliance/pci/secure-development-lifecycle.md" },
  { id: "vulnerability_management", path: "docs/compliance/pci/vulnerability-management.md" },
  { id: "change_control", path: "docs/compliance/pci/change-control.md" },
  { id: "scope_and_data_flow", path: "docs/compliance/pci/scope-and-data-flow.md" },
  { id: "roles_and_responsibilities", path: "docs/compliance/pci/roles-and-responsibilities.md" },
  { id: "third_party_responsibility_matrix", path: "docs/compliance/pci/third-party-responsibility-matrix.md" }
] as const;

export interface PciGovernanceVerification {
  issues: string[];
  structurallyAccepted: boolean;
}

export interface RoleAssignmentVerificationOptions {
  now: Date;
}

export interface PolicyAdoptionVerificationOptions {
  now: Date;
  roleAssignmentRecordBytes?: Uint8Array;
  policyDocumentBytes?: Readonly<Record<string, Uint8Array>>;
}

const ROLE_ROOT_KEYS = new Set([
  "schemaVersion",
  "recordId",
  "effectiveAt",
  "nextReviewDate",
  "preparedByPrincipalId",
  "roles",
  "unresolvedItems",
  "decision",
  "signoffs"
]);
const ROLE_KEYS = new Set([
  "id",
  "assigneePrincipalId",
  "delegatePrincipalId",
  "appointmentReference",
  "assigneeAcknowledgementReference",
  "delegateAcknowledgementReference",
  "acceptedAt"
]);
const ROLE_SIGNOFF_KEYS = new Set([
  "role",
  "principalId",
  "decision",
  "decidedAt",
  "evidenceReference"
]);
const ROLE_SIGNOFF_ROLES = ["executive_appointing_authority", "compliance_accepting_entity"] as const;

const POLICY_ROOT_KEYS = new Set([
  "schemaVersion",
  "recordId",
  "effectiveAt",
  "nextReviewDate",
  "preparedByPrincipalId",
  "roleAssignmentRecordId",
  "roleAssignmentRecordSha256",
  "policies",
  "communicationReferences",
  "trainingPlanReference",
  "unresolvedItems",
  "decision",
  "signoffs"
]);
const POLICY_KEYS = new Set([
  "id",
  "repositoryPath",
  "repositorySha256",
  "version",
  "decision",
  "approvalReference",
  "exceptions"
]);
const EXCEPTION_KEYS = new Set([
  "id",
  "rationale",
  "ownerPrincipalId",
  "expiresAt",
  "approvalReference",
  "status"
]);
const POLICY_SIGNOFF_KEYS = ROLE_SIGNOFF_KEYS;
const POLICY_SIGNOFF_ROLES = [
  "engineering_owner",
  "product_security",
  "pci_scope_owner",
  "qsa_or_compliance_accepting_entity"
] as const;

const PLACEHOLDER = /<[^>]+>|\b(?:tbd|todo|pending|unassigned|unknown|placeholder|n\/a|not yet determined)\b/i;
const PRINCIPAL_ID = /^(?:user|group|service|external):[A-Za-z0-9][A-Za-z0-9._:\/-]{2,120}$/;
const CONTROLLED_REFERENCE = /^[A-Z][A-Z0-9]{1,15}-[A-Z0-9][A-Z0-9-]{1,127}$/;
const SHA256 = /^[A-Fa-f0-9]{64}$/;
const MAX_REVIEW_INTERVAL_MS = 366 * 24 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalized(value: unknown): string | null {
  return nonBlank(value) ? value.trim().toLowerCase() : null;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function dateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function requireRecord(value: unknown, label: string, issues: string[]): Record<string, unknown> {
  const parsed = record(value);
  if (!parsed) issues.push(`${label} must be an object`);
  return parsed ?? {};
}

function unsupported(value: Record<string, unknown>, allowed: Set<string>, label: string, issues: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${label} contains unsupported field: ${key}`);
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

function requirePrincipal(value: unknown, label: string, issues: string[]): value is string {
  if (!requireText(value, label, issues)) return false;
  if (!PRINCIPAL_ID.test(value)) {
    issues.push(`${label} must be a stable principal identifier`);
    return false;
  }
  return true;
}

function requireReference(
  value: unknown,
  label: string,
  issues: string[],
  allowedPrefixes: readonly string[] = ["TN-"]
): value is string {
  if (!requireText(value, label, issues)) return false;
  const prefix = allowedPrefixes.find((candidate) => value.startsWith(candidate));
  if (
    !CONTROLLED_REFERENCE.test(value) ||
    !prefix ||
    !/^\d{4}-\d{3,}$/.test(value.slice(prefix.length))
  ) {
    issues.push(`${label} must be an opaque controlled reference ID`);
    return false;
  }
  return true;
}

function luhn(value: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
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
  if (/\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/.test(value)) return "SSN-like value";
  if (/\b\d{12}\b/.test(value)) return "12-digit account identifier";
  const digitRuns = value.match(/(?:\d[ -]?){13,19}/g) ?? [];
  if (digitRuns.map((candidate) => candidate.replace(/\D/g, "")).some((candidate) =>
    candidate.length >= 13 && candidate.length <= 19 && luhn(candidate))) return "PAN-like value";
  const dottedTokens = value.match(/\b[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b/gi) ?? [];
  if (dottedTokens.some((token) => /[A-Z]/i.test(token))) return "hostname-like value";
  if (/\b(?:DB|APP|API|WEB|HOST|SERVER|NODE|PROD|STAGE|STAGING|DEV)-[A-Z0-9-]*[A-Z0-9]\b/i.test(value)) {
    return "single-label hostname-like value";
  }
  return null;
}

function requireRepositorySafeRationale(value: unknown, label: string, issues: string[]): value is string {
  if (!requireText(value, label, issues)) return false;
  if (value.trim().length < 30) {
    issues.push(`${label} must be substantive`);
    return false;
  }
  const unsafeReason = repositoryUnsafeReason(value);
  if (unsafeReason) {
    issues.push(`${label} must not contain a repository-unsafe ${unsafeReason}`);
    return false;
  }
  return true;
}

function requireEmptyUnresolved(value: unknown, label: string, issues: string[]): void {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
  } else if (value.length > 0) {
    issues.push(`${label} must be empty before approval`);
  }
}

function verifyReviewWindow(
  effectiveAt: unknown,
  nextReviewDate: unknown,
  now: Date,
  label: string,
  issues: string[]
): void {
  if (!timestamp(effectiveAt)) {
    issues.push(`${label} effectiveAt must be a canonical UTC ISO timestamp`);
    return;
  }
  if (effectiveAt > now.toISOString()) issues.push(`${label} effectiveAt must not be in the future`);
  if (!dateOnly(nextReviewDate)) {
    issues.push(`${label} nextReviewDate must be a real YYYY-MM-DD date`);
    return;
  }
  const effectiveDate = effectiveAt.slice(0, 10);
  if (nextReviewDate <= effectiveDate) issues.push(`${label} nextReviewDate must follow effectiveAt`);
  if (nextReviewDate < now.toISOString().slice(0, 10)) issues.push(`${label} nextReviewDate must not be past due`);
  const interval = Date.parse(`${nextReviewDate}T00:00:00.000Z`) - Date.parse(`${effectiveDate}T00:00:00.000Z`);
  if (interval > MAX_REVIEW_INTERVAL_MS) issues.push(`${label} nextReviewDate must be no more than 366 days after effectiveAt`);
}

function verifyRecordIdentity(
  root: Record<string, unknown>,
  prefix: "ROLES" | "POLICY",
  issues: string[]
): void {
  if (root.schemaVersion !== 1) issues.push(`PCI governance ${prefix.toLowerCase()} schemaVersion must equal 1`);
  const match = nonBlank(root.recordId)
    ? new RegExp(`^TN-PCI-${prefix}-(\\d{4})-(\\d{3,})$`).exec(root.recordId)
    : null;
  if (!match) issues.push(`PCI governance ${prefix.toLowerCase()} recordId must match TN-PCI-${prefix}-YYYY-NNN`);
  if (match && timestamp(root.effectiveAt) && match[1] !== root.effectiveAt.slice(0, 4)) {
    issues.push(`PCI governance ${prefix.toLowerCase()} recordId year must match effectiveAt`);
  }
}

function parseBoundRecord(bytes: Uint8Array, label: string, issues: string[]): { input: unknown; sha256: string } | null {
  try {
    return {
      input: parsePciJsonText(Buffer.from(bytes).toString("utf8")),
      sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase()
    };
  } catch (error) {
    issues.push(`${label} must contain valid duplicate-key-free JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function verifyPciRoleAssignments(
  input: unknown,
  options: RoleAssignmentVerificationOptions
): PciGovernanceVerification {
  const issues: string[] = [];
  const root = record(input);
  if (!root) return { issues: ["PCI role-assignment record must be an object"], structurallyAccepted: false };
  unsupported(root, ROLE_ROOT_KEYS, "PCI role-assignment record", issues);
  verifyRecordIdentity(root, "ROLES", issues);
  verifyReviewWindow(root.effectiveAt, root.nextReviewDate, options.now, "PCI role-assignment record", issues);
  requirePrincipal(root.preparedByPrincipalId, "PCI role-assignment preparedByPrincipalId", issues);
  if (root.decision !== "approved") issues.push("PCI role-assignment decision must equal approved");
  requireEmptyUnresolved(root.unresolvedItems, "PCI role-assignment unresolvedItems", issues);

  const roles = Array.isArray(root.roles) ? root.roles : [];
  if (!Array.isArray(root.roles)) issues.push("PCI role-assignment roles must be an array");
  const rolesById = new Map<string, Record<string, unknown>>();
  const evidenceReferences = new Set<string>();
  for (const [index, value] of roles.entries()) {
    const label = `PCI role assignment ${index + 1}`;
    const role = requireRecord(value, label, issues);
    unsupported(role, ROLE_KEYS, label, issues);
    const id = String(role.id);
    if (!PCI_GOVERNANCE_ROLE_IDS.includes(id as typeof PCI_GOVERNANCE_ROLE_IDS[number])) {
      issues.push(`${label} id is invalid`);
    } else if (rolesById.has(id)) {
      issues.push(`duplicate PCI role assignment: ${id}`);
    } else {
      rolesById.set(id, role);
    }
    requirePrincipal(role.assigneePrincipalId, `${label} assigneePrincipalId`, issues);
    requirePrincipal(role.delegatePrincipalId, `${label} delegatePrincipalId`, issues);
    if (normalized(role.assigneePrincipalId) === normalized(role.delegatePrincipalId)) {
      issues.push(`${label} assignee and delegate principal IDs must differ`);
    }
    for (const key of [
      "appointmentReference",
      "assigneeAcknowledgementReference",
      "delegateAcknowledgementReference"
    ] as const) {
      const prefixes = key === "appointmentReference" ? ["TN-APPOINT-"] : ["TN-ACK-"];
      if (requireReference(role[key], `${label} ${key}`, issues, prefixes)) {
        const reference = role[key].trim().toUpperCase();
        if (evidenceReferences.has(reference)) issues.push("PCI role-assignment evidence references must be distinct");
        evidenceReferences.add(reference);
      }
    }
    if (!timestamp(role.acceptedAt)) {
      issues.push(`${label} acceptedAt must be a canonical UTC ISO timestamp`);
    } else {
      if (role.acceptedAt > options.now.toISOString()) issues.push(`${label} acceptedAt must not be in the future`);
      if (timestamp(root.effectiveAt) && role.acceptedAt > root.effectiveAt) {
        issues.push(`${label} acceptedAt must not follow effectiveAt`);
      }
    }
  }
  for (const id of PCI_GOVERNANCE_ROLE_IDS) {
    if (!rolesById.has(id)) issues.push(`missing PCI role assignment: ${id}`);
  }

  const rolePrincipals = (id: string): Set<string> => new Set(
    [rolesById.get(id)?.assigneePrincipalId, rolesById.get(id)?.delegatePrincipalId]
      .map(normalized)
      .filter(nonBlank)
  );
  for (const [left, right] of [
    ["pci_scope_owner", "qsa_or_compliance_accepting_entity"],
    ["engineering_owner", "independent_code_reviewer"],
    ["change_authority", "independent_code_reviewer"]
  ] as const) {
    const leftPrincipals = rolePrincipals(left);
    const rightPrincipals = rolePrincipals(right);
    if ([...leftPrincipals].some((principal) => rightPrincipals.has(principal))) {
      issues.push(`PCI role separation requires non-overlapping assignee/delegate principals for ${left} and ${right}`);
    }
  }

  const signoffs = Array.isArray(root.signoffs) ? root.signoffs : [];
  if (!Array.isArray(root.signoffs)) issues.push("PCI role-assignment signoffs must be an array");
  const signoffRoles = new Set<string>();
  const signoffPrincipals = new Set<string>();
  const signoffReferences = new Set<string>();
  for (const [index, value] of signoffs.entries()) {
    const label = `PCI role-assignment signoff ${index + 1}`;
    const signoff = requireRecord(value, label, issues);
    unsupported(signoff, ROLE_SIGNOFF_KEYS, label, issues);
    const role = String(signoff.role);
    if (!ROLE_SIGNOFF_ROLES.includes(role as typeof ROLE_SIGNOFF_ROLES[number])) {
      issues.push(`${label} role is invalid`);
    } else if (signoffRoles.has(role)) {
      issues.push(`duplicate PCI role-assignment signoff role: ${role}`);
    } else signoffRoles.add(role);
    if (requirePrincipal(signoff.principalId, `${label} principalId`, issues)) {
      const principal = normalized(signoff.principalId)!;
      if (principal === normalized(root.preparedByPrincipalId)) issues.push(`${label} principalId must differ from the preparer`);
      if (signoffPrincipals.has(principal)) issues.push("PCI role-assignment signoff principals must be distinct");
      signoffPrincipals.add(principal);
    }
    if (signoff.decision !== "approved") issues.push(`${label} decision must equal approved`);
    if (!timestamp(signoff.decidedAt)) {
      issues.push(`${label} decidedAt must be a canonical UTC ISO timestamp`);
    } else {
      if (signoff.decidedAt > options.now.toISOString()) issues.push(`${label} decidedAt must not be in the future`);
      if (timestamp(root.effectiveAt) && signoff.decidedAt > root.effectiveAt) issues.push(`${label} decidedAt must not follow effectiveAt`);
    }
    if (requireReference(signoff.evidenceReference, `${label} evidenceReference`, issues, ["TN-ROLE-APPROVAL-"])) {
      const reference = signoff.evidenceReference.trim().toUpperCase();
      if (signoffReferences.has(reference)) issues.push("PCI role-assignment signoff evidence references must be distinct");
      signoffReferences.add(reference);
    }
  }
  for (const role of ROLE_SIGNOFF_ROLES) if (!signoffRoles.has(role)) issues.push(`missing PCI role-assignment signoff: ${role}`);

  return { issues, structurallyAccepted: issues.length === 0 };
}

export function verifyPciPolicyAdoption(
  input: unknown,
  options: PolicyAdoptionVerificationOptions
): PciGovernanceVerification {
  const issues: string[] = [];
  const root = record(input);
  if (!root) return { issues: ["PCI policy-adoption record must be an object"], structurallyAccepted: false };
  unsupported(root, POLICY_ROOT_KEYS, "PCI policy-adoption record", issues);
  verifyRecordIdentity(root, "POLICY", issues);
  verifyReviewWindow(root.effectiveAt, root.nextReviewDate, options.now, "PCI policy-adoption record", issues);
  requirePrincipal(root.preparedByPrincipalId, "PCI policy-adoption preparedByPrincipalId", issues);
  if (root.decision !== "approved") issues.push("PCI policy-adoption decision must equal approved");
  requireEmptyUnresolved(root.unresolvedItems, "PCI policy-adoption unresolvedItems", issues);

  let linkedRoles: Record<string, unknown> | null = null;
  let linkedRoleAssignments = new Map<string, Record<string, unknown>>();
  if (!options.roleAssignmentRecordBytes) {
    issues.push("PCI policy adoption requires the exact linked role-assignment record bytes");
  } else {
    const parsed = parseBoundRecord(options.roleAssignmentRecordBytes, "linked PCI role-assignment record", issues);
    if (parsed) {
      linkedRoles = record(parsed.input);
      const roleResult = verifyPciRoleAssignments(parsed.input, { now: options.now });
      if (!roleResult.structurallyAccepted) {
        issues.push("linked PCI role-assignment record must be structurally accepted");
        for (const issue of roleResult.issues) issues.push(`linked PCI role-assignment record: ${issue}`);
      }
      if (root.roleAssignmentRecordId !== linkedRoles?.recordId) {
        issues.push("PCI policy adoption roleAssignmentRecordId must match the linked role record");
      }
      if (!nonBlank(root.roleAssignmentRecordSha256) || !SHA256.test(root.roleAssignmentRecordSha256)) {
        issues.push("PCI policy adoption roleAssignmentRecordSha256 must be a 64-character hexadecimal digest");
      } else if (root.roleAssignmentRecordSha256.toUpperCase() !== parsed.sha256) {
        issues.push("PCI policy adoption roleAssignmentRecordSha256 must match the exact linked role bytes");
      }
      if (timestamp(root.effectiveAt) && timestamp(linkedRoles?.effectiveAt) && root.effectiveAt < linkedRoles.effectiveAt) {
        issues.push("PCI policy adoption effectiveAt must not precede linked role assignments");
      }
      const roles = Array.isArray(linkedRoles?.roles) ? linkedRoles.roles : [];
      linkedRoleAssignments = new Map(
        roles.map((value) => record(value)).filter((value): value is Record<string, unknown> => value !== null)
          .map((value) => [String(value.id), value])
      );
    }
  }

  const policies = Array.isArray(root.policies) ? root.policies : [];
  if (!Array.isArray(root.policies)) issues.push("PCI policy-adoption policies must be an array");
  const policyIds = new Set<string>();
  const exceptionIds = new Set<string>();
  const policyReferences = new Set<string>();
  const assignedPrincipals = new Set(
    [...linkedRoleAssignments.values()].map((value) => normalized(value.assigneePrincipalId)).filter(nonBlank)
  );
  for (const [index, value] of policies.entries()) {
    const label = `PCI policy adoption ${index + 1}`;
    const policy = requireRecord(value, label, issues);
    unsupported(policy, POLICY_KEYS, label, issues);
    const spec = PCI_GOVERNANCE_POLICY_SPECS.find((candidate) => candidate.id === policy.id);
    if (!spec) {
      issues.push(`${label} id is invalid`);
    } else if (policyIds.has(spec.id)) {
      issues.push(`duplicate PCI policy adoption: ${spec.id}`);
    } else {
      policyIds.add(spec.id);
      if (policy.repositoryPath !== spec.path) issues.push(`${label} repositoryPath must equal ${spec.path}`);
      const bytes = options.policyDocumentBytes?.[spec.id];
      if (!bytes) {
        issues.push(`${label} requires the exact current policy document bytes`);
      } else {
        const computed = createHash("sha256").update(bytes).digest("hex").toUpperCase();
        if (!nonBlank(policy.repositorySha256) || !SHA256.test(policy.repositorySha256)) {
          issues.push(`${label} repositorySha256 must be a 64-character hexadecimal digest`);
        } else if (policy.repositorySha256.toUpperCase() !== computed) {
          issues.push(`${label} repositorySha256 must match the exact policy document bytes`);
        }
        const headerLines = Buffer.from(bytes).toString("utf8").split(/\r?\n/).slice(0, 12);
        const statusLines = headerLines.filter((line) => /^\*\*Status:\*\*/.test(line));
        if (statusLines.length !== 1 || statusLines[0] !== "**Status:** Approved") {
          issues.push(`${label} policy header must contain exactly one Status: Approved declaration`);
        }
        const adoptionLines = headerLines.filter((line) => /^\*\*Adoption record:\*\*/.test(line));
        if (
          !nonBlank(root.recordId) ||
          adoptionLines.length !== 1 ||
          adoptionLines[0] !== `**Adoption record:** ${root.recordId}`
        ) {
          issues.push(`${label} policy header must contain exactly one matching adoption-record declaration`);
        }
      }
    }
    if (!nonBlank(policy.version) || !/^\d{4}\.\d+$/.test(policy.version) || PLACEHOLDER.test(policy.version)) {
      issues.push(`${label} version must match YYYY.N`);
    }
    if (policy.decision !== "approved") issues.push(`${label} decision must equal approved`);
    if (requireReference(policy.approvalReference, `${label} approvalReference`, issues, ["TN-POLICY-APPROVAL-"])) {
      const reference = policy.approvalReference.trim().toUpperCase();
      if (policyReferences.has(reference)) issues.push("PCI policy approval references must be distinct");
      policyReferences.add(reference);
    }
    const exceptions = Array.isArray(policy.exceptions) ? policy.exceptions : [];
    if (!Array.isArray(policy.exceptions)) issues.push(`${label} exceptions must be an array`);
    for (const [exceptionIndex, exceptionValue] of exceptions.entries()) {
      const exceptionLabel = `${label} exception ${exceptionIndex + 1}`;
      const exception = requireRecord(exceptionValue, exceptionLabel, issues);
      unsupported(exception, EXCEPTION_KEYS, exceptionLabel, issues);
      const exceptionId = nonBlank(exception.id) ? /^TN-PCI-EXCEPTION-(\d{4})-(\d{3,})$/.exec(exception.id) : null;
      if (!exceptionId) issues.push(`${exceptionLabel} id must match TN-PCI-EXCEPTION-YYYY-NNN`);
      else if (exceptionIds.has(exception.id as string)) issues.push(`duplicate PCI policy exception: ${String(exception.id)}`);
      else exceptionIds.add(exception.id as string);
      requireRepositorySafeRationale(exception.rationale, `${exceptionLabel} rationale`, issues);
      if (requirePrincipal(exception.ownerPrincipalId, `${exceptionLabel} ownerPrincipalId`, issues) &&
        !assignedPrincipals.has(normalized(exception.ownerPrincipalId)!)) {
        issues.push(`${exceptionLabel} ownerPrincipalId must be an assigned governance-role principal`);
      }
      if (!timestamp(exception.expiresAt)) {
        issues.push(`${exceptionLabel} expiresAt must be a canonical UTC ISO timestamp`);
      } else {
        if (timestamp(root.effectiveAt) && exception.expiresAt <= root.effectiveAt) issues.push(`${exceptionLabel} expiresAt must follow policy effectiveAt`);
        if (exception.expiresAt <= options.now.toISOString()) issues.push(`${exceptionLabel} expiresAt must not be expired`);
        if (dateOnly(root.nextReviewDate) && exception.expiresAt.slice(0, 10) > root.nextReviewDate) {
          issues.push(`${exceptionLabel} expiresAt must not follow nextReviewDate`);
        }
      }
      if (requireReference(
        exception.approvalReference,
        `${exceptionLabel} approvalReference`,
        issues,
        ["TN-EXCEPTION-APPROVAL-"]
      )) {
        const reference = exception.approvalReference.trim().toUpperCase();
        if (policyReferences.has(reference)) issues.push("PCI policy and exception approval references must be distinct");
        policyReferences.add(reference);
      }
      if (exception.status !== "approved") issues.push(`${exceptionLabel} status must equal approved`);
    }
  }
  for (const spec of PCI_GOVERNANCE_POLICY_SPECS) if (!policyIds.has(spec.id)) issues.push(`missing PCI policy adoption: ${spec.id}`);

  const communicationReferences = Array.isArray(root.communicationReferences) ? root.communicationReferences : [];
  if (!Array.isArray(root.communicationReferences)) issues.push("PCI policy-adoption communicationReferences must be an array");
  if (communicationReferences.length === 0) issues.push("PCI policy-adoption communicationReferences must not be empty");
  const communicationSet = new Set<string>();
  for (const [index, value] of communicationReferences.entries()) {
    if (requireReference(
      value,
      `PCI policy-adoption communication reference ${index + 1}`,
      issues,
      ["TN-POLICY-COMMUNICATION-"]
    )) {
      const reference = value.trim().toUpperCase();
      if (communicationSet.has(reference)) issues.push("PCI policy-adoption communication references must be distinct");
      communicationSet.add(reference);
    }
  }
  requireReference(
    root.trainingPlanReference,
    "PCI policy-adoption trainingPlanReference",
    issues,
    ["TN-TRAINING-PLAN-"]
  );

  const signoffs = Array.isArray(root.signoffs) ? root.signoffs : [];
  if (!Array.isArray(root.signoffs)) issues.push("PCI policy-adoption signoffs must be an array");
  const signoffRoles = new Set<string>();
  const signoffPrincipals = new Set<string>();
  const signoffReferences = new Set<string>();
  for (const [index, value] of signoffs.entries()) {
    const label = `PCI policy-adoption signoff ${index + 1}`;
    const signoff = requireRecord(value, label, issues);
    unsupported(signoff, POLICY_SIGNOFF_KEYS, label, issues);
    const role = String(signoff.role);
    if (!POLICY_SIGNOFF_ROLES.includes(role as typeof POLICY_SIGNOFF_ROLES[number])) {
      issues.push(`${label} role is invalid`);
    } else if (signoffRoles.has(role)) {
      issues.push(`duplicate PCI policy-adoption signoff role: ${role}`);
    } else signoffRoles.add(role);
    if (requirePrincipal(signoff.principalId, `${label} principalId`, issues)) {
      const principal = normalized(signoff.principalId)!;
      if (principal === normalized(root.preparedByPrincipalId)) issues.push(`${label} principalId must differ from the preparer`);
      if (signoffPrincipals.has(principal)) issues.push("PCI policy-adoption signoff principals must be distinct");
      signoffPrincipals.add(principal);
      const assigned = normalized(linkedRoleAssignments.get(role)?.assigneePrincipalId);
      if (assigned && principal !== assigned) issues.push(`${label} principalId must match the linked role assignee`);
    }
    if (signoff.decision !== "approved") issues.push(`${label} decision must equal approved`);
    if (!timestamp(signoff.decidedAt)) {
      issues.push(`${label} decidedAt must be a canonical UTC ISO timestamp`);
    } else {
      if (signoff.decidedAt > options.now.toISOString()) issues.push(`${label} decidedAt must not be in the future`);
      if (timestamp(root.effectiveAt) && signoff.decidedAt > root.effectiveAt) issues.push(`${label} decidedAt must not follow effectiveAt`);
      if (timestamp(linkedRoles?.effectiveAt) && signoff.decidedAt < linkedRoles.effectiveAt) {
        issues.push(`${label} decidedAt must not precede linked role assignments`);
      }
    }
    if (requireReference(signoff.evidenceReference, `${label} evidenceReference`, issues, ["TN-POLICY-SIGNOFF-"])) {
      const reference = signoff.evidenceReference.trim().toUpperCase();
      if (signoffReferences.has(reference)) issues.push("PCI policy-adoption signoff evidence references must be distinct");
      signoffReferences.add(reference);
    }
  }
  for (const role of POLICY_SIGNOFF_ROLES) if (!signoffRoles.has(role)) issues.push(`missing PCI policy-adoption signoff: ${role}`);

  return { issues, structurallyAccepted: issues.length === 0 };
}
