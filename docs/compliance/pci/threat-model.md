# Truenote application and PCI-impact threat model

**Status:** Engineering threat model; Product Security, PCI owner/QSA, and
independent reviewer approval missing  
**Model date:** 2026-07-16; TB-08, TB-09 and TN-TM-022 updated 2026-10-07 for Railway hosting  
**Review cadence:** At least annually and after a material trust-boundary,
provider, identity, data-policy, deployment, or CDE change  
**Responsible role:** Product Security — unassigned

This model supports PCI DSS bespoke/custom software review and the Truenote secure
development lifecycle. It is not a penetration test, segmentation test, provider
attestation, risk acceptance, or proof that repository controls operate in
production.

## Scope and assumptions

In scope: browser/frontend, API, worker, object storage, PostgreSQL, authentication,
authorization, document ingestion, retrieval, generation, providers, audit/alerting,
GitHub/CI, deployment configuration, the compliance question-and-answer flow, and
any path that could affect a CDE.

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
events, the exported log copy and its Railway token, secrets, source/CI artifacts, database definitions,
Truenote's own compliance documents (system security plan, plan of action and
milestones, assessment results), which describe controls and open weaknesses,
together with their passage vectors and the questions asked about them,
and CDE connectivity or segmentation controls.

## Actors

- legitimate CSR, manager, senior manager, super user, reviewer, and operator;
- unauthenticated external attacker;
- attacker using stolen credentials/session state;
- malicious or compromised employee/content administrator;
- malicious document or prompt author;
- compromised provider, dependency, CI action, or maintainer account; and
- accidental operator/configuration error.

## Compliance question-and-answer flow

Super users can ask questions about Truenote's own compliance documents on the
Compliance page and get a cited answer or the standard refusal. The documents are
the system security plan, the plan of action and milestones and assessment
results. They name controls, owners, dates and open weaknesses, so the flow treats
them as security-sensitive and keeps them out of the public repository, out of
PostgreSQL and away from customer retrieval. Trust boundary TB-10 and threats
TN-TM-027 to TN-TM-034 cover it.

1. **Documents.** The owner uploads Markdown (and optional PDF) files with
   `scripts/src/upload-compliance-docs.ts`, using the web service's object-storage
   credentials. Each version is stored under a content-addressed key
   `compliance/documents/<slug>/<sha256>.md`; `compliance/manifest.json` is written
   last and lists every document's slug, title, version, date and SHA-256
   (`artifacts/api-server/src/lib/compliance/documents.ts`).
2. **Request.** `POST /api/compliance/ask` takes a question of 1 to 1,000
   characters behind `requireAuth`, `requireFreshPassword` and
   `requireComplianceReader` (minimum role `COMPLIANCE_MIN_ROLE`, `super_user`),
   with a limit of 10 questions a minute per user
   (`artifacts/api-server/src/routes/compliance.ts`,
   `artifacts/api-server/src/middleware/current-user.ts`,
   `artifacts/api-server/src/lib/security/route-rate-limit.ts`). One deadline
   bounds the whole request, index build included, and a closed connection
   aborts it.
3. **Index.** The web process holds the search index in memory, keyed by a hash
   of the manifest's document list. Every question reads the manifest first and
   rebuilds the index when the hash differs. Each document is checked against its
   manifest SHA-256 before it is split into passages. Passage vectors are cached
   in object storage at `compliance/index/<hash>.json`, keyed by the manifest
   hash, chunker version and embedding route; the cache holds vectors and passage
   hashes only, and an entry that does not match the passages exactly is ignored
   (`artifacts/api-server/src/lib/compliance/search-index.ts`).
4. **Retrieval.** The question is embedded, scored by cosine similarity and BM25
   (top 40 each), merged, and reranked to the top 8. When the top rerank score is
   below `COMPLIANCE_RERANK_THRESHOLD` (default 0.5) the answer is the refusal and
   no generation call is made (`artifacts/api-server/src/lib/compliance/ask.ts`).
