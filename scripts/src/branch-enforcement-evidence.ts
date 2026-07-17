import { createHash } from "node:crypto";

export const REQUIRED_BRANCH_CHECKS = [
  { id: "verify", workflow: "Security and quality", jobName: "Typecheck, build, tests" },
  { id: "supply-chain", workflow: "Security and quality", jobName: "Dependency audit and SBOM" },
  { id: "secrets", workflow: "Security and quality", jobName: "Secret scan" },
  { id: "codeql", workflow: "Security and quality", jobName: "CodeQL analysis and SARIF evidence" }
] as const;

export const REQUIRED_BRANCH_ENFORCEMENT_TESTS = [
  { id: "denied_unapproved_pr", expectedResult: "denied" },
  { id: "denied_missing_required_check", expectedResult: "denied" },
  { id: "denied_stale_review", expectedResult: "denied" },
  { id: "denied_direct_push", expectedResult: "denied" },
  { id: "denied_force_push", expectedResult: "denied" },
  { id: "allowed_fully_approved_merge", expectedResult: "allowed" }
] as const;

export interface BranchEnforcementVerification {
  issues: string[];
  structurallyAccepted: boolean;
}

const ROOT_KEYS = new Set([
  "schemaVersion",
  "recordId",
  "repository",
  "defaultBranch",
  "capturedAt",
  "capturedBy",
  "captureMethod",
  "apiEndpoints",
  "apiResponses",
  "evidence",
  "codeowners",
  "rules",
  "enforcementTests",
  "decision",
  "gaps",
  "signoffs"
]);
const EVIDENCE_KEYS = new Set([
  "restrictedArtifactId",
  "artifactSha256",
  "safeReference",
  "rulesetReference"
]);
const RESPONSE_KEYS = new Set([
  "endpoint",
  "method",
  "httpStatus",
  "capturedAt",
  "requestId",
  "pageCount",
  "paginationComplete",
  "bodySha256"
]);
const CODEOWNERS_KEYS = new Set(["path", "coverage", "ownerTokens", "sourceSha256"]);
const RULE_KEYS = new Set([
  "enforcement",
  "targetBranch",
  "requirePullRequest",
  "requiredApprovals",
  "dismissStaleReviews",
  "requireCodeOwnerReview",
  "requireLastPushApproval",
  "requireConversationResolution",
  "requireStatusChecks",
  "requireBranchesUpToDate",
  "enforceAdmins",
  "restrictDirectPushes",
  "blockForcePushes",
  "blockDeletions",
  "bypassActors",
  "requiredChecks"
]);
const CHECK_KEYS = new Set(["id", "workflow", "jobName", "context", "integrationId", "required"]);
const ENFORCEMENT_TEST_KEYS = new Set([
  "id",
  "expectedResult",
  "actualResult",
  "executedAt",
  "executedBy",
  "reviewedAt",
  "reviewedBy",
  "targetReference",
  "restrictedArtifactId",
  "artifactSha256",
  "configurationArtifactSha256",
  "rulesetReference",
  "exercisedCheckIds"
]);
const SIGNOFF_KEYS = new Set(["role", "identity", "decision", "reviewedAt", "evidenceReference"]);
const PLACEHOLDER = /<[^>]+>|\b(?:tbd|todo|pending|unassigned|unknown|placeholder|n\/a|not yet determined)\b/i;
const REQUIRED_API_ENDPOINTS = [
  "/repos/ryanportfolio/kbase/rulesets",
  "/repos/ryanportfolio/kbase/branches/main/protection"
] as const;
const REQUIRED_CODEOWNERS_PATH = ".github/CODEOWNERS";

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

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[A-Fa-f0-9]{64}$/.test(value) && new Set(value.toLowerCase()).size > 1;
}

