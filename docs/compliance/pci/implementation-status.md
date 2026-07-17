# PCI readiness implementation status

**Recorded:** 2026-07-16  
**Scope:** Repository foundation only

## Completed in this tranche

- Extracted the ask-request sensitive-data decision into a pure policy helper
  and added three focused tests. The current question plus every client-supplied
  history question/answer is checked for credential/private-key, SSN, and valid
  payment-card findings before session creation, rewrite, retrieval, provider
  calls, query history, session naming, or response assembly. Findings and the
  denial audit contain rule/category/count metadata only. Email, phone, IP, name,
  address, encoded/contextual PII, deployed request logging, proxy/APM behavior,
  and live provider non-invocation remain explicit acceptance gaps.
- Confirmed that generated-answer sensitive-data handling already fails closed
  before API return or query-history persistence. Added a portable regression
  that supplies credential, complete private-key, SSN, and valid payment-card
  candidates with valid citations and verifies no accepted payload or raw
  diagnostic survives. Added an evidence document that separates repository
  proof from deployed operation and explicitly leaves email, phone, IP, name,
  and address output policy to Product Security and the data/content owner.
- Added practical Requirement 6.2 operating-evidence templates for one sampled
  security-relevant released change and the annual secure-development training
  population. The change record binds scope, requirements, threats, current
  participant training, non-author review, hosted scanner/test receipts,
  findings/exceptions, release approval, and production verification. The
  training record covers role/language/tool-specific curriculum, participant
  reconciliation, completion evidence, gaps, expiry, and Product Security
  acceptance. Both are intentionally unfilled and make no operational claim.
- Added an approval-ready Truenote-specific PCI 6.2.2 curriculum. It maps annual
  training to current roles and TypeScript, React, Express, PostgreSQL,
  retrieval/AI/provider boundaries, secure design/coding, vulnerability tools,
  critical knowledge questions, a practical assessment, automatic safety-fail
  conditions, scoring, remediation, and retained evidence. It is not yet
  approved or delivered and records no participant completion.
- Added a Product Security-facing 51-finding triage workshop. It preserves the
  existing safe baseline as the sole management source, maps every child ID to
  its group, defines the seven mutable management fields and valid active
  decisions, blocks active closure, separates child from group decisions,
  specifies required minutes/hashes/approvals/retests, and explains why source
  blockers remain after finding triage. No owner or disposition was invented.
- Added a PCI readiness index, current data-flow/scope record, Requirement 6
  control matrix, secure-development lifecycle, vulnerability-management process,
  change-control process, roles matrix, provider responsibility matrix, and
  evidence index.
- Added a fail-closed PCI scope/PAN/applicability decision record, fillable JSON
  template, CLI validator, and eleven tests. A later independent-context handoff
  review found a circular dependency: final scope acceptance required a synthetic
  trace while the production runbook required approved scope before that trace.
  The format now has two exact stages. `provisional_test_authorization` requires
  a named environment/account reference, stable authorized flow IDs, synthetic
  data only, PAN and destructive-testing prohibitions, an expiry, and two
  distinct authorization decisions while keeping the trace null.
  `final_scope_acceptance` requires the exact provisional ID/file hash, supplied
  prior record, preserved scope/authorization fields, complete authorized-flow
  exact internally hashed safe-receipt coverage/timing, zero unresolved questions, completed
  authorization status, and distinct final principal/artifact approvals. The CLI
  requires explicit stage intent so provisional success cannot pass a final gate,
  rejects duplicate JSON keys across all three inputs, and forces receipt review
  before final decision/signoff chronology.
  Both stages require a single CDE relationship and validation path, conditional
  PAN/segmentation decisions, controlled assessed-entity/application-operator/
  customer-CDE-owner references, canonical component/connected-system IDs, and
  typed/hash-bound `present` or `none_verified` receipt metadata for
  administrative/support paths, network/management paths, data stores, and
  backup/recovery copies. Dependency checks reject absence contradicted by
  components, flows, or providers. Repository-safe rationales reject common raw
  topology/contact/credential forms. Both stages also require all 12 provider/
  service classifications and 6.4.2/6.4.3/11.4 applicability. Restricted
  artifacts still require external resolution/authentication. The template
  intentionally fails; no external authorization or final decision is claimed.
  Initial CLI dry runs exposed pnpm separator forwarding and package-directory
  working-directory behavior; both external-record CLIs now skip the literal
  `--` argument and resolve repository-relative paths from the original invocation
  directory.
