# Change record — security readiness tranche

**Record date:** 2026-07-16  
**Status:** Pre-release; approval, current-main integration, hosted checks,
deployment, and post-deployment verification are incomplete  
**Change authority:** Unassigned  
**Independent reviewer:** Unassigned

This is the working Requirement 6.5 record for the repository security and PCI
readiness tranche. It must be linked from the eventual pull request and completed
with immutable hosted/runtime evidence. It is not a deployment receipt.

## Purpose

Address security-team feedback before Truenote is considered for an existing
PCI-certified Cardholder Data Environment. The tranche builds evidence for secure
development, vulnerability management, change control, prompt/sensitive-data
boundaries, and independent testing. It also remediates locally provable defects
and limits authenticated actions that amplify CPU, storage, queues, or provider
cost.

## Scope

Affected repository areas:

- API input/output safety, deterministic pre-provider redaction, error redaction,
  production email behavior, static asset resolution, and high-amplification
  workload throttling;
- API and frontend security/regression tests;
- pull-request security jobs and change-record fields;
- branch-enforcement evidence schema, CODEOWNERS prerequisite, validator tests,
  and manual hosted evidence gate;
- public security-reporting page, RFC 9116 discovery record, portable tests, and
  deployment/intake acceptance procedure;
- PCI readiness procedures, control/evidence matrices, vulnerability register,
  CodeQL triage, testing plan, and public capability claims; and
- workload-limit environment configuration.

Affected data and trust boundaries:

- authenticated user identity and program context;
- document upload, malware scan, parsing, embedding, and queue handoff;
- evaluation/model-provider workloads;
- OpenAI embedding, Cohere reranking, and OpenRouter generation/utility text
  boundaries;
- account invitation, credential administration, and password changes;
- application logs, email delivery, browser/static asset requests, GitHub Actions,
  OpenRouter guardrails, PostgreSQL security counters, audit receipts, and SIEM
  delivery.

No new runtime dependency or database object is introduced. New workload counters
reuse the existing `security_rate_limits` object defined in
`docs/security/p0-p1-security-controls.sql`.

## Security and PCI impact

**CDE impact:** Possible. Final scope/applicability is not yet determined by the
PCI owner/QSA, so this record blocks release into a CDE until that decision is
retained.

Threats considered:

- sensitive data or credentials reaching providers, logs, email fallbacks, source
  control, CI artifacts, or public evidence;
- prompt injection, unsafe model output, and unproven guardrail assignment;
- cross-program/classification access and authorization bypass;
- denial of service or cost amplification through uploads, evaluations, Argon2,
  queues, or providers;
- shared-office IP lockout caused by a global source-IP limiter;
- path traversal or content confusion in compressed static assets;
- unreviewed changes, incomplete vulnerability disposition, and unsupported
  compliance claims; and
- missing production DDL, branch enforcement, SIEM, provider, IAM, backup,
  incident, segmentation, and independent-test evidence.

The repository-specific threat analysis and residual treatment gates are retained
in [`threat-model.md`](./threat-model.md). It is an engineering input and remains
blocked on Product Security, PCI/QSA, deployed-architecture, and independent
review.

Security design decisions:

- expensive authenticated workloads use operation-specific Postgres counters
  keyed by user, preserving independent allowances behind shared call-center IPs;
- document throttling runs before multipart parsing;
- missing security-control DDL fails through the existing readiness error instead
  of silently allowing the workload;
- denial returns `429` with `Retry-After` and attempts a redacted audit receipt;
- public/static/OIDC and broad read-path protection remain capacity/edge design
  decisions and are not falsely marked remediated; and
- OpenRouter screenshots remain configuration evidence only until a synthetic
  end-to-end receipt proves assignment and behavior;
- deterministic secret/SSN/PAN/email/structured-phone/IPv4/IPv6 redaction now
  runs immediately before every existing text-provider call and rescans
  fail-closed, but names, addresses, ambiguous/encoded/contextual PII remain an
  explicit policy/control gap; and
- a config-independent provider-boundary suite passes 7/7 tests and API/scripts
  typechecks pass, while hosted released-commit execution, downstream receipts,
  retrieval-quality review, and independent retest remain release evidence gates.

## Repository verification

The dated result is retained in
[`verification-record-2026-07-16.md`](./verification-record-2026-07-16.md).