5. **Providers.** Embedding (`openai/text-embedding-3-small` on Azure) and rerank
   (`qwen/qwen3-reranker-8b` on Fireworks) go through OpenRouter, each request
   pinned to one provider with `zdr=true`, `data_collection=deny` and
   `allow_fallbacks=false`. The typed question passes the full local provider
   firewall; document text gets the blocking classes (secrets, SSNs, payment
   cards) (`artifacts/api-server/src/lib/compliance/providers.ts`). Generation
   uses the compliance model chain, which holds only routes from the approved
   ZDR-pinned allowlist (`artifacts/api-server/src/lib/generation/model-routing.ts`,
   `artifacts/api-server/src/lib/generation/answer.ts`).
6. **Answer.** The compliance system prompt treats excerpts as untrusted data and
   forbids outside knowledge and invented control ids, dates, owners or statuses.
   The shared answer gates refuse an answer without valid inline citations, with
   a figure absent from its cited excerpt, or with blocked sensitive content. An
   answer whose citations resolve to no passage is returned as the refusal.
7. **Record, then deliver.** The route records a `compliance.question` security
   event with the question's SHA-256 and length (never its text), the refused
   flag, the cited documents (slug, SHA-256, version), the passage count, the
   manifest hash and the generation path. The answer is sent only after that
   write succeeds, and only if the manifest is unchanged before and after the
   write; otherwise the user gets a 409 (ask again) or 503 and a failure event is
   recorded (`artifacts/api-server/src/routes/compliance.ts`,
   `artifacts/api-server/src/lib/security/audit.ts`).

Example questions for the question box are written by the compliance model chain
from document passages, kept only when the compliance retrieval answers them from
the same document and the provider firewall would redact nothing, and cached at
`compliance/suggestions/`. Returning them records `compliance.suggestions_read`
(`artifacts/api-server/src/lib/compliance/suggestions.ts`).

## Trust boundaries

