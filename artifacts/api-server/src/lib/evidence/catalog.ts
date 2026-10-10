import { canonicalJson, sha256Hex } from "./canonical.js";

/**
 * The evidence check catalog (docs/security/evidence-harness.md).
 *
 * Each check names the NIST SP 800-53 Rev. 5 controls (unpadded, as in the
 * SSP: "AU-9(4)") and the SP 800-53A determination statements (as NIST labels
 * them: "AU-09(04)", "CM-03b.[01]") its receipt is evidence for. Every label
 * is checked against nist-800-53r5-moderate.json, generated from NIST's OSCAL
 * Moderate baseline by scripts/src/evidence-nist-ids.ts.
 *
 * A check states what it observes and when it passes. It does not state
 * whether it is expected to fail: known, accepted failures are linked to POA&M
 * items in the private evidence_known_gaps table, never in this public file.
 *
 * Cadences are proposals until the owner approves the organization-defined
 * parameter values (cadenceStatus "proposed").
 */

export type CheckKind =
  | "github"
  | "external"
  | "database"
  | "synthetic"
  | "attestation"
  | "operator"
  | "integrity"
  | "summary";

export type Cadence = "daily" | "monthly" | "quarterly" | "annual";

export interface CheckDefinition {
  id: string;
  kind: CheckKind;
  title: string;
  controls: string[];
  objectives: string[];
  cadence: Cadence;
  cadenceStatus: "proposed" | "approved";
  /** What the check observes and the exact pass condition. */
  passCondition: string;
  /** What a pass does not prove. */
  limits?: string;
}

/** Stated on every receipt and summary (owner decision Q35). */
export const ASSESSMENT_STATEMENT =
  "Self-assessment. Receipts are produced by the system under test and its operator; " +
  "independent assessment (CA-2(1)) is not met.";

