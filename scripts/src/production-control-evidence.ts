import { createHash } from "node:crypto";
import { parsePciJsonText } from "./pci-scope-decision.js";

export const REQUIRED_PRODUCTION_EXERCISES = [
  ["catalog_binary_checks", "3", "TN-WORK-11"],
  ["catalog_definition_ddl_match", "3", "TN-WORK-11"],
  ["throttle_document_upload", "4", "TN-WORK-13"],
  ["throttle_document_rescan", "4", "TN-WORK-13"],
  ["throttle_evaluation_run", "4", "TN-WORK-13"],
  ["throttle_bulk_invitation", "4", "TN-WORK-13"],
  ["throttle_user_creation", "4", "TN-WORK-13"],
  ["throttle_user_reset", "4", "TN-WORK-13"],
  ["throttle_password_change", "4", "TN-WORK-13"],
  ["throttle_shared_ip_independence", "4", "TN-WORK-13"],
  ["throttle_multi_replica_consistency", "4", "TN-WORK-13"],
  ["throttle_window_reset", "4", "TN-WORK-13"],
  ["throttle_stale_counter_cleanup", "4", "TN-WORK-13"],
  ["throttle_denial_audit_receipt", "4", "TN-WORK-13"],
  ["siem_delivery_alert", "5", "TN-WORK-13"],
  ["siem_retry_recovery", "5", "TN-WORK-13"],
  ["siem_dead_letter_response", "5", "TN-WORK-13"],
  ["firewall_openai_embedding_redaction", "6", "TN-WORK-02"],
  ["firewall_cohere_query_document_redaction", "6", "TN-WORK-02"],
  ["firewall_openrouter_generation_redaction", "6", "TN-WORK-02"],
  ["firewall_openrouter_utility_redaction", "6", "TN-WORK-02"],
  ["firewall_unresolved_rule_fail_closed", "6", "TN-WORK-02"],
  ["contextual_name_address_control", "6", "TN-WORK-02"],
  ["ai_deployed_eight_case_regression", "6", "TN-WORK-04"],
  ["ai_report_data_minimization", "6", "TN-WORK-04"],
  ["openrouter_input_redaction", "6", "TN-WORK-03"],
  ["openrouter_prompt_injection_handling", "6", "TN-WORK-03"],
  ["openrouter_output_sensitive_data_handling", "6", "TN-WORK-03"]
] as const;

export interface ProductionControlEvidenceVerification {
  issues: string[];
  structurallyAccepted: boolean;
}

export interface ProductionControlEvidenceOptions {
  now: Date;
  finalScopeRecordBytes?: Uint8Array;
  finalScopeStructurallyAccepted?: boolean;
}

const ROOT_KEYS = new Set([
  "schemaVersion", "recordId", "capturedAt", "completedAt", "environmentReference",
  "releaseReference", "releaseCommitSha", "changeEvidenceReference", "scopeDecision",
  "operatorPrincipalId", "independentReviewerPrincipalId", "exercises", "findings",
  "decision", "decisionAt", "decisionAuthorityPrincipalId", "decisionEvidenceReference"
]);
const SCOPE_KEYS = new Set(["recordId", "recordSha256", "decisionStage"]);
const EXERCISE_KEYS = new Set([
  "id", "runbookSection", "workstreamId", "applicability", "applicabilityRationale",
  "applicabilityApprovalReference", "status", "authorizationReference", "executedAt",
  "executedByPrincipalId", "reviewedAt", "reviewedByPrincipalId", "environmentReference",
  "releaseCommitSha", "scopeDecisionSha256", "restrictedEvidenceReference",
  "evidenceSha256", "findingId"
]);
const FINDING_KEYS = new Set(["id", "ownerPrincipalId", "dueDate", "status", "retestReference"]);
const PLACEHOLDER = /<[^>]+>|\b(?:tbd|todo|pending|unassigned|unknown|placeholder|n\/a|not yet determined)\b/i;
const UNSAFE = /https?:\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]/i;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function dateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value) && new Set(value.toLowerCase()).size > 1;
}

