# Truenote security and PCI review

**Date:** October 9, 2026  
**Reviewed main:** `e63293ca7d9da75d9749a7aef109364acfe47423`, fetched from GitHub before review  
**Scope:** `/security/`, `/security/pci/`, supporting security/PCI documentation, relevant implementation, live audit catalogs/runtime-role metadata, DDL, current GitHub CodeQL alerts, hosted checks, and limited read-only deployment observations  
**Gate:** P0 incomplete. Customer security approval and PCI applicability remain unresolved.  
**Confidence:** High for source and the named CI receipt; limited for deployed control effectiveness, provider assurance, and organizational evidence

The pages needed substantive corrections. They used July dates, grouped draft
operating procedures with completed safeguards, and left important limits and
launch prerequisites implicit. This update describes the controls accurately and
adds an approval checklist. It does not complete the operational work, constitute
an independent penetration test or PCI assessment, or authorize production use.

## Direct observations and limits

- Latest-main [security workflow run 37873695940](https://github.com/ryanportfolio/Truenote/actions/runs/37873695940)
  completed successfully. Typecheck/build/tests, secret scanning, dependency
  audit/SBOM, and CodeQL jobs passed. The PCI evidence-integrity step passed.
  The strict managed-release vulnerability and supplemental branch-enforcement
  steps were **skipped**. CodeQL job success is not proof of zero findings.
- Authenticated GitHub API checks found 31 open, eight fixed and nine dismissed
  main-branch alerts. Latest main analysis `1920497333` reports 36 SARIF results
  for the reviewed commit. The [current alert review](../compliance/pci/codeql-review-2026-10-09.md)
  checks all 31: seven source-level false positives, one expected seed-tool
  credential flow with an operator-controlled destination, and 23 accurate
  observations of absent application rate limits. The owner clarified that the
  missing limits are intentional during the demo phase. They are not automatically
  approved for customer use. The July 51-result baseline is historical and has
  not been reconciled; it is not today's open-alert count. No alerts were changed.
- Limited read-only Railway inspection found the web service's OIDC settings,
  malware-scanner endpoint, SIEM endpoint, and SIEM signing key absent. Local
  login uses the enabled/default mode; public demo accounts remain configured.
  Only presence and enumerated mode were recorded. No secret values were printed.
  This does not establish scanner policy state in the database or worker settings.
- Both deployed security URLs returned `200` with the expected titles and HTML
  content types. `/.well-known/security.txt` returned `200` and plain text.
  Their HTTPS responses included HSTS and a restrictive CSP. These checks establish
  public discovery and observed headers, not the effectiveness of all browser
  controls or private vulnerability intake.
- Live Railway catalog queries executed in `READ ONLY` transactions on October 9
  confirmed the hash-chain append function exists, but the mutation-blocking,
  document-lifecycle/source-audit and all five SIEM functions are absent. There
  are no non-internal triggers on the three audited tables. Both web and worker
  connection settings identify the `postgres` role; the catalog confirms that
  role is a superuser, owns the audit/outbox tables, and can update/delete/truncate
  them. The [retained catalog receipt](evidence/railway-audit-catalog-2026-10-09.json)
  contains query text, definitions/hashes and metadata only. This is a confirmed
  installation/privilege gap. The full formal PCI catalog verifier and synthetic
  acceptance tests were not run.
- Update, later on October 9: with the owner's approval, `lib/db/sql/0007` to
  `0009` were applied and both services were switched to `truenote_app`, a
  login role that owns nothing, runs no DDL, has no TRUNCATE, and can read
  `security_events` but write it only through `append_security_event`. The
  append-only guard (plus a TRUNCATE guard) and the document-lifecycle and
  source-audit triggers are installed. A privilege sweep, rolled-back negative
  tests (the role's writes to `security_events` and its DDL are refused; the
  owner's UPDATE and DELETE are refused by the trigger) and application checks
  are retained in the
  [remediation receipt](evidence/railway-app-role-2026-10-09.json). The SIEM
  functions and trigger remain absent, and the full verifier was still not run.
- Current operating records say database volume backups are off, uploaded files
  have no backup, no restore exercise is retained, and Railway has one production
  environment. Those are dated records, not newly observed provider settings.
- No signed PCI scope, authenticated policy adoption, current provider assurance,
  independent test/retest, customer approval, or completed restore/incident exercise
  was available in the reviewed evidence. Evidence held elsewhere can change these
  grades after a responsible reviewer authenticates it.

This review did not log in to the application, select application rows, apply DDL, change variables,
configure backups, call AI providers, inject failures, deploy, or exercise live
customer data. Formal catalog and synthetic-control acceptance remain subject to
the prerequisites in the [production evidence runbook](../compliance/pci/production-evidence-capture-runbook.md).

## Consolidated release scope

The owner authorized merge and Railway deployment on October 9, with Astra
replacing unavailable Opus review. The final release combines the verified
claims from [PR #198](https://github.com/ryanportfolio/Truenote/pull/198), the
feedback ownership and rejected-response handling in
[PR #199](https://github.com/ryanportfolio/Truenote/pull/199), and the history/local
login/reset authorization fixes in
[PR #200](https://github.com/ryanportfolio/Truenote/pull/200). Public page changes
are consolidated once; unrelated dependency, film and older documentation PRs
are outside this release.

The history fix withholds questions, answers, source excerpts and titles when
current program, clearance, source approval or lifecycle access cannot be proven.
Zero-citation refusals are also withheld. The local-login policy remains enforced
with unusable OIDC configuration, including reset/invitation completion; denial
rolls back token consumption before changing credentials or issuing a session.
Feedback and missing-content writes now require the asker, and the UI reports a
rejected feedback response instead of displaying it as saved.

PR #200's four required Actions jobs passed. Its separate code-scanning check
reported two missing-rate-limit annotations on session history reads. These
are the same existing main alert IDs 30 and 31 and follow the owner's intentional
demo-phase decision. Alert IDs/counts must be rechecked against the released
main scan; this release does not silently dismiss alerts or imply zero findings.
The absence of configured SSO and scanning is likewise intentional during testing.
Their integration code still requires configuration and end-to-end acceptance.
The confirmed missing audit database controls remain a separate installation gap.

The provider inventory, supported payment-card pattern (Luhn-valid 13-to-19
digits with space/hyphen separators), unscreened notes/labels, raw-file exposure,
approved-route fallback, document-retirement retention, browser-client exception,
and incomplete background event coverage are retained in the consolidated copy.
The active GitHub ruleset was rechecked: PR and four checks required, zero required
approvals, administrator PR bypass. Neither settings nor technical review establish
distinct organizational approval or PCI compliance.

Review and deployment receipts will be retained separately with exact source
identities. No migration, provider setting, scanner setting, identity setting or
database privilege change is part of this release.

### Astra review and finding verification

A fresh `gpt-6-astra` medium review examined the committed combined release
`e63293ca7d9da75d9749a7aef109364acfe47423` to
`e5022ad25e8f6de1408803df4baa234d53b9b6b0`, tree
`496354e4d38b1ae967e31894bbf25fe72650ddce`. The external-review skill read and
exact diff reads were verified in the reviewer's separate rollout, with zero
spawn calls and a completed review output. This is fresh context from the same
vendor, not a cross-vendor or organizationally independent assessment. Report
SHA-256: `3be786533d3c6657023553253bd1dfb7bbb268aba3847ec3cfe928daecbb678d`.

One P2 finding survived verification: the API receipt counted lengths of overlapping
state-filter responses instead of unique IDs by actual state. IDs 1, 4, 5 and 6
were duplicated. The corrected receipt contains 48 unique alerts: 31 open, eight
fixed and nine dismissed. A separate authenticated unfiltered main read matched
every identity and state. Duplicate/count assertions now pass, and all five
documents repeating the unsupported fixed total were corrected. No alert state
changed. The reviewer found no concrete runtime regression in the feedback,
history or login/reset changes. Tests, builds, browser and live-platform checks
were unavailable to that read-only reviewer. This correction was locally verified;
no second Astra run or clean re-review is claimed.

## Corrections to the public claims

1. Replace the July review dates with October 9 and identify the reviewed main
   commit and exact hosted workflow receipt. Keep current-source links separate
   from that historical execution receipt.
2. Separate draft lifecycle/change procedures from tested code. Written procedures,
   templates, and structurally accepted metadata are not operating evidence.
3. Limit Zero Data Retention to the implemented routing policy. Direct embedding,
   reranking, raw-file parsing/scanning, provider accounts, contracts, and endpoint
   eligibility need their own evidence.
4. Describe the exact deterministic input/output patterns and their non-coverage,
   including standalone CVV/CVC, contextual names/addresses, and encoded values.
   Cite/refuse is an answer-integrity control, not proof of factual accuracy or
   complete prompt-injection prevention.
5. State the raw-file processing order: object storage and enabled scanner receive
   original bytes; PDF/image parsing may disclose bytes to LandingAI; parsed text
   is persisted before sensitive-content screening. Quarantine controls activation
   rather than eliminating earlier storage or disclosure.
6. State the scanner-disable exception and senior-role self-activation. Neither
   universal malware scanning nor universal uploader/reviewer separation exists.
7. Replace absolute citation "immutability" with version-bound application receipts.
   Limit append-only/hash-chain claims to the defined controls and tested paths;
   administrator-resistant retention requires privileges and external evidence.
8. Remove the unsupported assertion that an external CodeQL alert gate passed.
   Explain the difference between CI analysis, finding disposition, and the skipped
   strict release gate.
9. Add PCI scope, all 12 requirement families, conditional web/payment-page controls,
   identity/session requirements, recovery, third-party responsibilities, independent
   testing, recurring evidence, and explicit assessment limits.

## Control evidence and required work

Grades follow the [security claim model](README.md). A Verified row below states
the exact layer verified. Owners are proposed accountable functions, not invented
appointments. Named people and due dates must be assigned by the decision authority.

| Control | Grade | Evidence and scope | Risk or limit | Owner | Required action and binary acceptance |
|---|---|---|---|---|---|
| Latest-main engineering checks | Verified | Named hosted workflow above; job and step conclusions | Strict release gate skipped; no deployed-byte binding | Engineering | Retain a passing receipt for the release being shipped and prove that deployed bytes match it |
| Program/classification authorization | Verified | `artifacts/api-server/src/lib/retrieval/query.ts`, retrieval program-scope and security negative tests exercised by hosted CI | Repository cases do not cover every production administrative/team route or network segmentation | Engineering/AppSec | Released-environment negative tests deny cross-program, above-clearance, citation, document, and new team/source paths |
| Ask-input and text-provider firewall | Verified | `security/ask-content-policy.ts`, `security/provider-input-firewall.ts`, portable provider payload tests | Deterministic coverage only; names, addresses, obfuscation and standalone SAD unresolved | AppSec/data owner | Approved data policy plus synthetic downstream receipts demonstrate the named classes and resolve every prohibited-data path |
| Generated answers and citations | Verified | Generation safety tests, version-bound receipt logic, named hosted suite | Valid citations do not establish semantic truth; output screening is narrower than input redaction | Product Security | Retain released-model evaluation and adversarial results with no uncited normal answers, protected-data echoes, or authorization leaks |
| Browser defenses and reporting discovery | Verified | Public HTTP observations above; browser middleware/test source and reporting discovery | Headers/discovery do not prove private intake or all browser mutation paths | AppSec/Engineering | Deployed origin/CSRF/CSP checks pass; harmless private-report intake is acknowledged, tracked, and closed |
| OIDC and MFA | Configuration required | OIDC code validates issuer/audience/signature/claims; live web settings absent | Current local passwords supply no IdP MFA assurance | IAM | Approved IdP configuration and named-account tests prove MFA, onboarding/offboarding, revocation, and emergency-access controls |
| Idle reauthentication | Gap | `artifacts/api-server/src/lib/auth/sessions.ts`: seven-day absolute expiry; `last_used_at` updated but not used to expire access | No application idle timeout. Applicable 8.2.8 evidence may instead come from an assessed endpoint/session control | IAM/Engineering | Assessor accepts demonstrated idle reauthentication at 15 minutes, or implement and verify application enforcement, including background traffic and concurrent requests |
| Demo and privileged access | Operational evidence required | Demo settings present; `auth/demo-limits.ts`, user/role policies | Demo isolation and real-data boundary not runtime-tested here | IAM/application operator | Demo users cannot access organizational data or privileged live operations; approved account inventory/access review and removal/isolation receipts retained |
| External malware scanner | Configuration required | `security/content-scan.ts`, `security/malware-policy.ts`, live endpoint absent | EICAR is not a full scanner. Actual enabled/override state not inspected | Platform/AppSec | Approved scanner configured; scanning enabled; clean/infected/unavailable/error tests retain correct receipts before parser work |
| Scanner overrides and content approval | Operational evidence required | `security/document-policy.ts`, `docs/security/malware-scanning-control.sql`, `review-approval-control.sql` | Super-user scan bypass and senior-role self-activation are intentional exceptions | Data owner/Security | Adopt approval/exception policy, scope and expire bypasses, identify prior bypassed content, and rescan or retire it before customer use |
| Raw-file and post-parse data handling | Gap | `artifacts/api-server/src/lib/ingestion/run.ts`, data-flow inventory | Sensitive raw files can be stored/disclosed before text screening; parsed text persisted before the decision | AppSec/data owner | Approve and enforce sanitized-only ingress or an assessed protected raw-file path; test prohibited-data rejection and cleanup across originals, parsed content, processors, and backups |
| Audit database prerequisites and runtime privilege | Operational evidence required | Live Railway read-only catalog and runtime-role receipt October 9; remediation receipt later October 9 | Found: mutation-blocking and lifecycle/source audit functions/triggers absent and web/worker connected as a superuser. Remediated October 9: guards and audit triggers installed; web/worker connect as least-privilege `truenote_app` (sweep and negative tests retained). Open: full verifier, synthetic acceptance, and administrator-resistant retention (the owner can still disable triggers) | Database owner | Install reviewed numbered migrations; provision separately owned controls and least-privilege runtime access; full catalog and synthetic acceptance checks pass after authorized changes |
| External SIEM delivery | Gap | Live catalog confirms five delivery functions and enqueue trigger absent; live web endpoint/signing key absent October 9 | No demonstrated external delivery, independent retention, alert ownership or failure response | Database/SecOps | Verified prerequisites plus signed delivery, retry/recovery, dead-letter, alert, retention, and responder receipts pass |
| Data retention and deletion | Operational evidence required | Document purge policy, retention override setting, provider matrix | No accepted schedule spanning logs, questions/answers, parsed files, providers and recovery copies | Data/privacy owner | Approve scoped schedules and overrides; retained deletion/discovery exercises cover all copies and documented exceptions |
| Encryption and secrets | Third-party evidence required | Public HTTPS/HSTS observed; private proxy closure documented; service and provider records | No current full-path cryptographic/key-management attestation | Platform/vendor-risk | Verify private transport, storage/backup encryption, key ownership/access/rotation, certificates and credential lifecycle for the assessed paths |
| Backup and restore | Operational evidence required | `backup-restore-runbook.md`, deployment reference | Latest records: backups off; uploaded-file backup absent; no measured restore result | Platform/database owner | Database and object backups enabled/verified; restore to an approved isolated target passes integrity and application checks with accepted measured RPO/RTO |
| Incident response | Operational evidence required | `incident-response-plan.md` is proposed | No approved notification terms, trained responders, or completed tabletop evidence | Security/operations | Approve owners and contractual/regulatory notice decisions; exercise detection, containment, evidence preservation, recovery and communications |
| Vulnerability triage and release gate | Operational evidence required | Current authenticated GitHub receipt and 31-alert source review; historical 51-finding baseline and strict validator | Seven source-level false positives, one expected operator flow and 23 intentional demo-phase rate-limit omissions; historical management records are not current counts or confirmed exploits | Product Security | Reconcile current fingerprints/states and preserve closed history; record verified dismissals, scope demo decisions and customer-use prerequisites; retain owners/source operation/retests and pass strict mode |
| Change control and release identity | Operational evidence required | Proposed change procedure/templates; Railway operator-upload deployment path | No authenticated approved operating sample or cryptographic CI-to-deployed-byte binding | Change authority/Engineering | Adopt procedure/register; trace a real change through non-author review, approval, exact bytes, security checks, recovery readiness, deployment, verification and closure |
| Pre-production validation target | Gap | Current deployment reference records one Railway environment | No authorized isolated target for synthetic AI, restoration and adversarial exercises | Application operator/Platform | Approve a separate target or explicit documented substitute and test isolation before using it |
| Provider assurance | Third-party evidence required | Provider responsibility matrix; router and direct-provider implementations | Account/model endpoint, DPA, subprocessors, raw-byte handling, retention and CDE suitability unverified | Vendor-risk/PCI owner | Authenticate current service-specific contracts/settings/attestations; classify all processors and approve permitted data paths |
| Independent assurance and scope | Third-party evidence required | Scope decision procedure, independent testing plan, requirement matrix | No final boundary or retained independent application/API, AI or applicable segmentation report | PCI owner/customer Security/assessor | Approve scope and rules of engagement; complete applicable assessment and test/retest; retain written customer authorization |

## Five next actions in dependency order

| Order | Accountable owner to appoint | Evidence artifact | Binary acceptance test |
|---|---|---|---|
| 1 | Customer Security, PCI scope owner, application operator | Approved role/data decisions, provisional synthetic authorization, reconciled trace, final scope/provider/applicability record, approved test target | Accountable identities and every data/admin/network/recovery path are classified; restricted evidence authenticates; final decision passes structural validation and authorized review |
| 2 | IAM, Platform/database, AppSec, SecOps | Configuration and catalog receipts; session/scan/access/logging tests; raw-file policy/enforcement; backup and restore record | Applicable identity/session, ingestion, database privilege/audit, SIEM, cryptographic and recovery prerequisites pass on the named release; exceptions are approved and bounded |
| 3 | Product Security and change authority | Reconciled current scan/register, source execution receipts, strict release-gate output, approved procedure and sampled change record | No pending/unowned/overdue unmanaged findings or missing source evidence remain; strict mode passes; a real change is approved and bound to deployed bytes |
| 4 | Vendor-risk and qualified independent tester/assessor | Current provider evidence, applicable scans/penetration/AI/segmentation reports, remediation and retest | Provider scope and data handling accepted; applicable assurance work completed and findings closed or explicitly accepted by the authorized decision maker |
| 5 | Customer Security and application operator | Final written authorization, authenticated assessment records, incident/recovery/training evidence and recurring control calendar | Customer approves the exact release/environment/permitted use; continuing control owners, cadences, retention and renewal dates are recorded |

## Source checks

Official sources checked October 9, 2026:

- [PCI SSC document library](https://www.pcisecuritystandards.org/document_library/?class=pcidss&doc=pci_dss):
  current PCI DSS v4.0.1 review basis. The 12-family checklist is a non-authoritative
  review aid; it does not replace the standard or assessor applicability decisions.
- [PCI SSC applicability guidance](https://www.pcisecuritystandards.org/faqs/1473/)
  and [partial-assessment guidance](https://www.pcisecuritystandards.org/faqs/1382/):
  scope, tested requirements, exclusions, and validation must be stated accurately.
- [PCI SSC sensitive authentication data guidance](https://www.pcisecuritystandards.org/faqs/1533/):
  post-authorization storage prohibition applies even when encrypted or PAN is absent.
- [PCI SSC idle reauthentication guidance](https://www.pcisecuritystandards.org/faqs/1147/):
  applicable 8.2.8 idle reauthentication and possible endpoint/session enforcement.
- [PCI SSC payment-page guidance](https://blog.pcisecuritystandards.org/coffee-with-the-council-podcast-guidance-for-pci-dss-e-commerce-requirements-effective-after-31-march-2025):
  6.4.3/11.6.1 applicability must be reviewed; their effective date has passed.
- [OpenRouter ZDR documentation](https://openrouter.ai/docs/guides/features/zdr):
  endpoint-specific routing controls require account/provider evidence and have
  defined coverage limits.
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data):
  retention controls depend on approval, organization/project settings, endpoint
  eligibility and exceptions. A router setting does not attest to direct-provider
  configuration. No provider account was inspected.

## Verification and remaining checks

The editing scope is public HTML, its sitemap, the supporting documentation, and
maintenance of existing page-contract assertions that previously prohibited public
readiness limits. No application/runtime behavior was changed.

| Check | Result |
|---|---|
| Repository PCI evidence verifier | Passed after follow-up: 41 PCI Markdown files, one public grade tag with scope, one read-only SQL artifact, two hash-bound screenshots, 26 threat rows, 51 historical finding fingerprints, and 11 source categories. Executed existing TypeScript CLI with Node 24 native type stripping and a scratch relative-import resolver; no dependency installation |
| Public HTML structure and local targets | Passed: balanced tags, one main heading and style block per page, unique section IDs, and 55 repository-evidence/section targets |
| Security-document Markdown links | Passed: four Markdown documents, zero missing local targets |
| Browser source preview | Passed at desktop width 1280 and phone width 375: both revised pages render, styles load, section navigation works, the PCI table exposes all 12 rows, and tables scroll within their focusable regions without horizontal page overflow |
| Strict managed-release vulnerability CLI | Failed with six blocker groups: 51 missing finding owners, 51 missing due dates, 51 pending dispositions, 11 missing source owners, nine missing source evidence sets, and 11 non-operating sources. This is a failed readiness gate, not 51 confirmed exploits |
| Current GitHub CodeQL | Authenticated API receipt retained: 31 open, eight fixed, nine dismissed; latest-main SARIF has 36 results. Reviewed all open alerts against current source; no alert state or scanning configuration changed |
| Live Railway audit catalog and runtime roles | Read-only catalog checks and username-only runtime inspection retained. Confirmed missing audit/SIEM objects, no non-internal triggers on the three audited tables, and superuser runtime access. No application rows read or mutation attempted; full formal verifier not executed. Remediated later the same day; see the [remediation receipt](evidence/railway-app-role-2026-10-09.json) |
| Source syntax and whitespace | Existing page-contract file passed Node syntax checking; `git diff --check` passed |

The source preview used the same stylesheet-extraction convention as the Vite
publisher. It was served by a scratch static server, not the fixture API, a full
production build, or the deployed application. Screenshots are local artifacts
under `D:\screenshots\truenote\security-review-2026-10-09\`. The temporary browser
and server were closed after verification.

No unit or type suites were run in this session, per the repository instruction.
Full build and new-branch CI remain unverified: this fresh worktree has no installed
application dependencies, and this request did not authorize installing them or
publishing a PR. The cited successful main run predates these edits.

The new pages require their own hosted checks and an approved deployment followed
by content, asset, header and route verification. Production controls require
separate evidence; none was promoted from repository presence or page copy.