function canonicalApiEndpoint(value: unknown): string | null {
  if (!nonBlank(value)) return null;
  if (REQUIRED_API_ENDPOINTS.includes(value as typeof REQUIRED_API_ENDPOINTS[number])) return value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com" || parsed.search || parsed.hash) return null;
    return REQUIRED_API_ENDPOINTS.includes(parsed.pathname as typeof REQUIRED_API_ENDPOINTS[number])
      ? parsed.pathname
      : null;
  } catch {
    return null;
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function codeownersRootRule(text: string): { pattern: string; owners: string[] } | null {
  const rules = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
  const last = rules.at(-1);
  if (!last || last.length < 2) return null;
  return { pattern: last[0]!, owners: last.slice(1) };
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

function requireRecord(value: unknown, label: string, issues: string[]): Record<string, unknown> {
  const parsed = record(value);
  if (!parsed) issues.push(`${label} must be an object`);
  return parsed ?? {};
}

function unsupported(value: Record<string, unknown>, allowed: Set<string>, label: string, issues: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${label} contains unsupported field: ${key}`);
}

export function verifyBranchEnforcementEvidence(
  input: unknown,
  options: {
    now: Date;
    codeownersText?: string;
  }
): BranchEnforcementVerification {
  const issues: string[] = [];
  const root = record(input);
  if (!root) return { issues: ["branch enforcement evidence must be an object"], structurallyAccepted: false };
  unsupported(root, ROOT_KEYS, "branch enforcement evidence", issues);
  if (root.schemaVersion !== 2) issues.push("branch enforcement schemaVersion must equal 2");
  const idMatch = nonBlank(root.recordId) ? /^TN-BRANCH-(\d{4})-(\d{3,})$/.exec(root.recordId) : null;
  if (!idMatch) issues.push("branch enforcement recordId must match TN-BRANCH-YYYY-NNN");
  if (root.repository !== "ryanportfolio/kbase") issues.push("branch enforcement repository must equal ryanportfolio/kbase");
  if (root.defaultBranch !== "main") issues.push("branch enforcement defaultBranch must equal main");
  if (!timestamp(root.capturedAt)) {
    issues.push("branch enforcement capturedAt must be a canonical UTC ISO timestamp");
  } else {
    if (idMatch && idMatch[1] !== root.capturedAt.slice(0, 4)) issues.push("branch enforcement recordId year must match capturedAt");
    const age = options.now.valueOf() - Date.parse(root.capturedAt);
    if (age < 0) issues.push("branch enforcement capturedAt must not be in the future");
    if (age > 30 * 24 * 60 * 60 * 1000) issues.push("branch enforcement evidence must be no older than 30 days");
  }
  requireText(root.capturedBy, "branch enforcement capturedBy", issues);
  if (root.captureMethod !== "github_api") issues.push("branch enforcement captureMethod must equal github_api");
  const endpoints = Array.isArray(root.apiEndpoints) ? root.apiEndpoints : [];
  if (!Array.isArray(root.apiEndpoints)) issues.push("branch enforcement apiEndpoints must be an array");
  const canonicalEndpoints = endpoints.map(canonicalApiEndpoint);
  if (canonicalEndpoints.some((endpoint) => endpoint === null)) {
    issues.push("branch enforcement apiEndpoints must use exact official GitHub API endpoints");
  }
  if (new Set(canonicalEndpoints.filter(nonBlank)).size !== canonicalEndpoints.filter(nonBlank).length) {
    issues.push("branch enforcement apiEndpoints must not contain duplicates");
  }
  for (const required of REQUIRED_API_ENDPOINTS) {
    if (!canonicalEndpoints.includes(required)) {
      issues.push(`branch enforcement apiEndpoints missing: ${required}`);
    }
  }

  const responses = Array.isArray(root.apiResponses) ? root.apiResponses : [];
  if (!Array.isArray(root.apiResponses)) issues.push("branch enforcement apiResponses must be an array");
  const seenResponses = new Set<string>();
  for (const [index, value] of responses.entries()) {
    const response = requireRecord(value, `branch enforcement API response ${index + 1}`, issues);
    unsupported(response, RESPONSE_KEYS, `branch enforcement API response ${index + 1}`, issues);
    const endpoint = canonicalApiEndpoint(response.endpoint);
    if (!endpoint) issues.push(`branch enforcement API response ${index + 1} endpoint must be an exact official GitHub API endpoint`);
    else if (seenResponses.has(endpoint)) issues.push(`duplicate branch enforcement API response: ${endpoint}`);
    else seenResponses.add(endpoint);
    if (response.method !== "GET") issues.push(`branch enforcement API response ${index + 1} method must equal GET`);
    if (response.httpStatus !== 200) issues.push(`branch enforcement API response ${index + 1} httpStatus must equal 200`);
    if (!timestamp(response.capturedAt)) {
      issues.push(`branch enforcement API response ${index + 1} capturedAt must be a canonical UTC ISO timestamp`);
    } else if (timestamp(root.capturedAt)) {
      const delta = Math.abs(Date.parse(response.capturedAt) - Date.parse(root.capturedAt));
      if (delta > 60 * 60 * 1000) issues.push(`branch enforcement API response ${index + 1} must be captured within one hour of the record`);
      if (Date.parse(response.capturedAt) > options.now.valueOf()) {
        issues.push(`branch enforcement API response ${index + 1} capturedAt must not be in the future`);
      }
    }
    requireText(response.requestId, `branch enforcement API response ${index + 1} requestId`, issues);
    if (!Number.isInteger(response.pageCount) || Number(response.pageCount) < 1) {
      issues.push(`branch enforcement API response ${index + 1} pageCount must be a positive integer`);
    }
    if (response.paginationComplete !== true) {
      issues.push(`branch enforcement API response ${index + 1} paginationComplete must equal true`);
    }
    if (!sha256(response.bodySha256)) {
      issues.push(`branch enforcement API response ${index + 1} bodySha256 must be a non-placeholder SHA-256`);
    }
  }
  for (const required of REQUIRED_API_ENDPOINTS) {
    if (!seenResponses.has(required)) issues.push(`missing branch enforcement API response: ${required}`);
  }

  const evidence = requireRecord(root.evidence, "branch enforcement evidence metadata", issues);
  unsupported(evidence, EVIDENCE_KEYS, "branch enforcement evidence metadata", issues);
  requireText(evidence.restrictedArtifactId, "branch enforcement restrictedArtifactId", issues);
  if (!sha256(evidence.artifactSha256)) issues.push("branch enforcement artifactSha256 must be a non-placeholder SHA-256");
  requireText(evidence.safeReference, "branch enforcement safeReference", issues);
  if (!nonBlank(evidence.rulesetReference) || !/^TN-RULESET-\d{4}-\d{3,}$/.test(evidence.rulesetReference)) {
    issues.push("branch enforcement rulesetReference must match TN-RULESET-YYYY-NNN");
  }

  const codeowners = requireRecord(root.codeowners, "branch enforcement codeowners", issues);
  unsupported(codeowners, CODEOWNERS_KEYS, "branch enforcement codeowners", issues);
  if (codeowners.path !== REQUIRED_CODEOWNERS_PATH) {
    issues.push("branch enforcement codeowners path must equal .github/CODEOWNERS");
  }
  if (codeowners.coverage !== "all_repository_paths") {
    issues.push("branch enforcement codeowners coverage must equal all_repository_paths");
  }
  const ownerTokens = Array.isArray(codeowners.ownerTokens) ? codeowners.ownerTokens : [];
  if (
    !Array.isArray(codeowners.ownerTokens)
    || ownerTokens.length === 0
    || ownerTokens.some((owner) => !nonBlank(owner) || !/^@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9_.-]+)?$/.test(owner))
  ) {
    issues.push("branch enforcement codeowners ownerTokens must contain GitHub user or team handles");
  }
  if (!sha256(codeowners.sourceSha256)) {
    issues.push("branch enforcement codeowners sourceSha256 must be a non-placeholder SHA-256");
  }
  if (options.codeownersText === undefined) {
    issues.push("branch enforcement CODEOWNERS source must be provided for verification");
  } else {
    if (sha256Text(options.codeownersText) !== String(codeowners.sourceSha256).toLowerCase()) {
      issues.push("branch enforcement CODEOWNERS source hash does not match");
    }
    const rootRule = codeownersRootRule(options.codeownersText);
    if (!rootRule || rootRule.pattern !== "*") {
      issues.push("branch enforcement CODEOWNERS final active rule must cover all repository paths");
    } else {
      const declared = new Set(ownerTokens.map(String));
      const actual = new Set(rootRule.owners);
      if (declared.size !== actual.size || [...declared].some((owner) => !actual.has(owner))) {
        issues.push("branch enforcement CODEOWNERS ownerTokens must match the final all-path rule");
      }
    }
  }

  const rules = requireRecord(root.rules, "branch enforcement rules", issues);
  unsupported(rules, RULE_KEYS, "branch enforcement rules", issues);
  if (rules.enforcement !== "active") issues.push("branch enforcement must be active");
  if (rules.targetBranch !== "refs/heads/main") issues.push("branch enforcement targetBranch must equal refs/heads/main");
  for (const field of [
    "requirePullRequest",
    "dismissStaleReviews",
    "requireCodeOwnerReview",
    "requireLastPushApproval",
    "requireConversationResolution",
    "requireStatusChecks",
    "requireBranchesUpToDate",
    "enforceAdmins",
    "restrictDirectPushes",
    "blockForcePushes",
    "blockDeletions"
  ] as const) {
    if (rules[field] !== true) issues.push(`branch enforcement ${field} must equal true`);
  }
  if (!Number.isInteger(rules.requiredApprovals) || Number(rules.requiredApprovals) < 1) {
    issues.push("branch enforcement requiredApprovals must be an integer of at least 1");
  }
  if (!Array.isArray(rules.bypassActors) || rules.bypassActors.length > 0) {
    issues.push("branch enforcement bypassActors must be an empty array");
  }

  const checks = Array.isArray(rules.requiredChecks) ? rules.requiredChecks : [];
  if (!Array.isArray(rules.requiredChecks)) issues.push("branch enforcement requiredChecks must be an array");
  const seenChecks = new Set<string>();
  const integrationIds = new Set<number>();
  for (const [index, value] of checks.entries()) {
    const check = requireRecord(value, `branch enforcement check ${index + 1}`, issues);
    unsupported(check, CHECK_KEYS, `branch enforcement check ${index + 1}`, issues);
    const expected = REQUIRED_BRANCH_CHECKS.find((item) => item.id === check.id);
    if (!expected) issues.push(`branch enforcement check ${index + 1} has invalid id`);
    else if (seenChecks.has(expected.id)) issues.push(`duplicate branch enforcement check id: ${expected.id}`);
    else {
      seenChecks.add(expected.id);
      if (check.workflow !== expected.workflow) issues.push(`branch enforcement ${expected.id} workflow does not match`);
      if (check.jobName !== expected.jobName) issues.push(`branch enforcement ${expected.id} jobName does not match`);
      if (check.context !== expected.jobName) issues.push(`branch enforcement ${expected.id} context does not match`);
      if (!Number.isInteger(check.integrationId) || Number(check.integrationId) < 1) {
        issues.push(`branch enforcement ${expected.id} integrationId must be a positive integer`);
      } else integrationIds.add(Number(check.integrationId));
      if (check.required !== true) issues.push(`branch enforcement ${expected.id} must be required`);
    }
  }
  for (const expected of REQUIRED_BRANCH_CHECKS) {
    if (!seenChecks.has(expected.id)) issues.push(`missing required branch check: ${expected.id}`);
  }
  if (integrationIds.size > 1) issues.push("branch enforcement checks must use one GitHub Actions integrationId");

  const enforcementTests = Array.isArray(root.enforcementTests) ? root.enforcementTests : [];
  if (!Array.isArray(root.enforcementTests)) issues.push("branch enforcement enforcementTests must be an array");
  const seenTestIds = new Set<string>();
  const seenTargetReferences = new Set<string>();
  const seenTestArtifacts = new Set<string>();
  let latestTestReview = 0;
  for (const [index, value] of enforcementTests.entries()) {
    const test = requireRecord(value, `branch enforcement test ${index + 1}`, issues);
    unsupported(test, ENFORCEMENT_TEST_KEYS, `branch enforcement test ${index + 1}`, issues);
    const expected = REQUIRED_BRANCH_ENFORCEMENT_TESTS.find((item) => item.id === test.id);
    if (!expected) {
      issues.push(`branch enforcement test ${index + 1} has invalid id`);
    } else if (seenTestIds.has(expected.id)) {
      issues.push(`duplicate branch enforcement test id: ${expected.id}`);
    } else {
      seenTestIds.add(expected.id);
      if (test.expectedResult !== expected.expectedResult) {
        issues.push(`branch enforcement ${expected.id} expectedResult must equal ${expected.expectedResult}`);
      }
      if (test.actualResult !== expected.expectedResult) {
        issues.push(`branch enforcement ${expected.id} actualResult must equal ${expected.expectedResult}`);
      }
      const exercisedCheckIds = Array.isArray(test.exercisedCheckIds) ? test.exercisedCheckIds : [];
      if (!Array.isArray(test.exercisedCheckIds)) {
        issues.push(`branch enforcement ${expected.id} exercisedCheckIds must be an array`);
      } else if (expected.id === "denied_missing_required_check") {
        const requiredIds = REQUIRED_BRANCH_CHECKS.map((check) => check.id);
        if (
          exercisedCheckIds.length !== requiredIds.length
          || new Set(exercisedCheckIds).size !== requiredIds.length
          || requiredIds.some((id) => !exercisedCheckIds.includes(id))
        ) {
          issues.push("branch enforcement denied_missing_required_check must exercise every required check exactly once");
        }
      } else if (exercisedCheckIds.length > 0) {
        issues.push(`branch enforcement ${expected.id} exercisedCheckIds must be empty`);
      }
    }
    if (!timestamp(test.executedAt)) {
      issues.push(`branch enforcement test ${index + 1} executedAt must be a canonical UTC ISO timestamp`);
    } else {
      if (timestamp(root.capturedAt) && Date.parse(test.executedAt) < Date.parse(root.capturedAt)) {
        issues.push(`branch enforcement test ${index + 1} executedAt must not precede capturedAt`);
      }
      if (Date.parse(test.executedAt) > options.now.valueOf()) {
        issues.push(`branch enforcement test ${index + 1} executedAt must not be in the future`);
      }
      if (timestamp(root.capturedAt) && Date.parse(test.executedAt) - Date.parse(root.capturedAt) > 24 * 60 * 60 * 1000) {
        issues.push(`branch enforcement test ${index + 1} must execute within 24 hours of the configuration capture`);
      }
    }
    requireText(test.executedBy, `branch enforcement test ${index + 1} executedBy`, issues);
    requireText(test.reviewedBy, `branch enforcement test ${index + 1} reviewedBy`, issues);
    if (identity(test.executedBy) && identity(test.executedBy) === identity(test.reviewedBy)) {
      issues.push(`branch enforcement test ${index + 1} executor and reviewer must be distinct`);
    }
    if (!timestamp(test.reviewedAt)) {
      issues.push(`branch enforcement test ${index + 1} reviewedAt must be a canonical UTC ISO timestamp`);
    } else {
      latestTestReview = Math.max(latestTestReview, Date.parse(test.reviewedAt));
      if (timestamp(test.executedAt) && Date.parse(test.reviewedAt) < Date.parse(test.executedAt)) {
        issues.push(`branch enforcement test ${index + 1} reviewedAt must not precede executedAt`);
      }
      if (Date.parse(test.reviewedAt) > options.now.valueOf()) {
        issues.push(`branch enforcement test ${index + 1} reviewedAt must not be in the future`);
      }
    }
    if (!nonBlank(test.targetReference) || !/^TN-BRANCH-TARGET-\d{4}-\d{3,}$/.test(test.targetReference)) {
      issues.push(`branch enforcement test ${index + 1} targetReference must match TN-BRANCH-TARGET-YYYY-NNN`);
    } else if (seenTargetReferences.has(test.targetReference)) {
      issues.push(`duplicate branch enforcement test targetReference: ${test.targetReference}`);
    } else seenTargetReferences.add(test.targetReference);
    if (!nonBlank(test.restrictedArtifactId) || !/^TN-BRANCH-RECEIPT-\d{4}-\d{3,}$/.test(test.restrictedArtifactId)) {
      issues.push(`branch enforcement test ${index + 1} restrictedArtifactId must match TN-BRANCH-RECEIPT-YYYY-NNN`);
    } else if (seenTestArtifacts.has(test.restrictedArtifactId)) {
      issues.push(`duplicate branch enforcement test restrictedArtifactId: ${test.restrictedArtifactId}`);
    } else seenTestArtifacts.add(test.restrictedArtifactId);
    if (!sha256(test.artifactSha256)) {
      issues.push(`branch enforcement test ${index + 1} artifactSha256 must be a non-placeholder SHA-256`);
    }
    if (!sha256(test.configurationArtifactSha256) || test.configurationArtifactSha256 !== evidence.artifactSha256) {
      issues.push(`branch enforcement test ${index + 1} configurationArtifactSha256 must match the captured configuration artifact`);
    }
    if (test.rulesetReference !== evidence.rulesetReference) {
      issues.push(`branch enforcement test ${index + 1} rulesetReference must match the captured ruleset reference`);
    }
  }
  for (const expected of REQUIRED_BRANCH_ENFORCEMENT_TESTS) {
    if (!seenTestIds.has(expected.id)) issues.push(`missing required branch enforcement test: ${expected.id}`);
  }

  if (!Array.isArray(root.gaps) || root.gaps.some((gap) => !nonBlank(gap) || PLACEHOLDER.test(gap))) {
    issues.push("branch enforcement gaps must be an array of non-placeholder strings");
  }
  if (root.decision !== "accepted") issues.push("branch enforcement decision must equal accepted");
  if (root.decision === "accepted" && Array.isArray(root.gaps) && root.gaps.length > 0) {
    issues.push("accepted branch enforcement evidence requires no gaps");
  }

  const signoffs = Array.isArray(root.signoffs) ? root.signoffs : [];
  if (!Array.isArray(root.signoffs)) issues.push("branch enforcement signoffs must be an array");
  const requiredRoles = new Set(["engineering_owner", "security_reviewer"]);
  const roles = new Set<string>();
  const identities = new Set<string>();
  for (const [index, value] of signoffs.entries()) {
    const signoff = requireRecord(value, `branch enforcement signoff ${index + 1}`, issues);
    unsupported(signoff, SIGNOFF_KEYS, `branch enforcement signoff ${index + 1}`, issues);
    if (!requiredRoles.has(String(signoff.role))) issues.push(`branch enforcement signoff ${index + 1} role is invalid`);
    else if (roles.has(String(signoff.role))) issues.push(`duplicate branch enforcement signoff role: ${String(signoff.role)}`);
    else roles.add(String(signoff.role));
    requireText(signoff.identity, `branch enforcement signoff ${index + 1} identity`, issues);
    const normalized = identity(signoff.identity);
    if (normalized && identities.has(normalized)) issues.push("branch enforcement signoff identities must be distinct");
    if (normalized) identities.add(normalized);
    if (normalized && normalized === identity(root.capturedBy)) issues.push("branch enforcement capturer cannot approve the evidence");
    if (signoff.decision !== "accepted") issues.push(`branch enforcement signoff ${index + 1} decision must equal accepted`);
    if (!timestamp(signoff.reviewedAt)) issues.push(`branch enforcement signoff ${index + 1} reviewedAt must be a canonical UTC ISO timestamp`);
    else {
      if (timestamp(root.capturedAt) && Date.parse(signoff.reviewedAt) < Date.parse(root.capturedAt)) {
        issues.push(`branch enforcement signoff ${index + 1} reviewedAt must not precede capturedAt`);
      }
      if (Date.parse(signoff.reviewedAt) > options.now.valueOf()) {
        issues.push(`branch enforcement signoff ${index + 1} reviewedAt must not be in the future`);
      }
      if (latestTestReview > 0 && Date.parse(signoff.reviewedAt) < latestTestReview) {
        issues.push(`branch enforcement signoff ${index + 1} reviewedAt must not precede enforcement-test review`);
      }
    }
    requireText(signoff.evidenceReference, `branch enforcement signoff ${index + 1} evidenceReference`, issues);
  }
  for (const role of requiredRoles) if (!roles.has(role)) issues.push(`missing branch enforcement signoff role: ${role}`);

  return {
    issues,
    structurallyAccepted: issues.length === 0 && root.decision === "accepted"
  };
}
