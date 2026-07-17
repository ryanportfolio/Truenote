# Truenote application and PCI-impact threat model

**Status:** Engineering threat model; Product Security, PCI owner/QSA, and
independent reviewer approval missing  
**Model date:** 2026-07-16  
**Review cadence:** At least annually and after a material trust-boundary,
provider, identity, data-policy, deployment, or CDE change  
**Responsible role:** Product Security — unassigned

This model supports PCI DSS bespoke/custom software review and the Truenote secure
development lifecycle. It is not a penetration test, segmentation test, provider
attestation, risk acceptance, or proof that repository controls operate in
production.

## Scope and assumptions

In scope: browser/frontend, API, worker, object storage, PostgreSQL, authentication,
authorization, document ingestion, retrieval, generation, providers, audit/SIEM,
GitHub/CI, deployment configuration, and any path that could affect a CDE.

Current assumptions requiring owner approval:

- Truenote should not receive or retain PAN unless the PCI owner/QSA approves an
  explicit in-scope path.
- Application program/classification controls are not network segmentation.
- OpenRouter guardrails apply only to traffic actually routed through the assigned
  OpenRouter guardrail; they do not protect earlier direct OpenAI, Cohere,
  LandingAI, scanner, storage, database, logging, or email paths.
- Repository tests and DDL do not prove deployed configuration or operation.
- Provider contractual retention, ZDR, subprocessor, and PCI/CDE suitability
  remain third-party evidence.

## Security objectives and assets

1. Prevent cross-program, above-clearance, and unauthorized administrative access.
2. Prohibit or tightly control PAN, credentials, secrets, PII, and customer content
   across storage, logs, providers, evidence, and responses.
3. Activate only approved, scanned, attributable, correctly classified content.
4. Return grounded, cited answers or explicit refusal.
5. Preserve authentication, change, document-lifecycle, denial, and incident
   evidence against repudiation or silent loss.
6. Bound CPU, memory, storage, queue, provider-cost, and availability abuse without
   locking out employees behind shared office IPs.
7. Ensure only reviewed, tested, authorized changes reach production.
8. Prevent Truenote from weakening a CDE or claimed segmentation boundary.

Primary assets include account credentials and sessions, authorization/program
assignments, document source/content/classification, retrieval chunks, prompts and
conversation history, citations, model/provider configuration, security/audit
events, SIEM signing material, secrets, source/CI artifacts, database definitions,
and CDE connectivity or segmentation controls.

## Actors

- legitimate CSR, manager, senior manager, super user, reviewer, and operator;
- unauthenticated external attacker;
- attacker using stolen credentials/session state;
- malicious or compromised employee/content administrator;
- malicious document or prompt author;
- compromised provider, dependency, CI action, or maintainer account; and
- accidental operator/configuration error.

## Trust boundaries

| Boundary | Untrusted-to-trusted transition | Assets exposed | Current boundary evidence | Limitation |
|---|---|---|---|---|
| TB-01 Browser → API | Cookies, origins, request bodies, uploads, route parameters | Sessions, account actions, questions, files | Auth middleware, Origin/Fetch Metadata checks, schemas, file validation | Deployed proxy/origin/session configuration unverified |
| TB-02 API/worker → PostgreSQL | Application identity and parameterized statements | Users, content, chunks, logs, rate counters, audit/outbox | Parameter binding, program/classification predicates, P0/P1 DDL | Production definitions, runtime role privileges, encryption and backups unverified |
| TB-03 API → OpenAI/Cohere | Question and candidate excerpts before OpenRouter | Prompts, PII, regulated data, content | Local deterministic secret/SSN/PAN/email/structured-phone/IP firewall, fail-closed rescan, scoped retrieval, bounded calls | Names, addresses, ambiguous/encoded/contextual PII, deployed receipts and independent tests remain open |
| TB-04 API → OpenRouter/providers | Question, excerpts, history, rewrite/naming input | Prompts, content, PII | Same local deterministic firewall; pinned routes; ZDR/data-collection/fallback policy tests; owner screenshots | Guardrail assignment/runtime receipts and contextual PII coverage missing; output coverage separate |
| TB-05 Upload/storage → scanner/LandingAI | Raw untrusted bytes before parsed-text DLP | Files, embedded content, metadata, regulated data | Signatures, size/type validation, EICAR/scanner enforcement | Raw bytes reach storage/scanner/parser before parsed DLP; provider suitability/configuration unverified |
| TB-06 Retrieved content/provider output → answer | Untrusted excerpts and model text | CSR decisions, citations, sensitive output | Citation validation, cite-or-refuse, output sensitive scan | Broader PII/output policy and adversarial runtime testing incomplete |
| TB-07 API/database → SIEM | Security metadata and signed webhook | Audit integrity, incident evidence, signing key | Hash chain, transactional outbox, signed bounded delivery tests | Production delivery, alert, retention and dead-letter response unverified |
| TB-08 GitHub/CI → deployment | Source, dependencies, workflows, approvals, artifacts | Production code/configuration and evidence | Locked dependencies, scans, SBOM, PR template, evidence gate | Branch protection, CODEOWNER, named reviewer and current hosted receipts missing |
| TB-09 Replit/Neon/providers ↔ CDE | Hosting, network paths, administrator access | CDE reachability and segmentation | Scope/data-flow and independent-test plan | Boundary/applicability unsigned; no independent segmentation evidence |