| Check | Result |
|---|---|
| `corepack pnpm -r run check` | Passed for all four code workspaces |
| Last complete `corepack pnpm -r run test` | Passed: 14 frontend files/62 tests, 44 API files/249 tests, and the prior 4 scripts tests; 315 total |
| Provider-firewall/evidence scripts checkpoint | Passed: 12 tests, including six production-evidence/threat-model gates and six portable provider-firewall boundary tests |
| AI adversarial harness tests | Passed: 5 tests covering sensitive-input decisions, canary echo, prompt markers, citation/refusal contracts, authenticated request construction, and evidence-safe reporting; no deployed model call was made |
| Provider-firewall API typecheck | Passed after wiring OpenAI embedding, Cohere rerank, OpenRouter answer, and OpenRouter utility boundaries |
| Provider-boundary portable tests | Passed 7/7 without Vite configuration or network calls; six cases captured protected OpenAI, Cohere, OpenRouter generation, and OpenRouter utility payloads, while one case blocked credential/private-key, SSN, and valid payment-card model output |
| Provider-firewall API Vitest mirror | Did not start because sandboxed esbuild could not read the Vite configuration path; hosted released-commit execution remains required |
| `corepack pnpm -r run build` | Passed: frontend TypeScript/Vite and API TypeScript production builds |
| Workload-control tests | Fixed-window behavior, missing-schema translation, 429/audit middleware behavior, and route mount order passed |
| Current integrated verification | Passed against the current worktree: frontend 14 files/62 tests, API 47 files/258 tests, and scripts 18 suites/74 tests, for 394 current tests total; frontend/API/scripts TypeScript checks and the frontend production build passed |
| Ask sensitive-input ordering | Passed: 3 focused cases cover the current question, every client-supplied history question/answer, complete deterministic high-risk classes, and raw-free findings. API TypeScript and the complete 47-file/258-test API suite passed. The route invokes the policy before session creation, rewrite, retrieval, provider calls, query history, citation persistence, session naming, and response assembly; deployed provider/persistence/log/proxy/APM behavior remains unverified |
| OpenRouter configuration evidence | Preserved both owner-supplied PNGs under `docs/compliance/pci/evidence/` and recorded their exact SHA-256 hashes, visible guardrail settings, and evidence limitations. No active production assignment or runtime redaction claim was added |
| Pull-request change-record gate | Passed: 5 tests cover complete normal records, placeholder/unresolved-CDE/missing-section rejection, author self-review, significant-change revalidation, emergency authority/deadline, and template integrity; hosted PR step present |
| PCI scope decision record | Passed: 11 tests cover exact-byte provisional and safe trace-receipt hashing/binding, receipt-to-prior ID/hash binding and stable receipt ID/year, duplicate-key rejection across all three inputs, mandatory stage/final-input separation including end-to-end CLI exits, bounded provisional authorization, controlled assessed-entity/application-operator/customer-CDE-owner references, canonical scope/connected-system IDs, typed/hash-bound reviewed admin/support-path, network/management-path, data-store, and backup/recovery inventory receipts, dependency-based contradictory-absence rejection, repository-unsafe rationale rejection, stable principal/artifact separation and non-reuse, exact in-scope/authorized/traced flow coverage, receipt-review-before-final chronology, final-record preservation, future/backdated/placeholders/unresolved/self-approval, unsafe/expired/overlong authorization, compatible CDE-path/no-impact/PAN/segmentation/11.4 rules, and exact provider/requirement/flow coverage; restricted inventory bytes remain externally resolved evidence; unfilled templates intentionally fail and no external authorization is claimed |
| PCI governance adoption records | Passed: 6 tests cover complete role/policy linking, all 11 roles/delegates, critical assignee/delegate separation, appointment/acknowledgement evidence, current annual review, distinct authority approvals, exact role and six-policy document hashes, single approved/adoption headers, linked signers/chronology, communication/training, controlled current exceptions, repository-safe metadata, and combined CLI/duplicate-key behavior; both templates intentionally fail and no external appointment/adoption is claimed |
| Branch-enforcement evidence gate | Passed: 4 tests cover a structurally complete declaration, stale/future/placeholder/self-approval and hostile/non-200/incomplete API evidence, disabled rules/bypasses/gaps/CODEOWNERS failures, and exact workflow/job/check/integration binding. Template intentionally fails; no CODEOWNERS/current record exists; restricted API bodies and signer identities remain externally reviewed evidence |
| Public security-reporting gate | Passed: 4 portable tests cover canonical `/security/report/` private-report discovery, login-to-overview-to-report and dual-sitemap linkage, sensitive-data and safe-testing guidance, no invented email/SLA, accessible static structure, claim boundaries, and a future RFC 9116 expiry within one year; the production build retained both security routes and the discovery record, while deployment and operating intake remain unverified |
| External-record CLI argument handling | Fixed after dry runs: both scope-decision and vulnerability-source receipt CLIs ignore pnpm's forwarded literal `--` separator and resolve repository-relative paths from the original invocation directory |
| Security-workflow semantic gate | Passed: valid structure plus mutation coverage rejecting commented/misplaced commands, disabled jobs, PR exclusions, wrong event conditions, CodeQL non-upload, and conditional retention |
| Hosted strict managed-release path | Defined: manual boolean input runs the strict vulnerability gate; current expected result remains the exact six blocker groups covering finding accountability and required source ownership/evidence/operation |
| Safe CodeQL importer tests | Passed: 8 importer tests: 7 SARIF/source tests cover safe fields, severities, management preservation, retained history/ID reservation, reappearance, actionable states, tool and per-run provenance, active closure, exact closed-section evidence, stale sources, duplicates, and mappings; 1 filesystem test covers atomic replacement and concurrent-edit protection |
| Safe CodeQL baseline structural gate | Passed: schema-v3/versioned fingerprints for all 51 results reconcile to eight exact register-ID-bound groups and retained source/commit evidence without publishing source locations or finding text |
| Required vulnerability-source gate | Passed: 3 tests require the exact 11-category inventory, calculate strict source blockers, and reject unsupported `operating` claims; structural verification checks all categories, local evidence paths, and zero currently indexed source receipts |
| Vulnerability-source execution metadata | Passed: 5 tests cover internally consistent zero-finding declarations; unsafe fields/source mismatch/bad totals; operator self-review/self-approval and partial/gapped/unreconciled acceptance; future/wrong-year/placeholders/unowned/register mismatch; duplicate IDs/artifacts and overlapping unsuperseded history |
| Internal source-receipt review | No P1; the earlier rejected-receipt CLI issue was confirmed fixed, and five remaining P2 binding/history/claim issues were reviewed in independent context. Future/placeholders, canonical register/owner binding, reconciliation manifests/counts, append-only uniqueness/overlap, and claim limits were added. Internal review only, not third-party assurance |
| Managed-release vulnerability gate | Expected blockers: 51 missing finding owners, 51 missing due dates, 51 pending dispositions, 11 missing source owners, nine missing source evidence sets, and 11 non-operating sources; no finding or source was fictionalized, waived, or closed |
| Vulnerability triage workshop | Added an execution-ready Product Security procedure that uses the current baseline as the sole management source, preserves scanner identity, defines exact active decisions and evidence, prevents bulk/group-only closure, and distinguishes finding completion from source-operation blockers; no owner/date/disposition was invented |
| PCI evidence integrity gate | Passed across 36 PCI Markdown files, 19 public evidence grades, one read-only SQL artifact, two hash-bound OpenRouter screenshots, 26 threat rows, 51 vulnerability fingerprints, and 11 required vulnerability-source categories |
| Security-readiness continuity ledger | Passed: HTML parser, 11 unique IDs, required continuity markers, and all 91 links/anchors: 11 internal, 79 local artifacts, and one official external source |
| Security workflow invariant check | PR trigger, hosted PCI and vulnerability-baseline verifiers, CodeQL permission/upload, and unconditional SARIF retention present |
| Public security brief checks | HTML parser passed; exact grade vocabulary, explicit scopes, and public evidence paths passed |
| Patch whitespace | `git diff --check` passed; line-ending conversion warnings only |