- Added a PCI decision-meeting pack with prerequisite attendees, dependency-ordered
  decisions, exact outputs, stop conditions, action register, and reconvene rule.
  Added separate role-assignment and policy-adoption JSON templates, a combined
  validator/CLI, and six adversarial tests. Role adoption requires all 11 roles
  and delegates, appointment/acknowledgement evidence, non-overlapping critical
  assignee/delegate sets, current annual review, and distinct executive/compliance
  approvals. Policy adoption binds the exact role bytes plus six exact repository
  policy paths/hashes and exactly one approved/adoption header, linked four-role
  signoffs, communication/training, and safe non-expired exceptions. Principals
  and evidence aliases are repository-safe, duplicate JSON keys fail, and a real
  CLI subprocess passes only complete fixtures. Both repository templates fail;
  no appointment, adoption, acknowledgement, training, or approval is claimed.
- Added a fail-closed branch-enforcement evidence format, intentionally failing
  JSON template, CLI validator, six mutation-oriented tests, and an opt-in
  hosted workflow gate for the future current record. The validator rejects
  stale/future/placeholder evidence, non-official endpoint text, non-200 or
  incomplete API capture metadata, invalid response/bundle/CODEOWNERS hashes,
  missing or duplicated exact checks, mismatched contexts/integration identities,
  disabled protections, bypass actors, gaps, self-review, incomplete all-path
  CODEOWNERS coverage, or a missing/duplicated/misbound six-scenario behavioral
  suite. It validates declared metadata and local
  CODEOWNERS only; it does not authenticate or parse restricted API bodies,
  evaluate overlapping/organization rulesets, authenticate receipt bytes, or
  prove a denial test. No
  CODEOWNERS or accepted current record exists. A live re-check was unavailable
  because the saved GitHub CLI credentials were invalid, so current state remains
  unverified and the Requirement 6.5 grade remains **Gap**.
- Added a dedicated public `/security/report/` page and RFC 9116
  `/.well-known/security.txt` record using the existing GitHub private-reporting
  policy. The existing `/security/` capabilities brief now links directly to the
  reporting page, and the sitemap lists both routes. Four portable tests verify
  login-to-overview-to-report discovery, exact private intake,
  sensitive-data/safe-testing guidance, accessible static structure, absence of
  invented email/SLA claims, assurance limits, and a future expiry within one
  year. The production build retains both routes and the RFC 9116 record.
  Deployment, GitHub private-report enablement/monitoring, owner approval, and a
  harmless end-to-end intake test remain **Implemented, unverified**.
- Added a pull-request change record covering security/CDE impact, verification,
  vulnerabilities, deployment, rollback, and approval.
- Configured dependency audit/SBOM, Gitleaks, and CodeQL jobs to run on pull
  requests as well as `main`, scheduled, and manual runs.
- Configured CodeQL results to upload into GitHub code scanning while retaining
  the raw SARIF artifact. Live ingestion remains unverified until the workflow
  runs from a merged commit.
- Corrected documentation that overstated universal uploader/reviewer separation.
- Distinguished configured OpenRouter input redaction from end-to-end data-path
  protection, recorded the supplied configuration evidence, and defined a
  synthetic runtime acceptance procedure.
- Established a repository-safe vulnerability-register structure without
  representing the still-unimported findings as complete.
- Defined an independent application/API, AI-adversarial, and segmentation test
  scope with rules of engagement, deliverables, and closure criteria.
- Inspected the latest retained CodeQL SARIF, imported all 51 results into the
  vulnerability register by rule group, and preserved the unresolved baseline.
- Added a repository-safe JSON baseline with one stable ID and SHA-256 location
  fingerprint per CodeQL result, excluding paths, lines, messages, snippets, and
  exploit details. Structural reconciliation of all 51 findings is now an
  explicit CI step and part of the PCI evidence-integrity gate.
- Added a separate strict managed-release gate covering ownership, target dates,
  overdue work, dispositions, approvals, retest artifacts, and exception expiry.
  It correctly fails today on 51 missing owners, 51 missing dates, and 51 pending
  dispositions; no fictional assignments or closures were created.
- Added an exact 11-category vulnerability-source register plus three tests that
  reject missing/duplicate categories and false `operating` claims. The strict
  gate now also reports 11 missing source owners, nine missing current evidence
  sets, and 11 non-operating sources rather than implying CodeQL alone satisfies
  PCI vulnerability-identification coverage.