## Risk method

`Critical` and `High` are engineering prioritization labels, not approved PCI risk
ratings. Product Security must assess likelihood, exploitability, deployed exposure,
data/CDE impact, and compensating controls. No row in this document constitutes
risk acceptance. Grades use the exact evidence vocabulary in
[`docs/security/README.md`](../../security/README.md).

## Threat and abuse-case register

| ID | Category | Threat / abuse case | Boundary and inherent priority | Current repository control/evidence | Grade | Residual action and accountable role |
|---|---|---|---|---|---|---|
| TN-TM-001 | Spoofing | Attacker forges OIDC state, callback, or session identity | TB-01; Critical | Signed PKCE state, issuer/audience/JWKS checks, session binding; `artifacts/api-server/src/lib/auth/oidc.ts`, `artifacts/api-server/src/lib/auth/__tests__/oidc.test.ts` | Verified | Retain production IdP/MFA/ACR, cookie/proxy, invalid-callback, and break-glass evidence — IAM owner |
| TN-TM-002 | Spoofing / DoS | Credential stuffing, password guessing, or account enumeration | TB-01; High | Argon2, generic recovery behavior, login IP limiter; `artifacts/api-server/src/lib/auth/rate-limit.ts`, `artifacts/api-server/src/routes/auth.ts` | Implemented, unverified | Approve shared-office thresholds; verify proxy IP, distributed attack, MFA and alert behavior — IAM/SecOps |
| TN-TM-003 | Elevation of privilege | Manager or compromised account creates/modifies a user beyond permitted role/program | TB-01/TB-02; Critical | Role/program assignment checks and TOCTOU negative tests; `artifacts/api-server/src/routes/admin/users.ts`, `artifacts/api-server/src/lib/security/__tests__/negative-controls.test.ts` | Verified | Independent API authorization test and deployed audit receipts — Product Security |
| TN-TM-004 | Tampering / Elevation | Cross-origin or same-site sibling triggers authenticated mutation | TB-01; High | Exact trusted-origin and Fetch Metadata enforcement; `artifacts/api-server/src/middleware/browser-security.ts`, `artifacts/api-server/src/middleware/__tests__/browser-security.test.ts` | Verified | Verify deployed canonical origins, proxy headers and browser behavior — Platform/Security |
| TN-TM-005 | Information disclosure | Query, session, citation, or document crosses program boundary | TB-01/TB-02/TB-06; Critical | Server-side program predicates plus fail-closed scope checks and negative tests; `artifacts/api-server/src/lib/retrieval/query.ts`, `artifacts/api-server/src/lib/security/__tests__/negative-controls.test.ts` | Verified | Independent horizontal-access test and production role/data sampling — Product Security |
| TN-TM-006 | Information disclosure | User retrieves content above assigned classification | TB-02/TB-06; Critical | Clearance lookup, SQL classification predicates, lifecycle filtering and tests; `artifacts/api-server/src/lib/security/classification.ts`, `artifacts/api-server/src/lib/retrieval/query.ts` | Verified | Verify production constraints/assignments and independent vertical-access test — Data owner/Product Security |
| TN-TM-007 | Tampering / Injection | Untrusted input changes SQL/query semantics or bypasses scope | TB-01/TB-02; Critical | Parameterized Drizzle SQL, strict schemas, fixed identifiers; `artifacts/api-server/src/lib/retrieval/query.ts`, `artifacts/api-server/src/routes` | Implemented, unverified | Dedicated injection test across API, filters, sorting, identifiers and database errors — Independent tester |
| TN-TM-008 | AI prompt injection | User or retrieved content overrides system rules, leaks context, or bypasses cite/refuse | TB-03/TB-04/TB-06; High | Local pattern detection, OpenRouter prompt-injection configuration, citation/refusal enforcement, tested synthetic regression harness; `artifacts/api-server/src/lib/security/content-scan.ts`, `docs/compliance/pci/ai-adversarial-regression.md`, `docs/compliance/pci/openrouter-guardrail-evidence.md` | Configuration required | Run deployed regression; prove guardrail assignment/runtime; commission independent indirect-injection, encoding, multi-turn and context-exfiltration red team — Product Security |
| TN-TM-009 | AI data poisoning | Malicious or incorrect document becomes active trusted context | TB-05/TB-06; Critical | Source registry, scan/quarantine, role review, lifecycle/active constraints and negative tests; `artifacts/api-server/src/routes/documents.ts`, `docs/security/p0-p1-security-controls.sql` | Implemented, unverified | Verify production DDL, provenance review, malicious-document tests and source-owner recertification — Data owner |
| TN-TM-010 | Malware / Tampering | Uploaded polyglot, archive, macro, or scanner-evasion payload harms processing or users | TB-05; Critical | Signature/size/type checks, EICAR and default-on scanner policy; `artifacts/api-server/src/lib/security/malware-policy.ts`, `artifacts/api-server/src/lib/security/__tests__/content-scan.test.ts` | Configuration required | Verify production scanner/auth/availability, file corpus, parser isolation and no unsafe download — Platform/Security |
| TN-TM-011 | Information disclosure | PII bypasses or exceeds the local pre-provider firewall and reaches OpenAI/Cohere before OpenRouter | TB-03; Critical if CDE/prohibited data | Deterministic secret/SSN/PAN/email/structured-phone/IPv4/IPv6 redaction now runs at embedding/rerank boundaries with fail-closed rescan; `docs/compliance/pci/provider-input-firewall.md`, `artifacts/api-server/src/lib/security/provider-input-firewall.ts` | Implemented, unverified | Approve data policy; pass CI/runtime canaries; add approved contextual name/address and obfuscation handling or prohibit/accept remaining classes; independent retest — PCI/Data owner/Product Security |
| TN-TM-012 | Third-party disclosure | Provider retains, trains on, reroutes, or sub-processes prompts/content contrary to policy | TB-03/TB-04/TB-05; Critical | OpenRouter route/ZDR/no-collection/no-fallback tests; `artifacts/api-server/src/lib/generation/model-routing.ts`, `docs/compliance/pci/third-party-responsibility-matrix.md` | Third-party evidence required | Obtain contracts/account exports/subprocessor and PCI/CDE decisions for every provider — Vendor-risk/PCI owner |
| TN-TM-013 | Information disclosure | Model response exposes PAN, credentials, secrets, or broader PII | TB-06; Critical | Narrow output refusal for PAN/SSN/credentials/private keys; `artifacts/api-server/src/lib/generation/answer.ts`, `artifacts/api-server/src/lib/generation/__tests__/answer.test.ts` | Implemented, unverified | Approve broader output policy; adversarially test names/address/phone/email/IP and encoded/fragmented values — Product Security/Data owner |
| TN-TM-014 | Integrity / AI hallucination | CSR receives unsupported procedure, fee, date, or policy | TB-06; High | Valid citation required or standard refusal; eval harness; `artifacts/api-server/src/lib/generation/answer.ts`, `artifacts/api-server/src/lib/eval` | Verified | Retain released-model eval and independent domain/adversarial results — Product/Data owner |
| TN-TM-015 | Information disclosure / Integrity | Citation points outside authorized content or to stale/revoked evidence | TB-02/TB-06; Critical | Immutable citation snapshots, ownership/version/lifecycle checks and tests; `artifacts/api-server/src/lib/citations.ts`, `artifacts/api-server/src/lib/__tests__/citations.test.ts` | Verified | Independent citation authorization/staleness test in deployed release — Product Security |
| TN-TM-016 | Repudiation / Tampering | Actor alters/deletes security events or breaks hash continuity | TB-02/TB-07; High | Append-only trigger, serialized hash chain, audit logic; `docs/security/p0-p1-security-controls.sql`, `artifacts/api-server/src/lib/security/audit.ts` | Implemented, unverified | Execute production catalog verifier and mutation/hash-chain exercise with retained output — Platform/SecOps |
| TN-TM-017 | Repudiation / Availability | SIEM event is silently dropped, replayed, stuck, or dead-lettered without response | TB-07; High | Transactional outbox, lease fencing, signing, retry/dead-letter tests; `artifacts/api-server/src/lib/security/siem-outbox.ts`, `docs/compliance/pci/production-evidence-capture-runbook.md` | Operational evidence required | Run delivery/retry/dead-letter/alert exercises and assign responder/retention — SecOps |
| TN-TM-018 | Denial of service / Cost | Authenticated actor exhausts parsing, Argon2, queue, model, or storage capacity | TB-01/TB-03/TB-05; High | Per-user/program ask limits and per-user workload buckets; `artifacts/api-server/src/lib/security/distributed-rate-limit.ts`, `docs/compliance/pci/rate-limit-route-assessment-2026-07-16.md` | Implemented, unverified | Capacity-test thresholds, multi-replica consistency, edge/read/OIDC controls and cleanup — Platform/Security |
| TN-TM-019 | Tampering / Disclosure | Encoded or crafted asset path escapes fixed static root or serves unintended content | TB-01; High | Flat basename allowlist/fixed root and traversal tests; `artifacts/api-server/src/lib/security/static-assets.ts`, `artifacts/api-server/src/lib/security/__tests__/static-assets.test.ts` | Verified | Hosted HTTP test for encoded separators, alternate normalization and proxy behavior — Platform/Security |
| TN-TM-020 | Information disclosure | Secrets, private keys, PAN/SSN, or multiline attacker text enters logs/evidence/email fallback | TB-02/TB-07/TB-08; Critical | Recursive redaction, complete PEM handling, single-line safe errors, production email fail-closed tests; `artifacts/api-server/src/lib/observability/error-log.ts`, `artifacts/api-server/src/lib/email/sender.ts` | Implemented, unverified | Production log/SIEM/email synthetic canaries, retention/access review and historical secret scan — SecOps/Product Security |
| TN-TM-021 | Supply chain | Compromised dependency, install script, action, or artifact reaches build/release | TB-08; Critical | Frozen lockfile, central overrides, one-package build allowlist, audit/SBOM/Gitleaks/CodeQL workflow, evidence gate; `pnpm-workspace.yaml`, `.github/workflows/security.yml` | Implemented, unverified | Hosted reviewed-commit receipts, action pinning policy, finding disposition and artifact provenance — Engineering/Product Security |
| TN-TM-022 | Tampering / Repudiation | Author bypasses review/checks or changes workflow/evidence before deployment | TB-08; Critical | PR/change templates and structural evidence gate; `.github/pull_request_template.md`, `scripts/src/verify-pci-evidence.ts` | Gap | Assign reviewer/CODEOWNER/change authority; enforce protected branch/ruleset and capture settings/API evidence — Engineering/Security |
| TN-TM-023 | Elevation / CDE impact | Truenote or provider path bypasses/weakens CDE segmentation or becomes an unassessed path | TB-09; Critical | Scope/data-flow record and independent segmentation test plan; `docs/compliance/pci/scope-and-data-flow.md`, `docs/compliance/pci/independent-testing-plan.md` | Gap | QSA signs boundary; implement approved network controls; independent Requirement 11.4 segmentation test — PCI/Platform |
| TN-TM-024 | Availability / Integrity | Backup is absent, corrupt, over-retained, or cannot restore securely | TB-02/TB-09; High | Responsibility/evidence requirement documented; `docs/compliance/pci/evidence-index.md`, `docs/compliance/pci/third-party-responsibility-matrix.md` | Operational evidence required | Approve RTO/RPO/retention/encryption; perform isolated restore and access/integrity test — Platform/database owner |
| TN-TM-025 | Insider / Tampering | Authorized uploader/admin activates malicious content, changes security settings, or abuses purge/reset capability | TB-01/TB-02/TB-05; Critical | Role gates, lifecycle constraints, demo-write blocks, audit events and negative tests; `artifacts/api-server/src/routes/documents.ts`, `artifacts/api-server/src/lib/security/__tests__/negative-controls.test.ts` | Implemented, unverified | Approve separation/risk rules, monitor privileged actions, recertify access, independently test abuse cases — Security/Data/IAM owners |
| TN-TM-026 | Race / Business logic | Concurrent approval, revocation, purge, queue, evaluation, or user-role changes defeat checked state | TB-01/TB-02; High | Conditional SQL updates, lease fencing, one-active-run constraints, TOCTOU tests; `artifacts/api-server/src/lib/eval/persistence.ts`, `artifacts/api-server/src/lib/security/__tests__/negative-controls.test.ts` | Verified | Multi-replica concurrency tests for lifecycle/user/evaluation paths and deployed database constraints — Product Security/Platform |