function principal(value: unknown): value is string {
  return typeof value === "string" && /^(?:user|group|service|external):TN-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(value);
}

function reference(value: unknown, prefix: string): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}-\\d{4}-\\d{3,}$`).test(value);
}

function unsupported(value: Record<string, unknown>, allowed: Set<string>, label: string, issues: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${label} contains unsupported field: ${key}`);
}

function substantive(value: unknown): value is string {
  return nonBlank(value) && value.trim().length >= 24 && !PLACEHOLDER.test(value) && !UNSAFE.test(value);
}

export function verifyProductionControlEvidence(
  input: unknown,
  options: ProductionControlEvidenceOptions
): ProductionControlEvidenceVerification {
  const issues: string[] = [];
  const root = record(input);
  if (!root) return { issues: ["production control evidence must be an object"], structurallyAccepted: false };
  unsupported(root, ROOT_KEYS, "production control evidence", issues);
  if (root.schemaVersion !== 1) issues.push("production control evidence schemaVersion must equal 1");
  const idMatch = nonBlank(root.recordId) ? /^TN-PROD-(\d{4})-(\d{3,})$/.exec(root.recordId) : null;
  if (!idMatch) issues.push("production control evidence recordId must match TN-PROD-YYYY-NNN");
  if (!timestamp(root.capturedAt)) issues.push("production control evidence capturedAt must be a canonical UTC ISO timestamp");
  if (!timestamp(root.completedAt)) issues.push("production control evidence completedAt must be a canonical UTC ISO timestamp");
  if (timestamp(root.capturedAt) && timestamp(root.completedAt)) {
    if (Date.parse(root.completedAt) < Date.parse(root.capturedAt)) issues.push("production control evidence completedAt must not precede capturedAt");
    if (Date.parse(root.completedAt) > options.now.valueOf()) issues.push("production control evidence completedAt must not be in the future");
    if (idMatch && idMatch[1] !== root.capturedAt.slice(0, 4)) issues.push("production control evidence recordId year must match capturedAt");
  }
  if (!reference(root.environmentReference, "TN-ENV")) issues.push("production control evidence environmentReference must match TN-ENV-YYYY-NNN");
  if (!reference(root.releaseReference, "TN-RELEASE")) issues.push("production control evidence releaseReference must match TN-RELEASE-YYYY-NNN");
  if (!nonBlank(root.releaseCommitSha) || !/^[a-f0-9]{40}$/.test(root.releaseCommitSha)) issues.push("production control evidence releaseCommitSha must be a lowercase 40-character Git commit SHA");
  if (!reference(root.changeEvidenceReference, "TN-CHANGE")) issues.push("production control evidence changeEvidenceReference must match TN-CHANGE-YYYY-NNN");
  if (!principal(root.operatorPrincipalId)) issues.push("production control evidence operatorPrincipalId must be a controlled principal reference");
  if (!principal(root.independentReviewerPrincipalId)) issues.push("production control evidence independentReviewerPrincipalId must be a controlled principal reference");
  if (root.operatorPrincipalId === root.independentReviewerPrincipalId) issues.push("production control evidence operator and independent reviewer must be distinct");

  const scope = record(root.scopeDecision) ?? {};
  if (!record(root.scopeDecision)) issues.push("production control evidence scopeDecision must be an object");
  unsupported(scope, SCOPE_KEYS, "production control evidence scopeDecision", issues);
  if (!reference(scope.recordId, "TN-PCI-SCOPE")) issues.push("production control evidence scopeDecision recordId must match TN-PCI-SCOPE-YYYY-NNN");
  if (!sha256(scope.recordSha256)) issues.push("production control evidence scopeDecision recordSha256 must be a non-placeholder SHA-256");
  if (scope.decisionStage !== "final_scope_acceptance") issues.push("production control evidence scopeDecision decisionStage must equal final_scope_acceptance");
  if (!options.finalScopeRecordBytes) {
    issues.push("production control evidence exact final scope record bytes must be provided");
  } else {
    const hash = createHash("sha256").update(options.finalScopeRecordBytes).digest("hex");
    if (hash !== String(scope.recordSha256).toLowerCase()) issues.push("production control evidence final scope record hash does not match exact bytes");
    try {
      const parsedScope = record(parsePciJsonText(Buffer.from(options.finalScopeRecordBytes).toString("utf8"))) ?? {};
      if (parsedScope.recordId !== scope.recordId) issues.push("production control evidence scopeDecision recordId does not match exact final scope bytes");
      if (parsedScope.decisionStage !== "final_scope_acceptance" || parsedScope.decision !== "accepted") {
        issues.push("production control evidence exact scope record must declare accepted final_scope_acceptance");
      }
    } catch (error) {
      issues.push(`production control evidence exact final scope bytes are invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (options.finalScopeStructurallyAccepted !== true) {
    issues.push("production control evidence final scope record must separately pass the linked final-stage scope validator");
  }

  const findings = Array.isArray(root.findings) ? root.findings : [];
  if (!Array.isArray(root.findings)) issues.push("production control evidence findings must be an array");
  const findingIds = new Set<string>();
  for (const [index, value] of findings.entries()) {
    const finding = record(value) ?? {};
    if (!record(value)) issues.push(`production control finding ${index + 1} must be an object`);
    unsupported(finding, FINDING_KEYS, `production control finding ${index + 1}`, issues);
    if (!reference(finding.id, "TN-FINDING")) issues.push(`production control finding ${index + 1} id must match TN-FINDING-YYYY-NNN`);
    else if (findingIds.has(finding.id)) issues.push(`duplicate production control finding id: ${finding.id}`);
    else findingIds.add(finding.id);
    if (!principal(finding.ownerPrincipalId)) issues.push(`production control finding ${index + 1} ownerPrincipalId must be controlled`);
    if (!dateOnly(finding.dueDate)) issues.push(`production control finding ${index + 1} dueDate must be a real YYYY-MM-DD date`);
    if (!new Set(["open", "closed"]).has(String(finding.status))) issues.push(`production control finding ${index + 1} status must be open or closed`);
    if (finding.status === "closed" && !reference(finding.retestReference, "TN-RETEST")) issues.push(`closed production control finding ${index + 1} requires a retestReference`);
  }

  const exercises = Array.isArray(root.exercises) ? root.exercises : [];
  if (!Array.isArray(root.exercises)) issues.push("production control evidence exercises must be an array");
  const seen = new Set<string>();
  const exerciseById = new Map<string, Record<string, unknown>>();
  const evidenceReferences = new Set<string>();
  let latestReview = 0;
  for (const [index, value] of exercises.entries()) {
    const exercise = record(value) ?? {};
    if (!record(value)) issues.push(`production control exercise ${index + 1} must be an object`);
    unsupported(exercise, EXERCISE_KEYS, `production control exercise ${index + 1}`, issues);
    const spec = REQUIRED_PRODUCTION_EXERCISES.find(([id]) => id === exercise.id);
    if (!spec) issues.push(`production control exercise ${index + 1} has invalid id`);
    else if (seen.has(spec[0])) issues.push(`duplicate production control exercise id: ${spec[0]}`);
    else {
      seen.add(spec[0]);
      exerciseById.set(spec[0], exercise);
      if (exercise.runbookSection !== spec[1]) issues.push(`production control ${spec[0]} runbookSection must equal ${spec[1]}`);
      if (exercise.workstreamId !== spec[2]) issues.push(`production control ${spec[0]} workstreamId must equal ${spec[2]}`);
    }
    if (exercise.environmentReference !== root.environmentReference) issues.push(`production control exercise ${index + 1} environmentReference must match the record`);
    if (exercise.releaseCommitSha !== root.releaseCommitSha) issues.push(`production control exercise ${index + 1} releaseCommitSha must match the record`);
    if (exercise.scopeDecisionSha256 !== scope.recordSha256) issues.push(`production control exercise ${index + 1} scopeDecisionSha256 must match the final scope record`);
    if (!principal(exercise.reviewedByPrincipalId) || exercise.reviewedByPrincipalId !== root.independentReviewerPrincipalId) {
      issues.push(`production control exercise ${index + 1} reviewedByPrincipalId must equal the independent reviewer`);
    }
    if (!timestamp(exercise.reviewedAt)) issues.push(`production control exercise ${index + 1} reviewedAt must be a canonical UTC ISO timestamp`);
    else {
      latestReview = Math.max(latestReview, Date.parse(exercise.reviewedAt));
      if (Date.parse(exercise.reviewedAt) > options.now.valueOf()) issues.push(`production control exercise ${index + 1} reviewedAt must not be in the future`);
    }
    if (exercise.applicability === "required") {
      if (!substantive(exercise.applicabilityRationale)) issues.push(`required production control exercise ${index + 1} needs a substantive repository-safe applicabilityRationale`);
      if (exercise.applicabilityApprovalReference !== null) issues.push(`required production control exercise ${index + 1} applicabilityApprovalReference must be null`);
      if (exercise.status !== "passed") issues.push(`required production control exercise ${index + 1} status must equal passed`);
      if (!reference(exercise.authorizationReference, "TN-AUTH")) issues.push(`required production control exercise ${index + 1} authorizationReference must match TN-AUTH-YYYY-NNN`);
      if (!timestamp(exercise.executedAt)) issues.push(`required production control exercise ${index + 1} executedAt must be a canonical UTC ISO timestamp`);
      else {
        if (timestamp(root.capturedAt) && Date.parse(exercise.executedAt) < Date.parse(root.capturedAt)) issues.push(`required production control exercise ${index + 1} executedAt must not precede capturedAt`);
        if (timestamp(exercise.reviewedAt) && Date.parse(exercise.reviewedAt) < Date.parse(exercise.executedAt)) issues.push(`production control exercise ${index + 1} reviewedAt must not precede executedAt`);
      }
      if (!principal(exercise.executedByPrincipalId) || exercise.executedByPrincipalId !== root.operatorPrincipalId) issues.push(`required production control exercise ${index + 1} executedByPrincipalId must equal the record operator`);
      if (exercise.executedByPrincipalId === exercise.reviewedByPrincipalId) issues.push(`production control exercise ${index + 1} executor and reviewer must be distinct`);
      if (!reference(exercise.restrictedEvidenceReference, "TN-PROD-EVIDENCE")) issues.push(`required production control exercise ${index + 1} restrictedEvidenceReference must match TN-PROD-EVIDENCE-YYYY-NNN`);
      else if (evidenceReferences.has(exercise.restrictedEvidenceReference)) issues.push(`duplicate production control restrictedEvidenceReference: ${exercise.restrictedEvidenceReference}`);
      else evidenceReferences.add(exercise.restrictedEvidenceReference);
      if (!sha256(exercise.evidenceSha256)) issues.push(`required production control exercise ${index + 1} evidenceSha256 must be a non-placeholder SHA-256`);
      if (exercise.findingId !== null) issues.push(`passed production control exercise ${index + 1} findingId must be null`);
    } else if (exercise.applicability === "not_applicable") {
      if (!substantive(exercise.applicabilityRationale)) issues.push(`not-applicable production control exercise ${index + 1} needs a substantive repository-safe applicabilityRationale`);
      if (!reference(exercise.applicabilityApprovalReference, "TN-APPROVAL")) issues.push(`not-applicable production control exercise ${index + 1} requires an applicabilityApprovalReference`);
      if (exercise.status !== "not_run") issues.push(`not-applicable production control exercise ${index + 1} status must equal not_run`);
      for (const field of ["authorizationReference", "executedAt", "executedByPrincipalId", "restrictedEvidenceReference", "evidenceSha256", "findingId"] as const) {
        if (exercise[field] !== null) issues.push(`not-applicable production control exercise ${index + 1} ${field} must be null`);
      }
    } else {
      issues.push(`production control exercise ${index + 1} applicability must be required or not_applicable`);
    }
  }
  for (const [id] of REQUIRED_PRODUCTION_EXERCISES) if (!seen.has(id)) issues.push(`missing required production control exercise declaration: ${id}`);

  const requireWithParent = (childId: string, parentId: string): void => {
    const child = exerciseById.get(childId);
    const parent = exerciseById.get(parentId);
    if (child?.applicability === "required" && parent?.applicability !== "required") {
      issues.push(`production control ${childId} cannot be required unless ${parentId} is required`);
    }
  };
  requireWithParent("catalog_definition_ddl_match", "catalog_binary_checks");
  requireWithParent("siem_retry_recovery", "siem_delivery_alert");
  requireWithParent("siem_dead_letter_response", "siem_delivery_alert");
  requireWithParent("ai_report_data_minimization", "ai_deployed_eight_case_regression");
  const throttleRoutes = [
    "throttle_document_upload", "throttle_document_rescan", "throttle_evaluation_run",
    "throttle_bulk_invitation", "throttle_user_creation", "throttle_user_reset",
    "throttle_password_change"
  ];
  if (throttleRoutes.some((id) => exerciseById.get(id)?.applicability === "required")) {
    for (const dependent of [
      "throttle_shared_ip_independence", "throttle_window_reset",
      "throttle_stale_counter_cleanup", "throttle_denial_audit_receipt"
    ]) {
      if (exerciseById.get(dependent)?.applicability !== "required") {
        issues.push(`production control ${dependent} must be required when any throttle route is required`);
      }
    }
  }
  const textProviderExercises = [
    "firewall_openai_embedding_redaction", "firewall_cohere_query_document_redaction",
    "firewall_openrouter_generation_redaction", "firewall_openrouter_utility_redaction"
  ];
  if (textProviderExercises.some((id) => exerciseById.get(id)?.applicability === "required")) {
    for (const dependent of ["firewall_unresolved_rule_fail_closed", "contextual_name_address_control"]) {
      if (exerciseById.get(dependent)?.applicability !== "required") {
        issues.push(`production control ${dependent} must be required when any text-provider boundary is required`);
      }
    }
  }

  if (root.decision !== "accepted") issues.push("production control evidence decision must equal accepted");
  if (!timestamp(root.decisionAt)) issues.push("production control evidence decisionAt must be a canonical UTC ISO timestamp");
  else {
    if (latestReview > 0 && Date.parse(root.decisionAt) < latestReview) issues.push("production control evidence decisionAt must not precede exercise review");
    if (Date.parse(root.decisionAt) > options.now.valueOf()) issues.push("production control evidence decisionAt must not be in the future");
  }
  if (!principal(root.decisionAuthorityPrincipalId)) issues.push("production control evidence decisionAuthorityPrincipalId must be controlled");
  if (root.decisionAuthorityPrincipalId === root.operatorPrincipalId || root.decisionAuthorityPrincipalId === root.independentReviewerPrincipalId) issues.push("production control evidence decision authority must be distinct from operator and reviewer");
  if (!reference(root.decisionEvidenceReference, "TN-APPROVAL")) issues.push("production control evidence decisionEvidenceReference must match TN-APPROVAL-YYYY-NNN");
  if (findings.some((item) => record(item)?.status === "open")) issues.push("accepted production control evidence cannot contain open findings");

  return { issues, structurallyAccepted: issues.length === 0 && root.decision === "accepted" };
}
