# Repository verification record — 2026-07-16

**Evidence grade:** Local repository verification only  
**Worktree base:** `a1def35de039c2065d1148371b3490fac81e5ebf`  
**Current remote `main` observed during verification:**
`32d0b1b754753b3d7fe1cc057c3394105fe44eac`

This record supports the current remediation tranche. It is not a released-build,
GitHub required-check, deployed-runtime, or production-control receipt.

## Passed checks

| Check | Result |
|---|---|
| Locked local workspace install | Completed from existing `pnpm-lock.yaml`; no lockfile change |
| Focused API security tests | 5 files, 27 tests passed |
| Workspace TypeScript checks | All four code workspaces passed `pnpm -r run check` |
| Last complete workspace test command | Frontend: 14 files/62 tests; API: 44 files/249 tests; scripts: 4 tests; 315 tests passed total before the production-evidence verifier test was added |
| Production builds | API TypeScript build and frontend TypeScript/Vite production build passed |
| Updated error-redaction focused retest | 1 file/3 tests passed after single-line console hardening |
| Independent-review remediation retest | Private-key/content and error-log suites: 2 files/11 tests passed; API typecheck passed |
| Post-triage frontend regression | Complete frontend suite: 14 files/62 tests passed after removing the test-only tag-stripping regex |
| Post-triage API regression/build | Complete API suite: 41 files/239 tests passed; API TypeScript check and production build passed after single-line development email logging and compressed-asset path hardening |
| Workload-throttle regression/build | Complete API suite: 44 files/249 tests passed; complete frontend suite: 14 files/62 tests passed; all four workspace checks and both production builds passed after adding the distributed workload controls |
| PCI evidence integrity gate | 36 PCI Markdown files, 19 public evidence grades, one read-only SQL artifact, two hash-bound OpenRouter screenshots, 26 threat rows, 51 vulnerability fingerprints, and 11 required vulnerability-source categories checked; all local links, public evidence paths/scopes, required workflow/package settings, SQL safety invariants, stable threat IDs, exact grades, trust boundaries, evidence paths, release blockers, safe CodeQL grouping, and exact source coverage passed |
| Package-manager security settings | Pinned pnpm 10.26.1 frozen offline install passed; pnpm 10.26.1 and local pnpm 11.9.0 both resolved the two `form-data` security overrides and the single-package `esbuild` build allowlist from `pnpm-workspace.yaml` |
| Evidence-gate hardening retest | 4 scripts tests passed after requiring overrides to remain inside the root `overrides` section and rejecting any additional allowed dependency installer |
| Production verifier focused test | 5 scripts tests passed after requiring a bounded read-only transaction, rejecting mutation/direct application-table reads, and requiring binary results plus definition hashes |
| Current verified test inventory | Frontend 14 files/62 tests, API 47 files/258 tests, and scripts 18 suites/74 tests all passed against the current integrated worktree: 394 tests total; frontend, API, and scripts TypeScript checks passed, and the frontend production build passed |
| Ask sensitive-input ordering | Three focused tests passed for the current question, every client-supplied history question/answer, complete high-risk class coverage, and raw-free findings. API TypeScript passed, and the complete API suite passed 258/258 across 47 files. Source ordering places the decision before session creation, rewrite, retrieval, provider calls, query history, citation persistence, session naming, and response assembly. Deployed provider/persistence/log/proxy/APM behavior remains unverified |
| OpenRouter configuration evidence preservation | The two owner-supplied PNGs were copied from temporary clipboard storage into `docs/compliance/pci/evidence/` and bound in the guardrail record to SHA-256 values `F91D...D98D8` and `FDCD...F73C`. This proves the retained bytes and visible configuration only; production assignment and runtime effectiveness remain unverified |
| Model-output sensitive-data handling | Portable provider-boundary suite passed 7/7, including one output case that supplies credential/API-key, complete private-key, SSN, and valid payment-card candidates with valid citations and verifies no accepted payload or raw diagnostic survives. Focused API generation suite passed 26/26; API and scripts TypeScript passed. Deployed operation and contextual output policy remain unverified |
| Requirement 6.2 operating forms | Added an intentionally unfilled annual secure-development training record and a representative released-change review record. Both are linked from the SDLC, PCI index, evidence index, control matrix, implementation status, and durable HTML ledger. They establish a practical collection format only; no training, approval, release, or production operation is claimed |
| Requirement 6.2.2 curriculum | Added `TN-SDLC-CURRICULUM-001` v1.0 draft with role/language/framework-specific secure design and coding content, required vulnerability-tool demonstrations, twelve knowledge questions with four critical items, a practical assessment, automatic safety failures, scoring, remediation, and evidence requirements. It is linked to the annual record but remains unapproved, undelivered, and not participant evidence |
| Pull-request change-record gate | Five tests passed for a complete normal record, placeholder/CDE/section rejection, author self-review and significant-change rejection, emergency authority/deadline enforcement, and repository-template field/section coverage; hosted workflow step present for pull-request events |
| PCI scope decision record | Eleven tests passed: final acceptance bound to exact provisional and safe trace-receipt bytes with verifier-computed hashes; receipt-to-provisional hash/ID binding, stable receipt ID/year, and receipt-review-before-final chronology; duplicate-key rejection for final/prior/receipt JSON; bounded provisional authorization with `structurallyFinalAccepted=false`; mandatory controlled assessed-entity/application-operator/customer-CDE-owner references; canonical component/connected-system IDs; typed/hash-bound reviewer/timestamp metadata for `present` or `none_verified` admin/support-path, network/management-path, data-store, and backup/recovery inventories; contradictory absence, malformed receipt, and common raw topology/contact/account/credential rejection; future/backdated/placeholder/unresolved/self/principal/artifact-reuse rejection; unsafe/expired/overlong authorization; trace timing/receipt/flow completeness; preservation against final-record mutation; compatible CDE-path/no-impact/PAN/segmentation/11.4 decisions; exact provider/requirement/flow coverage; and end-to-end CLI success/failure for mandatory stage and final inputs. Restricted inventory bytes remain externally resolved evidence. Repository templates are intentionally invalid; no real authorization or approval is claimed |
| PCI governance adoption records | Six tests passed: complete linked role/policy acceptance; missing/duplicate role, delegate, critical-separation, unresolved, overdue-review, and self-approval rejection; exact role/policy byte hashes; exact single approved/adoption headers; linked role signers and chronology; communication/training; policy coverage; safe current exceptions; repository-safe principal/reference/free-text rejection; and end-to-end combined CLI/duplicate-key handling. Both templates intentionally fail; external identities, references, acknowledgements, communication, training, procedure use, and assessor acceptance remain unverified |
| Branch-enforcement evidence gate | Six tests passed: complete current declaration; stale/future/placeholder/self-approval and invalid capture rejection; disabled rules/bypasses/gaps plus missing CODEOWNERS rejection; exact workflow/job/check/integration coverage; exact six-scenario behavioral coverage including all four missing-check attempts; and configuration/ruleset/receipt/chronology/separation binding. The unfilled template intentionally fails, no CODEOWNERS/current record exists, restricted API/receipt bytes are not authenticated, and current live GitHub state is unverified because the latest re-check lacked valid CLI authentication |
| Production-control result gate | Four tests passed for complete exact final-scope/release/environment-bound results across 28 stable exercises; controlled not-applicable/not-run versus required/pass state; skipped/weak/drift/self-review rejection; and exact scope bytes, separate final-scope acceptance, complete coverage, dependency rules, and open-finding rejection. The JSON template intentionally fails. Restricted artifacts/signers and production origin remain externally authenticated evidence, not local-test claims |
| Public security-reporting gate | Four portable tests passed for the canonical `/security/report/` source, exact private GitHub intake, login-to-overview-to-report and dual-sitemap discovery, sensitive-data and safe-testing boundaries, absence of invented email/SLA claims, accessible external-CSS structure, explicit assurance limits, and a current RFC 9116 record expiring within one year. The production build retained `/security/`, `/security/report/`, their styles, and `/.well-known/security.txt`; public deployment, GitHub private-report enablement/monitoring, approved owner identity, and a synthetic report through closure remain unverified |
| External-record CLI argument handling | Initial scope-template dry runs correctly did not produce a pass but exposed pnpm forwarding the literal `--` separator and changing into the package directory; scope-decision and vulnerability-source receipt CLIs now skip the separator and resolve repository-relative paths from the original invocation directory |
| Security-workflow semantic gate | Two tests passed: valid job/step placement and a mutation case rejecting commented/misplaced commands, disabled verify job, PR path exclusion, missing edited trigger, wrong change-record event condition, missing explicit manual strict-release mode, CodeQL non-upload, and conditional SARIF retention |
| Hosted strict managed-release path | Manual workflow input `managed_release_gate` conditionally runs `verify:vulnerabilities:release`; local strict invocation intentionally fails on exactly six blocker groups covering finding accountability and required source ownership/evidence/operation |
| Post-verifier full-run reconciliation | Initial frontend/API Vitest startup inside the filesystem sandbox failed because esbuild could not read the Vite config path. Bounded reruns outside that sandbox passed frontend 62/62 and the latest API suite 258/258; scripts passed 74/74. All three relevant TypeScript checks and the frontend production build passed. One Cohere boundary test initially failed because its mock omitted legitimate `model` and `topN` fields; the test now asserts the complete redacted provider request and the full API suite passes |
| Provider-input firewall typecheck | API `tsc --noEmit` passed after wiring local deterministic redaction into OpenAI embeddings, Cohere reranking, OpenRouter answer generation, and OpenRouter utility calls |
| Provider-input firewall portable gate | Six config-independent Node tests passed. They verify every claimed deterministic class, safe findings, explicit contextual non-coverage, and exact payloads supplied to injected OpenAI embedding, Cohere rerank, OpenRouter answer, and OpenRouter utility clients |
| Provider-input firewall API Vitest mirror | Did not start because sandboxed esbuild could not read the Vite config path; no pass/fail is claimed for those mirror files, and hosted CI must execute them for the released commit |
| Provider-input firewall source identity | `provider-input-firewall.ts` SHA-256 `15B79D689A94CA1FEB5528224FDBD0EE080AF31C1D29444FC2D5BEA8F3FE856E`; repository source only, not a deployed or independent receipt |
| AI adversarial harness gate | Five config-independent tests passed for blocking evaluation, canary/prompt-marker rejection, citation/refusal enforcement, authenticated request construction, and exclusion of tokens/prompts/answers/canaries from sanitized reports; fake HTTP transport only |
| AI adversarial runner CLI | Help/validation path executed without credentials or network calls; live runner remains intentionally unexecuted pending written target/cost authorization and a synthetic account |
| AI adversarial harness source identity | `ai-security-regression.ts` SHA-256 `F0738D3207B5E0B9F5EF410F0D75F3E3FD517D9B36D2C2D51A8115C1BA773166`; harness source only, not a deployed or independent test receipt |
| Safe CodeQL baseline structural gate | Passed for all 51 finding IDs/fingerprints, exact source identity, 50 high/one medium severities, eight rule groups, register mappings, safe fields, and status/disposition consistency |
| Required vulnerability-source gate | Three tests passed for the exact 11-category inventory, strict blocker accounting, and rejection of unsupported `operating` claims; the structural verifier confirms all categories, existing local evidence paths, and zero currently indexed source receipts |
| Vulnerability-source execution metadata | Five tests passed: internally consistent zero-finding metadata is structurally accepted; unsafe fields/source mismatch/bad totals fail; operator self-review/self-approval and partial/gapped/unreconciled acceptance fail; future/wrong-year/placeholders/unowned/register mismatch fail; duplicate IDs/artifacts and overlapping unsuperseded history fail |
| Internal source-receipt review | Internal independent-context review, not third-party assurance, found no P1 and confirmed the earlier rejected-receipt CLI issue was already fixed; five remaining P2 issues covered future/placeholders, canonical binding, self-asserted reconciliation/artifacts, unprotected history, and overclaims; remaining in-repo gaps were hardened or claim-limited |
| Safe CodeQL importer gate | Eight importer tests passed: seven SARIF/source tests verify safe-field exclusion, severities, management preservation, retained history/ID reservation, reappearance, actionable states, tool and per-run provenance binding, active-closure rejection, exact closed-section evidence, stale-source rejection, duplicates, and mappings; one filesystem test verifies atomic replacement and concurrent-edit protection |
| Second internal CodeQL intake review | Four P1/P2 issues fixed: active scanner results cannot be closed, history requires an exact child row in the correct register section, non-idempotent scans must progress source identity/time, and every result-bearing SARIF run needs matching selected provenance; internal independent-context review only, not third-party assurance |
| Retained-SARIF importer dry run | Current schema-v3 baseline re-imported the hashed retained SARIF without writing: 51 active findings, 51 stable IDs/management records preserved, zero added, zero removed |
| Managed-release vulnerability gate | Intentionally exited 1 with exactly six blocker groups: `missingOwner: 51`, `missingDue: 51`, `pendingDisposition: 51`, `missingSourceOwner: 11`, `missingSourceEvidence: 9`, and `nonOperatingSource: 11`; this is accurate operational status, not a tooling failure |
| Vulnerability triage workshop | Added an accountable 51-child procedure bound to the existing safe baseline: exact mutable fields, four valid active decisions, individual handling for all 40 rate-limit results, prohibition on active closure, approved-SLA dependency, controlled identities/references, pre/post hashes, structural/strict interpretation, and required workshop outputs. No management field was fictionalized or changed |
| Safe CodeQL schema migration | Guarded dry run and write both imported 51 findings; the one-time v1 migration verified every prior finding was unmanaged before generating versioned schema-v3 fingerprints and an empty retained-history set |
| Importer guarded-write verification | A current-baseline dry run and atomic write both preserved 51 active IDs, added/removed zero, verified the expected raw SARIF hash, exact CodeQL driver, external run-receipt binding, current baseline hash, and structural output |
| Independent importer/verifier review | Six P1/P2 findings were reported and remediated: removal-history/ID reuse, register-ID binding, canonical timestamp comparison, concurrent-edit-safe atomic replacement, suppression/absent/kind handling, and tool/artifact/commit evidence binding |
| Safe CodeQL baseline source identity | `codeql-baseline-2026-07-16.json` SHA-256 `B815FDE6079C9607BDE1A7A1FF134827A4CD86708BD26C2F170A3BB0F49F3BFE`; artifact ID `8363921874` was available at `2026-07-16T20:52:20.2196104Z` and reports expiry `2026-08-15T03:17:21Z`; commit is bound to the matching GitHub Actions run receipt because this SARIF lacks embedded version-control provenance |
| Production verifier source identity | `production-control-verification.sql` SHA-256 `09C51D8D76BB5D468FEDB84D397FA35316CF3C6436048318B356A25569028CCB`; exact runtime-role and approved `search_path` checks; source only, not an execution receipt |
| Threat-model integrity test | 6 scripts tests passed after enforcing at least 20 contiguous threat IDs, exact grades, repository evidence paths, all nine trust boundaries, required STRIDE/AI categories, and explicit TN-TM-011/022/023 release blockers |
| Threat-model source identity | `threat-model.md` SHA-256 `34B5E35CA10D454FE5858BFDBA78A47743EAE4ACCF20549FF5E0AAE4211ACF8D`; engineering source only, not a signed review or risk acceptance |
| Patch whitespace | `git diff --check` passed |
| PCI/security Markdown links | All checked local targets resolved |
| Security-readiness continuity ledger | HTML parsed successfully with 11 unique IDs; required feedback, continuity, verification, blocker, and workstream markers were present; all 91 links/anchors resolved: 11 internal, 79 local artifacts, and one official external source |
| GitHub persistence | Primary package commit `b18f78e` contains 135 files and was pushed on `codex/pci-security-readiness-2026-07-16` to the repository now resolved as `ryanportfolio/Truenote`. Local `.pnpm-store/` is ignored. Repository inspection reported only the author account as a collaborator, so no draft PR reviewer or independent approval was fabricated |
| Security workflow invariants | Pull-request trigger present; prior PR exclusions absent; hosted PCI and vulnerability-baseline verifier steps, opt-in manual strict-release and branch-evidence gates, CodeQL `security-events: write`, unconditional SARIF retention, and `upload: always` present |
| Public security HTML | Python standard-library HTML parser completed without error; all 19 evidence grades use the approved vocabulary and include an adjacent evidence-scope label |