| Boundary | Untrusted-to-trusted transition | Assets exposed | Current boundary evidence | Limitation |
|---|---|---|---|---|
| TB-01 Browser → API | Cookies, origins, request bodies, uploads, route parameters | Sessions, account actions, questions, files | Auth middleware, Origin/Fetch Metadata checks, schemas, file validation | Deployed proxy/origin/session configuration unverified |
| TB-02 API/worker → PostgreSQL | Application identity and parameterized statements | Users, content, chunks, logs, rate counters, audit/outbox | Parameter binding, program/classification predicates, P0/P1 DDL | Production definitions, runtime role privileges, encryption and backups unverified |
| TB-03 API → OpenAI/Cohere | Question and candidate excerpts before OpenRouter | Prompts, PII, regulated data, content | Local deterministic secret/SSN/PAN/email/structured-phone/IP firewall, fail-closed rescan, scoped retrieval, bounded calls | Names, addresses, ambiguous/encoded/contextual PII, deployed receipts and independent tests remain open |
| TB-04 API → OpenRouter/providers | Question, excerpts, history, rewrite/naming input | Prompts, content, PII | Same local deterministic firewall for the question, history, rewrite and naming input (since 2026-10-10 approved excerpts get secret/SSN/PAN redaction only); pinned routes; ZDR/data-collection/fallback policy tests; owner screenshots | Guardrail assignment/runtime receipts and contextual PII coverage missing; output coverage separate |
| TB-05 Upload/storage → scanner/LandingAI | Raw untrusted bytes before parsed-text DLP | Files, embedded content, metadata, regulated data | Signatures, size/type validation, EICAR/scanner enforcement | Raw bytes reach storage/scanner/parser before parsed DLP; provider suitability/configuration unverified |
| TB-06 Retrieved content/provider output → answer | Untrusted excerpts and model text | CSR decisions, citations, sensitive output | Citation validation, cite-or-refuse, output sensitive scan | Broader PII/output policy and adversarial runtime testing incomplete |
| TB-07 API/database → logs, alert email and log copy | Security metadata in worker log lines, alert emails through Resend, and a daily export to a private GitHub repository | Audit integrity, incident evidence, the Railway token used by the export | Hash chain, ordered cursor over committed events, alert rules, audit-write-failure alert outside the database, uptime check | Ten of eleven alert rules tested in production on 2026-10-10 (break-glass waits for SSO); retention period open; daily log export running since 2026-10-10 |
| TB-08 GitHub/CI and operator workstation → Railway deployment | Source, dependencies, workflows, approvals, artifacts; `railway up` uploads of an operator's local checkout | Production code/configuration and evidence | Locked dependencies, scans, SBOM, PR template, evidence gate | Branch protection, CODEOWNER, named reviewer and current hosted receipts missing. Deploys are `railway up` uploads from an operator workstation; merging to `main` deploys nothing. Nothing ties the deployed bytes to a CI-verified `main` commit |
| TB-09 Railway/Replit/providers ↔ CDE | Hosting, network paths, administrator access: Railway `web` and `worker` services, Railway Postgres 18 with pgvector, Railway Bucket object storage; Namecheap as registrar and DNS host for `truenote.org` since 2026-10-14; Replit holds no production role (its deployment was unpublished on 2026-10-12); AI providers | CDE reachability and segmentation | Scope/data-flow and independent-test plan | Boundary/applicability unsigned; no independent segmentation evidence |
| TB-10 Super user, object storage and ZDR providers ↔ compliance question flow | Typed question from a signed-in super user; compliance document text read from object storage; question and passages sent to OpenRouter ZDR endpoints; model text returned as an answer | Truenote's compliance documents, which describe controls and open weaknesses; questions that can quote them; passage vectors and example questions cached in object storage | Role and fresh-password gates, per-user limit, manifest SHA-256 checks, index separate from PostgreSQL, ZDR-pinned provider requests, cite-or-refuse and figure gates, audit event recorded before delivery | No compliance eval set and an untuned rerank threshold; no deterministic prompt-injection scan of compliance documents; provider ZDR is third-party evidence; a holder of the bucket credentials can replace documents and manifest together |

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
| TN-TM-017 | Repudiation / Availability | A security event or alert is silently skipped, suppressed, or delayed, or the off-Railway log copy stops | TB-07; High | Cursor over committed events in sequence order, email retry without advancing the cursor, two-minute pass deadline, monitor-failing and audit-write-failure alerts, export that fails rather than writing a partial day; `artifacts/api-server/src/lib/monitoring/security-monitor.ts`, `docs/security/monitoring.md` | Operational evidence required | Test the break-glass alert once SSO is on, set retention and assign the responder; owner: SecOps |
| TN-TM-018 | Denial of service / Cost | Authenticated actor exhausts parsing, Argon2, queue, model, or storage capacity | TB-01/TB-03/TB-05; High | Per-user/program ask limits and per-user workload buckets; `artifacts/api-server/src/lib/security/distributed-rate-limit.ts`, `docs/compliance/pci/rate-limit-route-assessment-2026-07-16.md` | Implemented, unverified | Capacity-test thresholds, multi-replica consistency, edge/read/OIDC controls and cleanup — Platform/Security |
| TN-TM-019 | Tampering / Disclosure | Encoded or crafted asset path escapes fixed static root or serves unintended content | TB-01; High | Flat basename allowlist/fixed root and traversal tests; `artifacts/api-server/src/lib/security/static-assets.ts`, `artifacts/api-server/src/lib/security/__tests__/static-assets.test.ts` | Verified | Hosted HTTP test for encoded separators, alternate normalization and proxy behavior — Platform/Security |
| TN-TM-020 | Information disclosure | Secrets, private keys, PAN/SSN, or multiline attacker text enters logs/evidence/email fallback | TB-02/TB-07/TB-08; Critical | Recursive redaction, complete PEM handling, single-line safe errors, production email fail-closed tests; `artifacts/api-server/src/lib/observability/error-log.ts`, `artifacts/api-server/src/lib/email/sender.ts` | Implemented, unverified | Production log, exported-log and email synthetic canaries, retention/access review and historical secret scan — SecOps/Product Security |
| TN-TM-021 | Supply chain | Compromised dependency, install script, action, or artifact reaches build/release | TB-08; Critical | Frozen lockfile, central overrides, one-package build allowlist, audit/SBOM/Gitleaks/CodeQL workflow, evidence gate; `pnpm-workspace.yaml`, `.github/workflows/security.yml` | Implemented, unverified | Hosted reviewed-commit receipts, action pinning policy, finding disposition and artifact provenance — Engineering/Product Security |
| TN-TM-022 | Tampering / Repudiation | Author bypasses review/checks or changes workflow/evidence before deployment, or an operator's `railway up` upload deploys bytes that differ from the CI-verified `main` commit | TB-08; Critical | PR/change templates and structural evidence gate; `.github/pull_request_template.md`, `scripts/src/verify-pci-evidence.ts` | Gap | Assign reviewer/CODEOWNER/change authority; enforce protected branch/ruleset and capture settings/API evidence; bind each Railway deployment to a CI-verified `main` commit and record the deployed commit. Accountable: Engineering/Security |
| TN-TM-023 | Elevation / CDE impact | Truenote or provider path bypasses/weakens CDE segmentation or becomes an unassessed path | TB-09; Critical | Scope/data-flow record and independent segmentation test plan; `docs/compliance/pci/scope-and-data-flow.md`, `docs/compliance/pci/independent-testing-plan.md` | Gap | QSA signs boundary; implement approved network controls; independent Requirement 11.4 segmentation test — PCI/Platform |
| TN-TM-024 | Availability / Integrity | Backup is absent, corrupt, over-retained, or cannot restore securely | TB-02/TB-09; High | Responsibility/evidence requirement documented; `docs/compliance/pci/evidence-index.md`, `docs/compliance/pci/third-party-responsibility-matrix.md` | Operational evidence required | Approve RTO/RPO/retention/encryption; perform isolated restore and access/integrity test — Platform/database owner |
| TN-TM-025 | Insider / Tampering | Authorized uploader/admin activates malicious content, changes security settings, or abuses purge/reset capability | TB-01/TB-02/TB-05; Critical | Role gates, lifecycle constraints, demo-write blocks, audit events and negative tests; `artifacts/api-server/src/routes/documents.ts`, `artifacts/api-server/src/lib/security/__tests__/negative-controls.test.ts` | Implemented, unverified | Approve separation/risk rules, monitor privileged actions, recertify access, independently test abuse cases — Security/Data/IAM owners |
| TN-TM-026 | Race / Business logic | Concurrent approval, revocation, purge, queue, evaluation, or user-role changes defeat checked state | TB-01/TB-02; High | Conditional SQL updates, lease fencing, one-active-run constraints, TOCTOU tests; `artifacts/api-server/src/lib/eval/persistence.ts`, `artifacts/api-server/src/lib/security/__tests__/negative-controls.test.ts` | Verified | Multi-replica concurrency tests for lifecycle/user/evaluation paths and deployed database constraints — Product Security/Platform |
| TN-TM-027 | AI prompt injection | Text in a compliance document or the typed question tells the model to ignore its rules, reveal the prompt or other excerpts, or emit a link or image that carries document text to an outside host | TB-10/TB-06; High | Compliance system prompt treats excerpts as untrusted data and forbids outside knowledge; answers need valid inline citations and grounded figures; answer Markdown renders links as plain text and the content security policy allows images only from `'self'`, `data:` and `blob:`; documents enter only through the owner's upload script, not user upload; `artifacts/api-server/src/lib/compliance/ask.ts`, `artifacts/rag-app/src/components/chat/AnswerMarkdown.tsx`, `artifacts/api-server/src/middleware/browser-security.ts` | Implemented, unverified | Run injection cases against the compliance corpus (instructions inside a document, encoded text, requests for other documents or the prompt) and keep the results; compliance documents get no deterministic injection-pattern scan. Accountable: Product Security |
| TN-TM-028 | Information disclosure / Elevation | A user below the compliance role, a user who must reset a password, or a customer query reaches compliance text that describes controls and weaknesses | TB-01/TB-10; Critical | `requireAuth`, `requireFreshPassword` and `requireComplianceReader` (`COMPLIANCE_MIN_ROLE` `super_user`) on every `/api/compliance` route; the index lives in the web process and object storage, never PostgreSQL; compliance passages carry scope `compliance`, which customer scope filtering drops; import-isolation and per-role 401/403/423 tests; `artifacts/api-server/src/routes/compliance.ts`, `artifacts/api-server/src/middleware/current-user.ts`, `artifacts/api-server/src/lib/compliance/__tests__/isolation.test.ts`, `artifacts/api-server/src/routes/__tests__/compliance-routes.test.ts` | Verified | Independent access test on the deployed service; review super-user accounts, since every super user reads every compliance document; widening `COMPLIANCE_MIN_ROLE` changes this model. Accountable: IAM owner/Product Security |
| TN-TM-029 | Information disclosure | Question or answer text, which can quote weaknesses, lands in security events, the application error log, provider error messages or cached objects | TB-07/TB-10; High | `compliance.question` stores the question's SHA-256 and length, not its text; generation diagnostics run with `omitAnswerText`; provider errors keep only stage and HTTP status; the vector cache holds vectors and passage hashes only; manifest parse errors name field paths only; `artifacts/api-server/src/routes/compliance.ts`, `artifacts/api-server/src/lib/compliance/providers.ts`, `artifacts/api-server/src/lib/compliance/search-index.ts`, `artifacts/api-server/src/routes/__tests__/compliance-ask.test.ts` | Implemented, unverified | Production log and error-log canary with a synthetic compliance question; include `compliance/` objects in the bucket access review. Accountable: SecOps |
| TN-TM-030 | Third-party disclosure | Embedding, rerank or generation provider retains, trains on or reroutes compliance passages or questions | TB-10; High | Every compliance provider call goes through OpenRouter pinned to one provider with `zdr=true`, `data_collection=deny`, `allow_fallbacks=false`; the compliance chain holds only allowlisted ZDR routes; the question gets the full local firewall, document text the blocking classes; provider tests check the request body; `artifacts/api-server/src/lib/compliance/providers.ts`, `artifacts/api-server/src/lib/generation/model-routing.ts`, `artifacts/api-server/src/lib/compliance/__tests__/providers.test.ts` | Third-party evidence required | OpenRouter account ZDR settings and the retention terms of Azure, Fireworks and each generation provider; re-check the ZDR endpoint index before any re-pin. Accountable: Vendor-risk owner |
| TN-TM-031 | Integrity / AI hallucination | Answer misstates a control, status, owner, date or remediation, or cites a superseded document version | TB-06/TB-10; High | Cosine plus BM25 retrieval, rerank and a confidence gate that refuses with no model call; prompt forbids invented control ids, dates, owners and statuses; cite-or-refuse, figure-grounding and empty-citation refusal; manifest re-read before and after the record, so a changed manifest returns 409 instead of an answer; `artifacts/api-server/src/lib/compliance/ask.ts`, `artifacts/api-server/src/lib/generation/answer.ts`, `artifacts/api-server/src/routes/__tests__/compliance-ask.test.ts` | Implemented, unverified | No compliance eval set exists and the 0.5 rerank threshold is not tuned against labeled questions; an answer restates the documents and does not prove a control operates. Accountable: Compliance owner/Product Security |
| TN-TM-032 | Tampering | A compliance document, the manifest or the vector cache is altered in object storage, or a partial upload is served | TB-10; High | Content-addressed keys and a strict manifest schema; manifest written last; each document checked against its manifest SHA-256, and a mismatch withholds every passage and records a failure event; index rebuilt when the manifest hash changes; cache entries used only when passage ids and hashes match, and passage text never comes from the cache; `artifacts/api-server/src/lib/compliance/documents.ts`, `artifacts/api-server/src/lib/compliance/search-index.ts`, `scripts/src/upload-compliance-docs.ts` | Implemented, unverified | The hashes catch corruption and partial writes, not a holder of the bucket credentials, who can replace documents and manifest together; restrict and review those credentials. Accountable: Platform/Compliance owner |
| TN-TM-033 | Denial of service / Cost | A signed-in super user or stolen session floods questions to run up provider cost or stall the web process | TB-01/TB-10; High | 10 questions and 60 reads a minute per user; strict 1 to 1,000 character schema; one deadline over the whole request; client close aborts; one shared index build; embedding batches of 100 with four in flight and cancel-on-first-failure; rerank failure returns 503 rather than unranked passages; `artifacts/api-server/src/lib/security/route-rate-limit.ts`, `artifacts/api-server/src/routes/compliance.ts`, `artifacts/api-server/src/lib/compliance/providers.ts` | Implemented, unverified | Capacity test of a cold index build under load and an OpenRouter spend alert. Accountable: Platform |
| TN-TM-034 | Repudiation | A compliance question is answered, or a compliance document read, with no audit record | TB-07/TB-10; High | The answer goes out only after `compliance.question` (refused flag included) is recorded within the request deadline; document and example-question reads are recorded before delivery; integrity failures, manifest changes and provider outages record failure events; a failed audit write raises an alert outside the database; `artifacts/api-server/src/routes/compliance.ts`, `artifacts/api-server/src/lib/security/audit.ts`, `artifacts/api-server/src/routes/__tests__/compliance-ask.test.ts` | Implemented, unverified | Deployed exercise showing the event and a forced audit-write failure; the event holds a hash, so an investigator can confirm a known question but cannot read an unknown one. Accountable: SecOps |