export const EVIDENCE_CHECKS: readonly CheckDefinition[] = [
  {
    id: "github.branch-ruleset",
    kind: "github",
    title: "Default-branch ruleset requires pull requests and CI",
    controls: ["CM-3", "CM-3(2)", "CM-5", "SA-10"],
    objectives: [
      "CM-03b.[01]",
      "CM-03c.",
      "CM-03(02)[01]",
      "CM-03(02)[02]",
      "CM-05[06]",
      "SA-10b.[03]",
      "SA-10c."
    ],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "An active ruleset targets the default branch with deletion, non_fast_forward, pull_request " +
      "and required_status_checks rules; every required check in REQUIRED_STATUS_CHECKS is listed; " +
      "no bypass actor has bypass_mode 'always'.",
    limits:
      "Shows the rules GitHub enforces, not that every merged change was reviewed; " +
      "required approvals are recorded but not required (single maintainer)."
  },
  {
    id: "github.code-security-settings",
    kind: "github",
    title: "Secret scanning, push protection and Dependabot alerts are on",
    controls: ["RA-5", "SI-2"],
    objectives: ["RA-05a.[01]", "RA-05f.", "SI-02a.[01]"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "Repository security_and_analysis reports secret_scanning and secret_scanning_push_protection " +
      "enabled, and the vulnerability-alerts endpoint returns 204 (Dependabot alerts enabled). " +
      "Dependabot security updates and other optional settings are recorded, not required."
  },
  {
    id: "github.open-alerts",
    kind: "github",
    title: "No overdue critical or high alerts",
    controls: ["RA-5", "SI-2"],
    objectives: ["RA-05c.", "RA-05d.", "SI-02a.[03]", "SI-02c.[01]"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "No open secret-scanning alert, and no open critical or high Dependabot or code-scanning alert " +
      "older than ALERT_REMEDIATION_DAYS (proposed value 30) days. Counts by severity and age are recorded.",
    limits: "The remediation window is a proposed parameter value until approved."
  },
  {
    id: "github.security-workflow",
    kind: "github",
    title: "Security workflow runs on schedule and passes",
    controls: ["CA-7", "SA-11", "RA-5"],
    objectives: ["CA-07c.", "CA-07d.", "SA-11c.[01]", "SA-11c.[02]", "RA-05a.[02]"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "The latest completed scheduled run of .github/workflows/security.yml on the default branch " +
      "concluded success and started within the last 8 days, and the latest completed push run on " +
      "the default branch concluded success. Runs still in progress, and runs cancelled because a " +
      "newer run on the same branch superseded them, are skipped."
  },
  {
    id: "github.credential-expiry",
    kind: "github",
    title: "Harness GitHub token is valid for 30 more days",
    controls: ["CA-7"],
    objectives: ["CA-07[02]"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "The read-only token answers GET /repos/{repo} and its github-authentication-token-expiration " +
      "header (when present) is at least 30 days away.",
    limits: "Proves the harness can keep collecting GitHub evidence; proves nothing about the repository."
  },
  {
    id: "external.tls",
    kind: "external",
    title: "TLS 1.2+ with a valid certificate; TLS 1.0 and 1.1 refused",
    controls: ["SC-8", "SC-8(1)", "SC-13", "SC-17"],
    objectives: ["SC-08", "SC-08(01)", "SC-13b.", "SC-17a."],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "A handshake to each public host on 443 negotiates TLSv1.2 or TLSv1.3 with a certificate that " +
      "chains to the Node trust store, matches the host name and expires in 14 or more days; the " +
      "server refuses a handshake capped at TLSv1.1 with a TLS alert. A legacy handshake that fails " +
      "any other way (timeout, reset, local refusal) is recorded as error.",
    limits: "Run from inside Railway's network by the worker and from GitHub's network by the watcher."
  },
  {
    id: "external.http-redirect",
    kind: "external",
    title: "Plain HTTP and www redirect to https://truenote.org",
    controls: ["SC-8", "CM-6"],
    objectives: ["SC-08", "CM-06b."],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "http://truenote.org/ and http://www.truenote.org/ answer 301, 302, 307 or 308 with an https " +
      "Location, and https://www.truenote.org/ redirects to https://truenote.org/."
  },
  {
    id: "external.security-headers",
    kind: "external",
    title: "Security response headers",
    controls: ["CM-6", "SC-8"],
    objectives: ["CM-06b.", "SC-08"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "https://truenote.org/ sends Strict-Transport-Security with max-age of at least 31536000 and " +
      "includeSubDomains, X-Content-Type-Options nosniff, X-Frame-Options DENY or a CSP " +
      "frame-ancestors 'none', a Referrer-Policy, a Permissions-Policy, and no X-Powered-By."
  },
  {
    id: "external.csp",
    kind: "external",
    title: "Content Security Policy restricts scripts and framing",
    controls: ["SC-18", "CM-6"],
    objectives: ["SC-18b.[03]", "CM-06b."],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "The Content-Security-Policy on https://truenote.org/ has default-src, object-src 'none', " +
      "base-uri, frame-ancestors 'none', and a script-src without 'unsafe-inline' or 'unsafe-eval'."
  },
  {
    id: "external.security-txt",
    kind: "external",
    title: "security.txt publishes a contact and is not expired",
    controls: ["RA-5(11)"],
    objectives: ["RA-05(11)"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "https://truenote.org/.well-known/security.txt answers 200 with a Contact field and an Expires " +
      "date at least 30 days away."
  },
  {
    id: "external.dns-caa",
    kind: "external",
    title: "CAA records limit certificate issuance",
    controls: ["SC-17", "CM-6"],
    objectives: ["SC-17a.", "CM-06b."],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "truenote.org has at least one CAA issue record. The records and the A, AAAA and CNAME answers " +
      "for the public hosts are recorded."
  },
  {
    id: "external.health",
    kind: "external",
    title: "Public health endpoint answers",
    controls: ["CA-7"],
    objectives: ["CA-07d."],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "GET https://truenote.org/health answers 200 with {\"ok\":true} within 10 seconds; latency is recorded."
  },
  {
    id: "database.runtime-role",
    kind: "database",
    title: "Runtime database role is least-privilege",
    controls: ["AC-6", "AC-6(10)", "AU-9(4)"],
    objectives: ["AC-06", "AC-06(10)", "AU-09(04)"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "The worker connects as truenote_app, which is not superuser and cannot create roles, databases " +
      "or replication connections or bypass row security; owns no objects; has no CREATE on the " +
      "database, public or pgboss and no TEMPORARY; holds no TRUNCATE, REFERENCES or TRIGGER on any " +
      "table; holds only SELECT on security_events and evidence_receipts; and has no access to " +
      "schema_migrations.",
    limits:
      "Run as the role being checked. Owner-side checks run in the monthly operator check."
  },
  {
    id: "database.audit-triggers",
    kind: "database",
    title: "Audit triggers and append functions are in place",
    controls: ["AU-9", "AU-12"],
    objectives: ["AU-09a.", "AU-12c."],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "Every trigger in REQUIRED_TRIGGERS exists and is enabled, and append_security_event and " +
      "append_evidence_receipt are SECURITY DEFINER, pin search_path and are owned by a superuser. " +
      "sha256 of each function definition is recorded."
  },
  {
    id: "database.append-only-refusals",
    kind: "database",
    title: "Runtime role cannot change audit or evidence rows",
    controls: ["AU-9", "AU-9(4)", "AC-6"],
    objectives: ["AU-09a.", "AU-09(04)", "AC-06"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "Inside a transaction that is rolled back, each statement in REFUSAL_PROBES fails with " +
      "SQLSTATE 42501 (insufficient privilege). Every probe targets zero rows.",
    limits: "Shows the runtime role is refused; the owner's refusal is proven by the monthly operator check."
  },
  {
    id: "integrity.evidence-chain",
    kind: "integrity",
    title: "Evidence receipt chain verifies",
    controls: ["AU-9", "SI-7(1)"],
    objectives: ["AU-09a.", "SI-07(01)[01]"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "For every evidence receipt, payload_sha256 equals sha256(payload), previous_hash equals the " +
      "prior receipt's receipt_hash, and receipt_hash recomputes."
  },
  {
    id: "integrity.security-events-chain",
    kind: "integrity",
    title: "Security event chain verifies",
    controls: ["AU-9", "SI-7(1)"],
    objectives: ["AU-09a.", "SI-07(01)[01]"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "For every security_events row, previous_hash equals the prior row's event_hash and event_hash " +
      "recomputes with the rule in append_security_event."
  },
  {
    id: "integrity.chain-timestamp",
    kind: "integrity",
    title: "Evidence chain head carries a trusted timestamp",
    controls: ["AU-9"],
    objectives: ["AU-09a."],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "An RFC 3161 time-stamping authority in TIMESTAMP_AUTHORITIES grants a token (PKIStatus 0 or 1) " +
      "whose TSTInfo imprint is the sha256 chain head and whose nonce is ours, whose CMS signature and " +
      "message digest verify, whose signer has the timeStamping key usage and chains to a pinned root " +
      "in TSA_TRUST_ANCHORS. The token is stored base64 in the receipt for offline verification with " +
      "`openssl ts -verify`.",
    limits:
      "Proves the chain head existed by the token's time. Only the hash leaves the system."
  }
];

export function getCheck(id: string): CheckDefinition | undefined {
  return EVIDENCE_CHECKS.find((check) => check.id === id);
}

/** sha256 of the catalog as served; recorded on every receipt. */
export const CATALOG_VERSION = sha256Hex(canonicalJson(EVIDENCE_CHECKS));