Local verification does not prove current-main integration, hosted workflow
parsing, GitHub code-scanning upload, production database state, multi-replica
behavior, deployed limits, provider configuration, SIEM delivery, or CDE
segmentation.

## Vulnerabilities and dependencies

- No new dependency was added and `pnpm-lock.yaml` was unchanged.
- Dependency overrides and the dependency-build allowlist moved from the legacy
  `package.json#pnpm` location to `pnpm-workspace.yaml`. Pinned pnpm 10.26.1 and
  local pnpm 11.9.0 both resolved the required settings; a pinned frozen offline
  install passed without changing the lockfile.
- The latest retained CodeQL artifact is indexed in
  [`vulnerability-register.md`](./vulnerability-register.md) and technically
  analyzed in [`codeql-triage-2026-07-16.md`](./codeql-triage-2026-07-16.md).
- All 51 results also appear in the repository-safe
  [`codeql-baseline-2026-07-16.json`](./codeql-baseline-2026-07-16.json). Its
  structural gate passes; its managed-release gate intentionally fails until
  owners, dates, and dispositions are recorded.
- The 11 required finding-source categories appear in
  [`vulnerability-source-register-2026-07-16.json`](./vulnerability-source-register-2026-07-16.json).
  Structure is complete; accountable owners, nine current evidence sets,
  approved cadences, and operation for all 11 remain outstanding.