## Priority treatment plan

### Release/CDE blockers

1. **TN-TM-011:** Approve prohibited data, verify the implemented direct-provider
   firewall in CI/runtime, and treat names/addresses/contextual PII with an
   approved control, prohibition, or time-bounded acceptance. OpenRouter
   screenshots do not close this.
2. **TN-TM-023:** Obtain a signed CDE boundary and independent segmentation test.
3. **TN-TM-022:** Enforce non-author review and required checks on protected
   `main`, and tie each Railway deployment to a CI-verified `main` commit.
4. **TN-TM-016/TN-TM-017:** Verify production database/audit/monitoring definitions and
   end-to-end operation.
5. **TN-TM-008/TN-TM-009/TN-TM-010/TN-TM-013/TN-TM-027:** Commission adversarial
   prompt, document, file, and output testing with retest closure, including the
   compliance corpus.

### Required operational evidence

- IdP/MFA, proxy/session and access-review evidence for TN-TM-001/002/003.
- Provider contract/configuration evidence for TN-TM-010/012.
- Capacity, edge, replica and cleanup evidence for TN-TM-018.
- Logging/retention canaries for TN-TM-020.
- Hosted supply-chain receipts for TN-TM-021.
- Restore exercise for TN-TM-024.
- Deployed compliance access test, super-user account review and bucket
  credential review for TN-TM-028/032.
- Log canary and audit-write failure exercise for the compliance flow for
  TN-TM-029/034.
- Provider retention evidence for the compliance embedding, rerank and generation
  routes for TN-TM-030.
- Capacity test and spend alert for TN-TM-033.

## Review triggers

Re-review before release when any of these changes:

- CDE/PAN policy, segmentation, hosting, domains, proxy, identity, roles or sessions;
- provider, model, routing, retention/ZDR, guardrail, embedding, reranking, parsing,
  scanner, email, log export, object storage or database;
- upload type/size, document lifecycle, classification, source approval, retrieval,
  citation/refusal, prompt or output handling;
- security DDL, audit schema, rate-limit scope/threshold, queue/concurrency behavior;
- who may read compliance documents (`COMPLIANCE_MIN_ROLE`), how they are stored,
  or the providers and gates of the compliance question flow;
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
