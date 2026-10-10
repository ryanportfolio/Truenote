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
      "the default branch concluded success. Runs still in progress, and cancelled runs that a newer " +
      "run on the same branch superseded, are skipped; a cancelled newest run fails. If no completed " +
      "run is found in the latest 100, the check records error."
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
    id: "synthetic.program-isolation",
    kind: "synthetic",
    title: "A CSR cannot reach another program's documents or sessions",
    controls: ["AC-3", "AC-4", "SC-4"],
    objectives: ["AC-03", "AC-04", "SC-04"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "The database shows canaries a and b live (active version, lifecycle_state active, is_active) in two " +
      "different synthetic programs; users csr-a and csr-b exist, are synthetic, and sit in canary a's and " +
      "canary b's program respectively; and b's classification is at or below csr-a's max_classification. " +
      "Otherwise the check records error. Over HTTPS, synthetic csr-b " +
      "logs in and asks with canary b's token: the answer cites b (positive control) and returns a session id. " +
      "Synthetic csr-a logs in, asks with canary a's token and gets a as a source, and GET " +
      "/api/kb/documents/<a> answers 200 (positive controls). Then, as csr-a: asking with canary b's token " +
      "returns no source with b's doc_id, no source whose excerpt or doc_title holds b's token, and no answer " +
      "text holding it; GET /api/kb/documents/<b> answers 404; and GET /api/sessions/<csr-b's " +
      "session id> answers 404. A leak in any of the three probes fails and names the response field; a " +
      "failed login, a missed positive control or an unexpected status records error. Every session is " +
      "logged out; a logout still failed (non-2xx or no response) after one retry turns a pass into error " +
      "and leaves a fail a fail.",
    limits:
      "Probes one pair of synthetic programs with one canary each, through the public API, run by the system " +
      "under test. It does not prove isolation for every query, document or route."
  },
  {
    id: "synthetic.classification-ceiling",
    kind: "synthetic",
    title: "A CSR cannot read documents above their clearance",
    controls: ["AC-3", "AC-4"],
    objectives: ["AC-03", "AC-04"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "The database shows canary aConfidential live (active version, lifecycle_state active, is_active) in " +
      "the same synthetic program as canary a, and user csr-a synthetic, in that program, with a " +
      "max_classification below aConfidential's classification. Otherwise the check records error. Synthetic " +
      "csr-a logs in, asks with canary a's token and gets a as a source, and GET " +
      "/api/kb/documents/<a> answers 200 (positive controls). Then asking with aConfidential's token returns " +
      "no source with its doc_id, no source whose excerpt or doc_title holds its token, and no answer text " +
      "holding it, and GET /api/kb/documents/<aConfidential> answers 404. Either leak fails and names the " +
      "response field; a failed login, a missed positive control or an unexpected status records error. " +
      "Every session is logged out; a logout still failed (non-2xx or no response) after one retry turns a " +
      "pass into error and leaves a fail a fail.",
    limits:
      "Probes csr-a's one clearance level against one canary above it. It does not test other " +
      "clearance levels, and checks run as the system under test."
  },
  {
    id: "synthetic.demo-write-block",
    kind: "synthetic",
    title: "Published demo accounts cannot write",
    controls: ["AC-3", "AC-6"],
    objectives: ["AC-03", "AC-06"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "GET /api/config lists no demoAccounts (pass: nothing to block), or the published demo account with " +
      "role manager logs in and POST /api/documents/upload with no body answers 403 with code demo_account. " +
      "A 2xx, or a 4xx other than 401, 403, 408, 423 or 429 (the handler answered, so the request got past the " +
      "block), fails. No manager demo account (a csr is refused by the role check, which does not prove the " +
      "demo block), a failed login, or any other status (401, 403 without demo_account, 408, 423 from the " +
      "password-reset guard that runs before the demo block, 429, 5xx, no response) records error. The " +
      "session is logged out; a logout still failed (non-2xx or no response) after one retry turns a pass " +
      "into error and leaves a fail a fail.",
    limits:
      "Probes the upload route only, with an empty request that the block refuses before body parsing; " +
      "other write routes rely on the same middleware but are not probed."
  },
  {
    id: "synthetic.bad-password-refused",
    kind: "synthetic",
    title: "Login refuses a wrong password",
    controls: ["IA-2"],
    objectives: ["IA-02"],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "Positive control first: synthetic csr-a logs in with its right password and must get 200 with a session " +
      "cookie, then logs out. Anything else (such as the 401 every csr login gets when LOCAL_LOGIN_MODE refuses " +
      "local login for CSRs), or a control logout still failed (non-2xx or no response) after one retry, records " +
      "error before any wrong password is sent, because a refused wrong password would then prove nothing. Then " +
      "exactly one POST /api/auth/login for csr-a with a random wrong password must answer 401. A 200 fails (the " +
      "session is logged out; a logout still failed after one retry is listed but leaves the fail a fail); any " +
      "other status (such as 400, 429 or 5xx) or no response records error.",
    limits:
      "Proves refusal of one wrong password only. It does not prove account lockout or throttling after " +
      "repeated failures (AC-7): the per-account lock needs 5 consecutive failures by default, and the " +
      "control login's success resets the count before the single wrong password. Nor does it prove password " +
      "strength rules (IA-5(1)) or multi-factor authentication. Checks run as the system under test."
  },
  {
    id: "synthetic.login-windows",
    kind: "synthetic",
    title: "Synthetic accounts log in only during harness runs",
    controls: ["AC-2", "AU-6", "SI-4"],
    objectives: ["AC-02g.", "AU-06a.", "SI-04b."],
    cadence: "daily",
    cadenceStatus: "proposed",
    passCondition:
      "Every security_events row from the last 8 days with action auth.local.login, auth.break_glass.login " +
      "or auth.oidc.login whose actor is a current user with is_synthetic, or whose actor_email ends in " +
      ".invalid in any letter case (a synthetic user deleted since; the fence in 0019_synthetic_fence.sql " +
      "gives synthetic users, and only them, such emails), whatever its outcome, falls between " +
      "startedAt minus 2 minutes and finishedAt plus 2 minutes of some synthetic evidence receipt recorded in " +
      "the same period. That covers logins (outcome success) and refused login attempts recorded under those " +
      "actions (outcome denied, such as a refusal by LOCAL_LOGIN_MODE or by an account lock); a refused " +
      "attempt with a synthetic account outside a run is flagged too. A plain wrong password records no such " +
      "row and is not counted. Any row outside every window fails and is listed by time, email and outcome. " +
      "No such rows passes. Reads only the database, so it runs without the synthetic account configuration.",
    limits:
      "Relies on the audit log and the receipts written by the same system. Use of the synthetic credentials " +
      "during a harness run cannot be told apart from the harness itself."
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
  },
  // Attestations: proof the owner supplies through POST /api/admin/evidence/attestations/:checkId.
  // They have no runner; the daily run only reminds the owner when one is due (attestations.ts).
  {
    id: "attestation.operator-mfa",
    kind: "attestation",
    title: "Operator accounts require multi-factor authentication",
    controls: ["IA-2(1)"],
    objectives: ["IA-02(01)"],
    cadence: "quarterly",
    cadenceStatus: "proposed",
    passCondition:
      "The owner uploads screenshots or exported reports of the sign-in security settings of every account " +
      "that can change the deployed system or its data (hosting, source control and CI, the identity provider " +
      "tenant, DNS, and the mailbox that receives security alerts), each showing multi-factor authentication " +
      "enabled or required for the operator's account, with the date visible, and a statement naming the " +
      "accounts covered. A pass is the owner's own statement with those files; the receipt records the " +
      "sha256 of each file.",
    limits:
      "Self-attested by the owner; the harness does not read the files' content. A screenshot shows a setting " +
      "at one moment, not that it stayed on between attestations, and covers only the accounts it shows."
  },
  {
    id: "attestation.workstation-patch-malware",
    kind: "attestation",
    title: "Operator workstation is patched and anti-malware is current",
    controls: ["SI-2", "SI-3"],
    objectives: ["SI-02c.", "SI-03b.", "SI-03c.01"],
    cadence: "monthly",
    cadenceStatus: "proposed",
    passCondition:
      "For each workstation used to administer the system, the owner uploads its operating system update " +
      "status (no pending security update, date of the last install) and its anti-malware status (real-time " +
      "protection on, signature version and date, date and result of the last scan), with the date visible, " +
      "and a statement naming the workstations. A pass is the owner's own statement with those files; the " +
      "receipt records the sha256 of each file.",
    limits:
      "Self-attested by the owner; the harness does not read the files' content. Shows the state on the day " +
      "of the capture only, and only for the workstations the statement names."
  },
  {
    id: "attestation.access-review",
    kind: "attestation",
    title: "Accounts and privileges are reviewed",
    controls: ["AC-2", "AC-6(7)"],
    objectives: ["AC-02j.", "AC-06(07)(a)", "AC-06(07)(b)"],
    cadence: "quarterly",
    cadenceStatus: "proposed",
    passCondition:
      "The owner uploads the review record: the list of Truenote user accounts with their roles and programs, " +
      "and the operator accounts on the hosting, source control and identity provider platforms, as reviewed, " +
      "with each account marked kept, changed or removed, and a statement giving the review date and the " +
      "changes made. A pass is the owner's own statement with those files; the receipt records the sha256 of " +
      "each file.",
    limits:
      "Self-attested by the owner; the harness does not read the files' content or compare the list with the " +
      "database. Proves that a review was recorded, not that every account was assessed correctly."
  },
  {
    id: "attestation.policy-review",
    kind: "attestation",
    title: "Security policies and plans are reviewed",
    controls: ["PL-1", "PL-2", "IR-1", "CP-2"],
    objectives: ["PL-01c.01[01]", "PL-01c.02[01]", "PL-02c.", "IR-01c.02[01]", "CP-02d."],
    cadence: "annual",
    cadenceStatus: "proposed",
    passCondition:
      "The owner uploads the review record of the security policy set, the system security plan, the incident " +
      "response plan and the contingency plan: for each document, the version reviewed, the review date, the " +
      "reviewer and whether it changed, and a statement naming each document and the outcome. A pass is the " +
      "owner's own statement with those files; the receipt records the sha256 of each file.",
    limits:
      "Self-attested by the owner; the harness does not read the files' content. Proves that a review was " +
      "recorded, not its quality, and covers only the documents the statement names."
  },
  // The operator check has no runner: the owner runs scripts/src/evidence-operator.ts as the
  // migration role, and only that role can append a receipt of kind operator (0020_operator_receipts.sql).
  {
    id: "operator.monthly-verification",
    kind: "operator",
    title: "Owner-run check of the database controls and the append-only triggers",
    controls: ["AU-9", "CM-6", "CA-7"],
    objectives: ["AU-09a.", "CM-06b.", "CA-07d."],
    cadence: "monthly",
    cadenceStatus: "proposed",
    passCondition:
      "Connected as a superuser or a member of the owner of evidence_receipts, the script runs " +
      "docs/compliance/pci/production-control-verification.sql with truenote.evidence_runtime_role set to the " +
      "runtime role (truenote_app unless overridden), and every control row it returns (at least one) has passed " +
      "true. Then, in one transaction that always ends in ROLLBACK, an UPDATE and a DELETE aimed at the newest row " +
      "and a TRUNCATE, each in its own savepoint, run on evidence_receipts and on security_events, and all six " +
      "statements are refused (raise an error). On an empty table the UPDATE and DELETE have no row to aim at and " +
      "count as not refused; a lock or statement timeout stops the run without a receipt. After the rollback, the " +
      "rows that existed before the tests must be unchanged (their count and the newest row's hash), else the run " +
      "stops without a receipt. The failed controls, the sha256 of each object definition the verifier returns, " +
      "each test's statement and error, the session user and both chain heads are recorded.",
    limits:
      "Self-assessment: the owner runs it against the system the owner operates, so independent assessment " +
      "(CA-2(1)) is not met. A refusal shows the triggers were in place during the run, not between runs. The " +
      "owner, as a superuser, could disable the triggers and rewrite the evidence chain; the monthly export to the " +
      "private evidence repository, the timestamped chain head and the summary forwarded to the customer's " +
      "reviewer are the anchors outside the database that would show such a rewrite."
  },
  // The monthly summary has no runner: the first daily run of each month builds it (summary.ts).
  {
    id: "summary.monthly",
    kind: "summary",
    title: "Monthly continuous monitoring summary is recorded and sent to the owner",
    controls: ["CA-7"],
    objectives: ["CA-07e.", "CA-07g.[01]"],
    cadence: "monthly",
    cadenceStatus: "proposed",
    passCondition:
      "In the first daily run of each UTC month, one summary receipt for the previous calendar month exists: " +
      "for every other catalog check, its pass, fail and error counts over the month and its latest result; " +
      "for every control, its checks counted by latest result; the checks whose latest result is fail or " +
      "error; the active known-gap links; the attestation checks with their latest pass and whether they " +
      "were due at the month's end; and the chain head (sequence, receipt_hash) the summary receipt is " +
      "appended after. The summary is emailed once to EVIDENCE_ALERT_EMAIL (else SECURITY_ALERT_EMAIL); an " +
      "email that fails is sent by a later run.",
    limits:
      "Counts what the harness recorded; it does not rerun any check. The receipt records that a summary was " +
      "built, not that the email reached anyone or was forwarded; the chain head is anchored outside the " +
      "owner's control only when the customer's reviewer keeps the forwarded copy. Self-assessment, like " +
      "every receipt."
  }
];

export function getCheck(id: string): CheckDefinition | undefined {
  return EVIDENCE_CHECKS.find((check) => check.id === id);
}

/** sha256 of the catalog as served; recorded on every receipt. */
export const CATALOG_VERSION = sha256Hex(canonicalJson(EVIDENCE_CHECKS));