- The repository-safe
  [`vulnerability-source execution record`](./vulnerability-source-execution-record.md)
  and validator standardize declared metadata and safe history checks. They do
  not prove a source ran, authenticate referenced artifacts/identities, or prove
  reconciliation. No real execution receipt is claimed by the template or tests.
- The repeatable [`CodeQL intake runbook`](./codeql-intake-runbook.md) and tested
  importer preserve management fields on rescans and fail closed on unreviewed
  new, duplicate, unstable, or removed results.
- All 40 rate-limit result locations are classified in
  [`rate-limit-route-assessment-2026-07-16.md`](./rate-limit-route-assessment-2026-07-16.md).
- No CodeQL result is closed by this record. Hosted rescanning, individual owner
  disposition, capacity/edge evidence, and retest remain required.
- Dependency audit, SBOM, Gitleaks, and CodeQL are configured for pull requests,
  but a passing hosted run tied to the eventual reviewed commit is missing.

## Deployment plan

Release remains blocked until every applicable step has a named executor and
retained result:

1. reconcile this worktree with current `main` and rerun all repository checks;
2. open a pull request using the required template and link this record;
3. obtain non-author security-sensitive code review plus required Security/PCI,
   platform, data-owner, and change-authority approvals;
4. obtain passing required GitHub checks, CodeQL upload, secret scan, dependency
   audit, and SBOM artifacts tied to the approved commit;
5. confirm production `security_rate_limits`, security audit/outbox, and related
   P0/P1 database definitions using the reviewed read-only
   `docs/compliance/pci/production-control-verification.sql` and retain its hashed
   output under the production evidence runbook;
6. approve and configure workload thresholds from capacity results;
7. deploy through the authorized production path; and
8. execute and retain the post-deployment verification below.

## Post-deployment verification

Required binary evidence:

- normal document, evaluation, invitation, user-administration, and password
  operations succeed below approved thresholds;
- threshold-crossing requests receive `429` and accurate `Retry-After` before
  expensive work begins;
- two test users behind one source IP retain independent allowances;
- counters behave consistently across at least two API replicas and expire as
  designed;
- denial receipts reach the audit store/SIEM without sensitive content;
- production database definition queries match the reviewed DDL;
- OpenRouter synthetic canaries prove the assigned guardrail transforms or blocks
  sensitive input before model/provider processing, and output handling is tested
  separately;
- sanitized downstream receipts prove the local firewall removed each claimed
  deterministic class before OpenAI, Cohere, and OpenRouter calls, and remaining
  contextual PII has an approved treatment;
- the eight-case AI regression suite passes against the named released test
  environment, emits only sanitized evidence, and every failure is closed/retested;
- required edge/read/OIDC controls and CDE segmentation tests pass; and
- application health, authentication, program/classification isolation,
  citation/refusal, ingestion, and evaluation smoke tests pass on the released
  commit.

## Failure signals and secure recovery

Failure signals include unexpected shared-office `429` responses, absent or
inconsistent counters, missing audit/SIEM receipts, security-readiness `503`
responses, queue/provider amplification, failed production smoke tests, or a new
unaccepted blocking finding.

Secure recovery procedure:

1. stop or pause the affected rollout using the authorized deployment control;
2. preserve logs, audit receipts, workflow artifacts, database-definition output,
   and the released commit identifier;
3. return application code to the last approved release rather than bypassing
   authentication, authorization, redaction, or security-readiness checks;
4. if thresholds alone caused availability impact, apply an approved bounded
   configuration correction—do not disable all workload controls;
5. do not drop shared security tables or delete audit evidence as rollback;
6. verify the restored release and open a finding/incident when exposure or
   exploitation is plausible; and
7. obtain independent review and full evidence before retrying the rollout.

## Approval and closure gates

- [ ] Current-main integration completed and full repository verification rerun.
- [ ] Hosted dependency, secret, CodeQL, test, build, and SBOM checks passed.
- [ ] Every blocking finding remediated or covered by approved, time-bounded risk
      acceptance.
- [ ] Reviewer other than the author approved security-sensitive bespoke/custom
      changes.
- [ ] PCI/CDE scope and impact approved by the accountable owner/QSA.
- [ ] Platform/database, Security, and change-authority approvals retained.
- [ ] Deployment decision, executor, environment, release commit, and time retained.
- [ ] Post-deployment verification completed and linked.
- [ ] Follow-up findings assigned with due dates and retest evidence.

Unchecked items are intentional blockers, not administrative placeholders.