- Added a vulnerability-source execution metadata receipt, append-only safe index,
  CLI validator, and five tests. Structurally accepted records bind to the current
  source register/owner and require non-future chronology, non-placeholder
  fields, internally consistent finding/reconciliation counts, declared artifact
  and reconciliation-manifest hashes, zero unreconciled findings, no coverage
  gaps, and operator separation from reviewer/approver. Duplicate IDs/hashes,
  unexplained overlapping windows, and attempted raw scanner-output fields fail.
  Internal independent-context review confirmed no P1 and that the earlier
  rejected-receipt CLI issue was already fixed, then identified five remaining
  P2 claim/binding/history gaps; the in-repo issues were remediated or explicitly
  narrowed.
  This validates declarations only; authentic operating evidence remains missing.
- Added a manual hosted `managed_release_gate` workflow mode that runs the strict
  release check on demand. It is intentionally not unconditional on ordinary PRs
  while the reviewed baseline remains untriaged.
- Replaced the one-run-pinned baseline format with schema v3 and a versioned
  fingerprint algorithm. A repeatable SARIF importer now calculates artifact
  identity and severity counts, verifies the expected artifact hash, CodeQL
  driver, and commit-binding method, excludes raw paths/messages/snippets,
  preserves stable IDs and management decisions across moved lines, retains
  terminal removed records as non-reusable history, rejects unmapped, suppressed,
  absent, unstable, or duplicate findings, and uses guarded atomic writes. Eight
  importer tests pass;
  a dry run against the retained SARIF preserved all 51 current IDs with zero
  additions or removals.
- Completed an internal independent-context review of the importer/verifier,
  not third-party assurance. Six P1/P2
  findings were remediated: retained removal history/ID reservation, exact
  register-ID binding, canonical numeric timestamp checks, concurrent-edit-safe
  atomic writes, fail-closed SARIF result-state handling, and CodeQL/artifact/
  commit-evidence binding.
- Completed a second internal independent-context review, not third-party
  assurance. Four additional P1/P2 findings were remediated: active findings
  cannot be marked closed, historical closure binds to the exact child row and
  register section, stale scans cannot replace newer evidence, and every
  result-bearing SARIF run requires the selected provenance.
- Recorded the retained SARIF SHA-256 and technical triage for every finding
  group. The 40 rate-limit results are now documented as mixed existing controls,
  analyzer non-recognition, and a genuine route-coverage/capacity-design gap—not
  as 40 proven vulnerabilities or blanket false positives.
- Implemented local remediations for Markdown table escaping, production email
  console fallback, sensitive error-console text, and invalid configuration-value
  logging. CI and CodeQL retest evidence remain outstanding.
- Removed the test-only HTML tag-stripping regex behind two CodeQL results and
  JSON-escaped the development email fallback onto one physical log line.
- Replaced request-derived compressed-asset path resolution with a strict flat
  asset-basename allowlist and Express fixed-root serving; traversal-focused unit
  tests and the API production build pass locally.
- Classified all 40 CodeQL rate-limit route groups and added Postgres-backed,
  audited per-user limits for seven high-amplification paths: document upload and
  rescan, evaluation runs, bulk invitations, individual user creation/reset, and
  password change. Shared-IP call-center availability is preserved by user-keyed
  workload buckets. Production thresholds and edge/read controls remain
  operational decisions.
- Populated a pre-release Requirement 6.5 change record for this tranche with
  purpose, data/trust boundaries, threats, test results, finding state,
  deployment steps, secure recovery, and explicit approval/runtime blockers.
- Added a tested, cross-platform PCI evidence-integrity command and hosted CI
  step. It fails on broken PCI Markdown targets, missing security-workflow
  invariants, unsupported public evidence grades, missing grade scopes, or broken
  public evidence paths, and it protects required package-manager security
  settings. Structural validation does not upgrade control grades.
- Moved dependency overrides and the dependency-build allowlist from the legacy
  `package.json#pnpm` location into `pnpm-workspace.yaml`, where both the pinned
  pnpm 10.26.1 and local pnpm 11.9.0 read them. The frozen offline install passed
  without a lockfile change.
- Added a strictly read-only production catalog verification query plus an
  operator runbook and restricted-system result template. The query checks exact
  security column types/nullability, validated constraints, valid indexes,
  function security/search paths, enabled triggers, SIEM privilege boundaries,
  and definition hashes without selecting application rows. Workload, SIEM, and
  OpenRouter runtime exercises have binary evidence fields but remain unexecuted.
- Added a duplicate-key-safe structured production-result validator, CLI,
  intentionally failing JSON template, and four adversarial tests. Twenty-eight
  exact exercises distinguish `required`/`passed` from approved
  `not_applicable`/`not_run`, bind exact final-scope bytes plus environment and
  release, require operator/reviewer separation and hashed restricted evidence,
  and enforce parent/child applicability. The SQL now checks a separately named
  runtime role and exact approved function `search_path` order. These are
  structural gates; no production result or external artifact was authenticated.