Focused tests covered LandingAI table escaping, production email fail-closed
behavior, configuration log non-echo, secret/SSN/payment-card redaction, and safe
error persistence/console formatting. Follow-up independent review added complete
PEM private-key block redaction and corrected public evidence grades and email
operations guidance. The workload-throttle tests exercise fixed-window counter
behavior, missing-schema failure handling, 429 response/audit behavior, and route
mount order. They do not prove production database, multi-replica, or edge-control
operation.

## Current integration condition

Remote `main` is four commits ahead of this worktree base. The remote comparison
reports one overlap with this tranche: `artifacts/api-server/src/app.ts`. Current
`main` added CSP nonce/HTML-serving changes there. The security error-log edit is
small, but integration/rebase and the complete verification suite must run again
against the combined current-main result before release.

## Verification still required

- GitHub must parse the updated workflow and complete all pull-request jobs.
- The CodeQL job must upload results into code scanning and retain SARIF.
- Every changed or remaining CodeQL alert must be reconciled to the vulnerability
  register; the safe baseline accounts for all 51 but the strict release gate
  remains blocked until owners, dates, dispositions, approvals, and retests are
  recorded as applicable. Local tests do not close SARIF findings.
- Required branch/ruleset checks and independent review must be enabled and
  captured.
- Replit deployment, production database definitions, provider settings,
  OpenRouter guardrail assignment/runtime redaction, IdP/MFA, SIEM delivery,
  backup/restore, and incident controls remain unverified.
- The local provider-firewall tests, downstream OpenAI/Cohere/OpenRouter synthetic
  receipts, contextual name/address treatment, data-policy approval, retrieval
  quality evaluation, and independent adversarial retest remain required.
- The eight-case AI regression runner still requires an authorized released test
  target, synthetic account/program, provider-cost approval, monitored execution,
  retained sanitized report, failure closure, and independent creative red team.