## Priority treatment plan

### Release/CDE blockers

1. **TN-TM-011:** Approve prohibited data, verify the implemented direct-provider
   firewall in CI/runtime, and treat names/addresses/contextual PII with an
   approved control, prohibition, or time-bounded acceptance. OpenRouter
   screenshots do not close this.
2. **TN-TM-023:** Obtain a signed CDE boundary and independent segmentation test.
3. **TN-TM-022:** Enforce non-author review and required checks on protected
   `main`.
4. **TN-TM-016/TN-TM-017:** Verify production database/audit/SIEM definitions and
   end-to-end operation.
5. **TN-TM-008/TN-TM-009/TN-TM-010/TN-TM-013:** Commission adversarial prompt,
   document, file, and output testing with retest closure.

### Required operational evidence

- IdP/MFA, proxy/session and access-review evidence for TN-TM-001/002/003.
- Provider contract/configuration evidence for TN-TM-010/012.
- Capacity, edge, replica and cleanup evidence for TN-TM-018.
- Logging/retention canaries for TN-TM-020.
- Hosted supply-chain receipts for TN-TM-021.
- Restore exercise for TN-TM-024.

## Review triggers

Re-review before release when any of these changes:

- CDE/PAN policy, segmentation, hosting, domains, proxy, identity, roles or sessions;
- provider, model, routing, retention/ZDR, guardrail, embedding, reranking, parsing,
  scanner, email, SIEM, object storage or database;
- upload type/size, document lifecycle, classification, source approval, retrieval,
  citation/refusal, prompt or output handling;
- security DDL, audit schema, rate-limit scope/threshold, queue/concurrency behavior;
- dependency/CI action, branch/release process, secret/artifact retention; or
- a vulnerability, incident, penetration test, material abuse case or recurring
  control failure.

## Acceptance and sign-off

This threat model becomes operational evidence only when:

- Product Security confirms scope, threats, priority and control mappings;
- the PCI owner/QSA records CDE applicability and PAN/provider decisions;
- every Critical/High residual action has a named owner, due date and finding or
  change identifier;
- an independent reviewer confirms the model against code, deployed architecture,
  provider/configuration evidence and test scope;
- blocking treatments are implemented or covered by formal time-bounded approval;
- required penetration, AI red-team and segmentation results are linked; and
- sign-off identity/date plus next review date are retained in the restricted
  evidence system.

Until then, the model is **Implemented, unverified** and every stated gap remains
open.