- Added a repository-specific threat model covering 26 abuse cases across nine
  trust boundaries, with exact evidence grades, current controls, residual owners,
  release/CDE blockers, review triggers, independent-test mapping, and a
  restricted-system sign-off template.
- Implemented a synchronous local firewall at OpenAI embedding, Cohere rerank,
  OpenRouter generation, and OpenRouter utility boundaries. It redacts deterministic
  secrets, SSNs, payment cards, email, structured phones, IPv4, and IPv6, then
  fails closed if a blocking scanner rule remains. API/scripts typechecks and a
  config-independent 6-test boundary suite pass, directly capturing injected
  OpenAI, Cohere, and OpenRouter client payloads. The repository-test claim is
  **Verified**. Name/address/contextual PII, hosted/released CI, runtime canaries,
  policy approval, and independent retest remain open, so TN-TM-011 is not closed.
- Added an opt-in eight-case AI adversarial regression runner plus evidence-safe
  evaluator/report format. Five config-independent tests pass and prove the
  harness rejects canary echoes/prompt markers/uncited answers and excludes
  prompts, answers, canaries, and session tokens from reports. No live model was
  called. Deployed execution remains **Operational evidence required** and a true
  external AI red team remains **Third-party evidence required**.
- Added a machine-checked pull-request change record with five passing tests and
  explicit PCI DSS 6.5.1 through 6.5.6 fields. Hosted PR CI now checks change
  identity, CDE/significant-change decisions, security testing, environment/role
  separation, PAN/test-data handling, recovery, emergency authority, non-author
  identity, and change-authority decision. Branch enforcement, field truth, and
  operational receipts remain a **Gap**.
- Retained a local verification record covering the initial historical runs and
  the current frontend 62-test, API 258-test, and scripts 74-test results (394
  current tests total), plus current typechecks, the frontend production build,
  documentation checks, and the current-main overlap that must be reconciled
  before release.
- Completed an independent read-only diff review and remediated all three findings:
  full PEM-key redaction, exact public evidence-grade vocabulary/scoping, and
  production email fail-closed documentation.

These are repository changes. Draft policies and workflow definitions are not yet
operational evidence and do not establish PCI compliance.

## Remaining external or operational actions

The complete repository package was committed as `b18f78e` on
`codex/pci-security-readiness-2026-07-16` and pushed to the relocated
`ryanportfolio/Truenote` GitHub repository. A draft pull request remains pending
because GitHub currently reports only `@ryanportfolio` as a collaborator and the
machine-checked change record requires a distinct real non-author reviewer. No
reviewer identity was invented and no self-review was recorded.

1. Assign named owners and obtain Security/QSA approval.
2. Complete and authenticate a bounded provisional synthetic-test authorization;
   execute only its named flows with synthetic non-PAN data; reconcile the trace;
   then decide and sign final CDE scope, PAN policy, provider applicability, and
   segmentation.
3. Assign and triage every imported CodeQL result and every required source so
   the strict release gate passes; operate the missing finding sources at
   approved cadences, approve remediation SLAs, close true positives, and retain
   execution and retest evidence.
4. Run the added provider-firewall tests in hosted CI; approve the data policy;
   decide contextual name/address coverage; and retain synthetic downstream
   OpenAI/Cohere/OpenRouter redaction receipts.
5. Verify production database objects, OpenRouter guardrail assignment/redaction,
   provider settings, IdP/MFA, SIEM, backup/restore, and incident response.
6. Execute the synthetic AI regression runner against an authorized released test
   environment, retain the sanitized report/receipt hashes, and close failures.
7. Commission independent application/API, AI, and segmentation testing as scoped;
   remediate and obtain retest evidence.
8. Approve and deploy the public security overview and `/security/report/`
   policy, verify both routes plus the RFC 9116 record and content types from the
   public origin, enable/monitor GitHub private reporting, run a harmless
   synthetic intake through closure, and assign annual expiry review.
9. Use the new PR change record for one real reviewed release and retain its
   hosted workflow, approval, deployment, rollback-readiness, and production
   verification receipts.
10. **Deferred by owner:** do not spend more local effort on advanced GitHub
    branch-proof hardening now. Requirement 6.5 remains a documented Gap. Resume
    CODEOWNERS, ruleset, authenticated API, and behavioral push/merge receipts
    only if Security/PCI requests them or before relevant CDE integration.

## Current claim

The repository has a materially stronger PCI Requirement 6 readiness foundation.
Operational effectiveness, assessment scope, and compliance remain unverified.
