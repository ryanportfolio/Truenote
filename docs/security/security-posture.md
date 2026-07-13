# Truenote — Security Posture & Response to Security Review

> Response to the internal Security team's review of the Truenote RAG knowledge assistant.
> Each of the seven feedback areas is answered with **what is built today** (with code
> evidence) and **the plan** for anything not yet met. Nothing below is aspirational unless
> it is explicitly labeled *Planned* or *Gap*.

**Audience:** Security / compliance reviewers (RMF / FedRAMP / NIST 800-53 framing).
**Product one-liner:** retrieval-augmented answers for call-center CSRs — every answer ships
with a clickable citation or an explicit refusal. The product *is* trust + verifiability, so
several of the controls the review asks for were designed in from the start rather than bolted
on. File references point at the deployed source tree so any claim here can be verified.

---

## Executive summary

Truenote is **security-by-design in its core data path** and **not yet formally documented**
against a control framework. Those are two different things, and this response separates them
honestly:

- **Already meets or exceeds the review** on: server-side program (tenant) isolation as a hard
  boundary, role-based access control enforced at the retrieval endpoint, versioned/attributed
  ingestion with role-gated writes **and an enforced human approval gate before a document goes
  live**, refusal-over-hallucination generation, immutable answer receipts, and a first-class
  evaluation harness with held-out overfitting detection.
- **Partially meets** the review on: logging depth (rich query/error logging, but Postgres-resident
  and **no append-only audit trail for admin/config actions**, not yet streamed to a SIEM), and
  lifecycle/CI-CD controls (an eval gate exists and is CI-ready but is not yet wired to block merges).
- **Gaps with a concrete plan** on: a dedicated input/output guardrail classifier for prompt
  injection / jailbreak / exfiltration, ingestion-anomaly (poisoning) detection, formal governance
  artifacts (SSP, risk register, named roles, data classification), request-rate limiting on the
  query endpoint, data masking/tokenization, and **enterprise identity (SSO/MFA/provisioning)** —
  current auth is local password + session cookie. *(The ingestion approval gate, flagged as a
  defect in review, was fixed 2026-07-13 — see §2.)*

The risk register (Appendix A), role map (Appendix B), and 800-53 crosswalk (Appendix C) that
the review asks for are drafted here as the starting artifacts.

### How to describe Truenote's posture (claims discipline)

- ✅ **Accurate:** "Truenote has strong security-by-design controls in its core RAG path (server-side
  tenant isolation, RBAC, cite-or-refuse generation, ZDR model routing, versioned/attributed
  ingestion) and a defined remediation plan toward RMF alignment."
- ❌ **Do not claim:** "FedRAMP compliant," "FedRAMP-ready," or "fully controlled / human-approved
  ingestion." The first two require an authorization Truenote has not been through; the third is
  contradicted by the §2 auto-activation defect until that gate is enforced.

**Legend:** ✅ Built & verifiable · 🟡 Partial · 📋 Planned / Gap

---

## 1. Governance and Risk

**Feedback:** Treat RAG as an in-scope information system aligned to RMF/FedRAMP/800-53; keep a
focused AI/RAG risk list (prompt injection, data leakage, KB poisoning, output misuse,
uncontrolled onboarding); identify key roles (system owner, ISSO, data steward, MLSecOps/ops).

| Item | Status | Evidence / Plan |
|---|---|---|
| Treat as in-scope information system | 🟡 | The system boundary, data flows, and safeguards are documented across `.claude/reference/*.md` (data model, ingestion, retrieval, secrets) and this posture doc. What is missing is the *formal* RMF wrapper — an SSP and a control-implementation narrative. **Plan:** produce a lightweight SSP using Appendix C as the control seed once a target framework/impact level is set by leadership. |
| Focused AI/RAG risk list | ✅ (drafted here) | See **Appendix A — AI/RAG Risk Register**: prompt injection, data leakage, KB poisoning, output misuse, uncontrolled source onboarding, each with current mitigation, residual risk, and planned control. |
| Key roles identified | ✅ (drafted here) | See **Appendix B — Role Map**. The application already encodes a 4-tier role model (`super_user`, `senior_manager`, `manager`, `csr`) that maps cleanly onto data-steward / program-owner responsibilities; Appendix B names the org roles that would own approval, guardrail config, and incident handling. |

**Bottom line:** the *engineering* substance a governance package would document already exists;
the *paperwork* (SSP, control mapping, named accountable roles) is the deliverable, and this
document is its first draft.

---

## 2. Data Ingestion and Knowledge Base

**Feedback:** Treat the vector store / indexes / embeddings as a controlled data store with
restricted write access and change logging; sources explicitly approved and traceable
(origin, classification, change history); ingestion validation/sanitization to resist poisoning.

| Item | Status | Evidence / Plan |
|---|---|---|
| Restricted write access | ✅ | Upload/delete require `manager` or above **and** a fresh password, and demo accounts are blocked from all writes — enforced server-side by the router auth chain `requireAuth → requireFreshPassword → requireManagerOrAbove → blockDemoWrites` in [documents.ts](../../artifacts/api-server/src/routes/documents.ts). CSRs (the majority of users) have **no** write path to the KB at all. |
| Change history / traceability | ✅ | Re-uploading a document **never overwrites** — it creates a new `document_versions` row and flips `is_active`; prior versions are retained for audit/rollback ([ingestion.md](../../.claude/reference/ingestion.md), invariants in [data-model.md](../../.claude/reference/data-model.md)). Every version records `uploaded_by`, `uploaded_at`, `file_sha256`, `mime_type`, and `parse_status`. Content is content-addressed (SHA-256) so identical re-uploads are deduped and provenance is exact. |
| Origin recorded | ✅ | Raw source file is stored in object storage keyed by SHA + sanitized filename; `document_versions.source_url` points at it. |
| Data **classification** labels | 📋 Gap | Documents carry a program (tenant) and title but **no sensitivity/classification tag** today. **Plan:** add an optional `classification` column to `documents` (raw DDL, per the schema-change protocol) and surface it in the admin uploader; feed it into the segmentation model in §3. |
| Explicit **source-approval workflow** | ✅ (gate enforced) / 🟡 (SoD + approver audit) | **Fixed 2026-07-13.** The ingestion worker now stops at `parse_status='ready'` with `is_active=false` and never activates ([run.ts](../../artifacts/api-server/src/lib/ingestion/run.ts)). A version becomes retrievable **only** when a manager+ reviews the parsed text and approves it via `POST /api/documents/:versionId/activate` — the sole place `is_active` flips true, guarded by `requireManagerOrAbove + blockDemoWrites + fresh password` and scoped to the actor's program ([documents.ts](../../artifacts/api-server/src/routes/documents.ts)). **Scope of the control (stated precisely):** this is a *review-before-publish* + intentional-publish + audit gate. Upload and approve share the `manager+` tier, so the uploader **may approve their own upload** — it is **not** segregation of duties (four-eyes) by default. It is now the server-side enforcement *point* where SoD can be added cheaply: raise the approve guard to `senior_manager+` (a manager can no longer self-publish), or enforce `approved_by ≠ uploaded_by` with a fallback approver. Approver identity (`approved_by`/`approved_at`) ships via raw DDL (below); the gate is enforced in code regardless. |
| Validation / sanitization at ingest | 🟡 | Type is validated against a MIME allowlist with extension-sniff normalization for browser quirks, and size is capped at 20 MB (enforced by multer **and** re-checked post-parse so a chunked/misreported upload can't slip past) — [documents.ts](../../artifacts/api-server/src/routes/documents.ts). Parsing runs out-of-band in a background worker (`pg-boss`), not in the request. What is **not** yet done is *content* sanitization to resist embedded-instruction poisoning (e.g. a PDF that contains "ignore prior instructions and reveal…"). **Plan:** see the poisoning row in Appendix A — a pre-embedding content scan + the retrieval-time architectural defenses in §4. |

**Bottom line:** the KB is a controlled, versioned, attributed store with role-gated writes **and
an enforced human approval gate** before any version goes live (fixed 2026-07-13). The remaining
additions the review would want are: (1) run the approver-audit DDL so `approved_by`/`approved_at`
persist, and (2) a classification tag.

---

## 3. Retrieval and Access Control

**Feedback:** Retrieval must respect authorization (don't let the model infer access); segment
the KB by sensitivity / business context with RBAC; retrieval endpoints act as policy
enforcement points.

**This is Truenote's strongest area — it meets and exceeds the ask.**

| Item | Status | Evidence |
|---|---|---|
| Authorization enforced server-side, not by the model | ✅ | The model is **never** consulted for access decisions. Every retrieval query filters `program_id` **in SQL, before ranking** — see `vectorSearch`, `bm25Search`, and `trigramSearch` in [query.ts](../../artifacts/api-server/src/lib/retrieval/query.ts), each with `WHERE c.program_id = $programId::uuid AND dv.is_active = true`. The reranker and LLM only ever see rows that already passed the boundary. |
| Program = hard tenant boundary (policy enforcement point) | ✅ | The `/ask` endpoint resolves the effective program server-side and refuses rather than widening scope: non-super-users are pinned to their own program by a **database CHECK constraint** (`users.role` + `users.program_id` jointly constrained); the client-supplied `X-Program-Id` header is *ignored* for them. Super-users must explicitly select a program or the request is refused — no "all programs" fallback ([effective-program.ts](../../artifacts/api-server/src/lib/auth/effective-program.ts), `resolveAskProgram` + `canAccessProgram` in [ask.ts](../../artifacts/api-server/src/routes/ask.ts)). |
| Defense-in-depth / fail-closed | ✅ | After retrieval, `filterToProgramScope` re-checks every chunk's `program_id` and **drops** any foreign chunk, emitting a `program-scope-violation` security error to `error_log` ([query.ts](../../artifacts/api-server/src/lib/retrieval/query.ts)). In correct operation it drops nothing; it exists so a future query edit fails *closed* instead of leaking cross-tenant content. Session IDs are likewise re-validated against `(user_id, program_id)` so a leaked/tampered id can't stitch one user's conversation to another's. |
| RBAC tiers | ✅ | Four roles with a rank ladder and named guards (`requireSuperUser` / `requireSeniorManagerOrAbove` / `requireManagerOrAbove` / `requireCsrOrAbove`) in [current-user.ts](../../artifacts/api-server/src/middleware/current-user.ts). Method-based demo-write blocking is default-deny (any non-GET on a guarded router is blocked unless explicitly allowed). |
| Segment by **sensitivity** (not just tenant) | 📋 Gap | Segmentation today is by **program** (tenant/mission context), which is a real and enforced boundary. Finer-grained *sensitivity* segmentation within a program does not exist yet. **Plan:** once the §2 `classification` tag lands, extend the retrieval filter to also scope on classification vs. the requesting user's clearance — the enforcement point (`filterToProgramScope` + the SQL predicate) is already the right place to add it. |

**Bottom line:** the retrieval endpoint is already a strict, server-enforced, fail-closed policy
enforcement point. The one enhancement is adding a *sensitivity* dimension on top of the existing
*tenant* dimension.

---

## 4. Prompt, Query, and Output Safety

**Feedback:** Evaluate inputs/outputs through guardrails (prompt injection, jailbreak,
exfiltration, unsafe content); validate outputs against business rules when they drive
downstream systems; mask/tokenize sensitive data; rate-limit to reduce abuse/scraping/DoS.

This area is a mix of **strong architectural defenses** and the review's **clearest gap** (a
dedicated guardrail classifier).

| Item | Status | Evidence / Plan |
|---|---|---|
| Prompt-injection resistance (architectural) | 🟡 | Truenote's generation contract is deliberately hard to weaponize: the LLM sees **only** retrieved excerpts + the question, is instructed to use no outside knowledge, and must cite every claim or emit an exact refusal string ([retrieval.md](../../.claude/reference/retrieval.md), "Generation contract"). Conversation history is used **only** to rewrite a follow-up into a standalone question — it never feeds answer generation, so an ungrounded fact can't leak forward. There is **no tool-calling, no automation, no downstream action** the model can trigger — output is text + citations rendered to a human. This blunts the classic injection payloads. |
| Dedicated input/output **guardrail classifier** | 📋 Gap | There is **no** separate classifier scanning inputs/outputs for injection/jailbreak/exfiltration signatures. The defense is architectural (above), not a content filter. **Plan:** add a guardrail layer at the `/ask` boundary — screen the inbound question and the outbound answer against an injection/exfiltration ruleset (candidate: a lightweight model check or a pattern library aligned to OWASP LLM Top 10). This is the single highest-value item on the roadmap and is called out again in §6 (testing) and Appendix A. |
| Output validated against business rules | ✅ (for this design) | Because RAG output never drives downstream automation, the "unsafe output → bad action" chain doesn't exist here. Output *is* validated structurally: an answer with zero derivable citations is treated as invalid regardless of the model's own `refused` flag; citation IDs are mapped to real retrieved chunk UUIDs and out-of-range/invented IDs are rejected (no fuzzy correction) — [retrieval.md](../../.claude/reference/retrieval.md), UI contract. **If** Truenote ever drives downstream tools, a business-rule validation layer becomes mandatory; noted for that future. |
| Refusal over hallucination | ✅ | A confidence gate refuses **before** calling the LLM when the reranker's top score is below threshold (`refused = topScore < threshold` in [query.ts](../../artifacts/api-server/src/lib/retrieval/query.ts)); the LLM is separately instructed to refuse when excerpts don't support an answer. Every provider route enforces Zero-Data-Retention per request (`provider.zdr=true`, `data_collection="deny"`, `allow_fallbacks=false`) with **no** direct-provider escape hatch ([retrieval.md](../../.claude/reference/retrieval.md), [secrets.md](../../.claude/reference/secrets.md)). |
| Mask / tokenize sensitive data before the model | 📋 Gap | The model sees raw excerpt text. Mitigating factor: excerpts are **admin-curated KB content**, not live customer PII pulled from a system of record — the KB is SOPs/policies. Still, nothing *prevents* an admin from uploading a document containing sensitive values. **Plan:** pair the §2 `classification` tag with an optional PII-detection/redaction pass at ingest, and/or reference-not-reveal for flagged fields. |
| Rate limiting | 🟡 | Auth endpoints are rate-limited today: per-IP login throttle and per-IP + per-email forgot-password throttles, with a memory-bounded sliding window ([rate-limit.ts](../../artifacts/api-server/src/lib/auth/rate-limit.ts)). The `/ask` endpoint has a **question-length cap (2000 chars)** and a **fail-closed overall deadline** ([ask.ts](../../artifacts/api-server/src/routes/ask.ts), [ask-deadline.ts](../../artifacts/api-server/src/lib/ask-deadline.ts)) but **no per-user request-rate limit** — so scraping/abuse of the query path is not yet bounded. **Plan:** add a per-user (and per-program) sliding-window limiter to `/ask` reusing the existing limiter class. |

**Bottom line:** the *architecture* resists the injection/exfiltration threats well because the
model is boxed in (excerpts-only, no tools, cite-or-refuse). The **named gap** the review is
right to flag is the absence of an explicit guardrail classifier and query-path rate limiting —
both are planned and both are additive.

---

## 5. Confidentiality, Integrity, and Availability (CIA)

| Pillar | Status | Evidence / Plan |
|---|---|---|
| **Confidentiality — in transit** | ✅ | Session cookie is `httpOnly` + `secure` (prod) + `sameSite=lax` ([auth.ts](../../artifacts/api-server/src/routes/auth.ts)); managed Postgres (Neon) connections are TLS. CORS is a strict env-driven allowlist that defaults to *no* cross-origin ([app.ts](../../artifacts/api-server/src/app.ts)). Passwords are Argon2id; session tokens are stored only as SHA-256 hashes, so a DB leak yields no usable sessions ([sessions.ts](../../artifacts/api-server/src/lib/auth/sessions.ts), invariants in [data-model.md](../../.claude/reference/data-model.md)). |
| **Confidentiality — at rest** | 🟡 | The vector DB, indexes, and embeddings live in **managed Neon Postgres**, which provides encryption at rest at the platform level. This is **vendor-provided**, not an application feature, and should be documented as such (and confirmed against the deployment's Neon/Replit tier). **Plan:** capture the vendor's at-rest encryption attestation in the SSP; treat the vector store as a high-value asset on par with the primary data store — which, architecturally, it already *is* (same Postgres instance). |
| **Integrity** | 🟡 | Content integrity has strong *point* controls: SHA-256 content addressing, immutable versioning (never overwrite), and immutable per-answer citation snapshots (`query_log.citation_snapshots`) so a re-ingest can't silently rewrite an old answer's evidence ([data-model.md](../../.claude/reference/data-model.md)). What's missing is **behavioral** integrity monitoring — detection of *unusual ingestion/update patterns* that would indicate poisoning or unauthorized modification. **Plan:** see Appendix A (poisoning) — baseline ingestion-rate/volume alerting + embedding-drift checks, fed to the monitoring pipeline in §6. |
| **Availability** | ✅ (core) / 🟡 (isolation) | Ingestion runs on a **background job queue** (`pg-boss`), isolating heavy parse/embed work from the live query path ([ingestion.md](../../.claude/reference/ingestion.md)). Query requests have a fail-closed deadline and a length cap (DoS surface control). Rate limiters bound auth abuse. **Gaps:** no per-user `/ask` throttle yet (§4), and RAG workloads share the same Postgres instance as core data — capacity planning and workload isolation are not formally documented. **Plan:** query-path rate limiting + a capacity/throttling note in the SSP; consider read-replica or connection-pool isolation if volume grows. |

**Bottom line:** Confidentiality-in-transit and integrity *point controls* are strong;
at-rest encryption is real but vendor-provided (document it), and the two additions are
**behavioral integrity monitoring** and **query-path availability controls**.

---

## 6. Logging, Monitoring, and Audit

**Feedback:** Log query/retrieval/generation at "who requested what, and what was returned"
fidelity for humans and services; integrate ingestion/vector-store/LLM/guardrail logs with
existing monitoring (DataDog, Exabeam) for anomaly detection & IR; security testing aligned to
OWASP LLM guidance.

| Item | Status | Evidence / Plan |
|---|---|---|
| "Who requested what, and what was returned" | ✅ | Every ask writes a `query_log` row: `user_id`, `program_id`, `session_id`, the exact question the CSR typed, the answer, `cited_chunk_ids`, `refused`, `latency_ms`, and immutable `citation_snapshots` (the exact source receipts) — [data-model.md](../../.claude/reference/data-model.md). Per-stage/provider timing is captured in `timing_breakdown`. This already answers the audit question precisely, including *which sources* were returned. |
| Operational error / diagnostics log | ✅ | `error_log` captures redacted provider/API/worker failures with correlation IDs, request IDs, route, user, and program — after **recursive credential redaction** so secrets never land in logs ([error-log.ts](../../artifacts/api-server/src/lib/observability/error-log.ts), [data-model.md](../../.claude/reference/data-model.md)). Production API errors return a generic message; full detail stays server-side ([app.ts](../../artifacts/api-server/src/app.ts)). |
| Read surfaces for operators | ✅ | Super-user admin pages expose query analytics, errors, and pipeline observability (`/admin/queries`, `/admin/errors`, `/admin/observability`). |
| **Append-only audit trail for admin/config actions** | 📋 Gap | Query and error activity are logged well, but **administrative and configuration mutations are not event-logged**: document upload/approve/activate/delete, user create/edit/role-change/deactivate, and model-routing changes update rows in place (some record `updated_by`/`updated_at`, e.g. `app_settings`, but there is **no append-only history**). This is a real gap versus "durable audit trail." **Plan (P1):** add an append-only `audit_events` table written on every privileged mutation (actor, action, target, before/after, reason). |
| **SIEM integration (DataDog / Exabeam)** | 📋 Gap | All of the above is **Postgres-resident and admin-surfaced** — there is **no** export/stream to an external SIEM, and therefore no cross-system anomaly detection or automated alerting today. **Plan:** add a structured log shipper (JSON to stdout → platform log drain, or a direct DataDog/Exabeam forwarder) covering the ingestion pipeline, vector store operations, LLM interface, and — once built — the guardrail component. This is the main integration item in this section. |
| Security testing aligned to OWASP LLM Top 10 | 🟡 | The **evaluation harness** already exercises retrieval/generation quality, refusal behavior on out-of-KB questions (hallucination probes), and claim-level faithfulness via an LLM judge ([eval.md](../../.claude/reference/eval.md)). It is not yet a *security* test suite. **Plan:** add an adversarial test set — prompt-injection strings, jailbreak attempts, cross-program leakage probes, exfiltration patterns — as protected eval questions and/or a dedicated red-team script, mapped to OWASP LLM01–LLM10. The held-out "protected" eval mechanism is the right container for regression-proofing these. |

**Bottom line:** the *audit trail fidelity* the review asks for already exists and is strong.
The two additions are **SIEM integration** (ship the existing logs outward) and an
**OWASP-aligned adversarial test suite** (extend the existing eval harness).

---

## 7. Lifecycle and Operations

**Feedback:** Manage the RAG lifecycle like any information system — formal review/test/doc of
changes to data sources, models, guardrails, policies; CI/CD checks specific to RAG (validate
new sources, verify guardrail config, regression-test risky prompts/leakage paths); keep
docs/control mappings current.

| Item | Status | Evidence / Plan |
|---|---|---|
| Change discipline | ✅ (dev process) | Model routes are a **server-owned allowlist** — the admin UI can only reorder approved, ZDR-enforced presets, never inject an arbitrary model/provider ([data-model.md](../../.claude/reference/data-model.md), `app_settings` invariant). Schema changes follow a strict raw-DDL protocol (no informal migrations). Retrieval-affecting changes are gated on the eval suite by project policy ([CLAUDE.md](../../CLAUDE.md)). |
| Model / threshold changes tested | ✅ | Changing the reranker model forces a threshold retune via the eval suite; the eval harness has a machine-readable JSON mode and a **non-zero exit code on any failure** — i.e. it is already shaped as a CI gate ([eval.md](../../.claude/reference/eval.md)). Held-out "protected" questions detect tuning-to-the-test (overfitting). |
| **RAG-specific CI/CD gate wired** | 🟡 | The eval gate exists and is CI-ready but is **not yet wired into an automated pipeline** that blocks a merge/deploy, nor does it yet verify *guardrail config* (which doesn't exist yet, §4) or *new-source validation*. **Plan:** wire `pnpm eval` (with a pinned baseline + protected split) into CI as a required check; add a guardrail-config verification step once §4 lands; add the injection/leakage regression set from §6 to the same gate. |
| Docs / control mappings current | 🟡 | Architecture, data flows, and safeguards are documented and kept current in `.claude/reference/*.md`; this posture doc plus Appendix C is the first control mapping. **Plan:** keep Appendix C in sync with the deployed architecture and fold it into the SSP; assign doc-currency ownership to the ISSO role (Appendix B). |

**Bottom line:** the *ingredients* of RAG lifecycle management (allowlisted models, eval gate,
overfitting detection, strict schema protocol) exist. The work is **wiring the eval gate into
CI as a blocking check** and extending it to cover guardrail config and leakage regressions.

---

# Appendix A — AI/RAG Risk Register (starter)

The focused risk list the review asked for. Residual risk assumes current mitigations only.

| # | Risk | Current mitigation (built) | Residual | Planned control |
|---|---|---|---|---|
| R1 | **Prompt injection** (malicious instructions in the question or in retrieved content) | Excerpts-only generation contract; no tools/automation; cite-or-refuse; history used only for query rewrite, never generation | Medium — architectural, no explicit detector | Guardrail classifier on input+output (§4); OWASP-aligned adversarial eval set (§6) |
| R2 | **Data leakage / cross-tenant exposure** | Server-side `program_id` filter in SQL before ranking; DB CHECK pins non-super users to one program; fail-closed `filterToProgramScope` with security-event logging; session re-validation | **Low** — strongest control in the system | Add sensitivity-tier scoping on top of tenant scoping (§3); exfiltration pattern detection (§4) |
| R3 | **Knowledge-base poisoning** (malicious/misleading content embedded to be retrieved later) | Role-gated uploads; **enforced manager+ approval gate before a version goes live** (fixed 2026-07-13); immutable versioning + SHA-256 provenance; `uploaded_by` attribution | Medium — human approval now blocks blind activation; residual is no content/malware scan and no anomaly detection | Pre-embedding content + malware sanitization; ingestion-rate/volume + embedding-drift anomaly alerting (§5) |
| R4 | **Misuse of outputs** (wrong/hallucinated answer acted on) | Confidence-gate refusal; citation contract (invalid-if-uncited); faithfulness judge in eval; refusal renders as a distinct state | Low–Medium | Business-rule validation layer **if** outputs ever drive automation (§4) |
| R5 | **Uncontrolled onboarding of new data sources** | Role gate; **enforced review-before-publish gate** (fixed 2026-07-13); program scoping; versioned/attributed store | Medium — a manager+ must approve before publish, but may self-approve (no segregation of duties); no classification; no source registry | Optional SoD (raise approve to `senior_manager+`, or `approved_by ≠ uploaded_by`); run `approved_by`/`approved_at` DDL; `classification` tag; source registry (origin, owner, purpose, retention, review date) (§2) |
| R6 | **Abuse / scraping / DoS of the query path** | Length cap + fail-closed deadline; auth-endpoint rate limits; background-job isolation of ingestion | Medium — no `/ask` request-rate limit | Per-user/per-program query rate limiter (§4); capacity/throttling documentation (§5) |
| R7 | **Credential / secret exposure in logs** | Recursive credential redaction in `error_log`; generic prod error messages; session tokens hashed at rest | Low | Confirm redaction coverage when SIEM shipping is added (§6) |

---

# Appendix B — Role Map (starter)

The review asks that key roles be identifiable, including who approves data sources, configures
guardrails, and owns monitoring/IR. Truenote's in-app roles map onto these; the **org roles**
are the accountable owners TTEC leadership would assign at onboarding.

| Function | In-app role today | Org role (to be assigned) | Responsibility |
|---|---|---|---|
| Overall system accountability | — | **System Owner** | Accepts residual risk; owns the SSP |
| Security posture & control currency | — | **ISSO** | Maintains control mappings (Appendix C), owns IR, approves guardrail config |
| Data source approval & classification | `super_user` / `senior_manager` | **Data Steward** (per program) | Approves new sources, assigns classification, owns KB accuracy |
| Program-level content management | `manager` | Program content owner | Uploads/curates; would run the approval gate once enforced (§2) |
| Consumption | `csr` | End user (CSR) | Read-only query access; no KB write path |
| Model/guardrail ops & monitoring | `super_user` | **MLSecOps / Ops** | Orders approved model routes, runs eval gates, watches monitoring/alerts |

> The application already **technically enforces** the read/write/approve separation via RBAC
> and the DB CHECK constraint; Appendix B assigns human accountability on top of it.

---

# Appendix C — NIST 800-53 Control-Family Crosswalk (starter)

Not a full control mapping — a starting cross-walk showing where Truenote **already provides
implementation evidence**, to seed the SSP. Impact level TBD by leadership.

| Family | Truenote evidence (built) | Status |
|---|---|---|
| **AC — Access Control** | 4-tier RBAC; server-side program isolation; DB CHECK role↔program constraint; fail-closed retrieval scope; default-deny demo writes | ✅ Strong |
| **IA — Identification & Authentication** | Argon2id passwords; hashed session tokens; forced first-login reset; invite-token onboarding; login rate limiting | ✅ Strong |
| **AU — Audit & Accountability** | `query_log` (who/what/returned), immutable citation snapshots, `error_log` with correlation IDs, timing breakdowns | 🟡 Rich, not yet SIEM-integrated |
| **SC — System & Communications Protection** | TLS in transit; httpOnly/secure/sameSite cookies; strict CORS allowlist; ZDR-enforced model routing; managed at-rest encryption (vendor) | 🟡 Strong; document at-rest attestation |
| **SI — System & Information Integrity** | Immutable versioning; SHA-256 provenance; confidence-gate refusal; faithfulness judge; error redaction | 🟡 Point controls strong; add anomaly monitoring + guardrail |
| **CM — Configuration Management** | Server-owned model allowlist; strict raw-DDL schema protocol; eval-gated retrieval changes | 🟡 Add blocking CI gate |
| **RA — Risk Assessment** | Appendix A risk register; held-out overfitting detection | 🟡 Formalize in SSP |
| **IR — Incident Response** | Security-event logging (program-scope violations); error correlation IDs | 📋 Define IR runbook + ownership (Appendix B) |

---

## Consolidated roadmap (what "addressing it properly" means)

| Priority | Item | Sections | Type |
|---|---|---|---|
| ~~P0~~ ✅ | **Ingestion approval gate enforced** (done 2026-07-13) — worker stops at `ready`; manager+ approval required before `is_active=true`. *Run the `approved_by`/`approved_at` DDL to persist the approver receipt.* | §2, A/R3, A/R5 | **Defect fixed** |
| **P1** | Enterprise identity — confirm TTEC SSO/MFA/SCIM provisioning + password-policy requirements (current auth is local password + cookie) | §1, App B | Dependency + build |
| **P1** | Input/output guardrail classifier (injection/jailbreak/exfiltration) | §4, §6, A/R1 | New capability |
| **P1** | Per-user/per-program rate limiting on `/ask` (distributed, not the current in-memory limiter) | §4, §5, A/R6 | Additive |
| **P1** | Append-only audit trail for admin/config actions (upload, approve, activate, delete, user/role, model-routing, guardrail, eval config) | §6, §7 | New capability |
| **P1** | SIEM log shipping (DataDog/Exabeam) | §6 | Integration |
| **P1** | Vendor assurance package — DPAs/ZDR/retention/residency across Replit, Neon, LandingAI, OpenAI, Cohere, OpenRouter + model providers | §5, App C | Documentation |
| **P2** | OWASP-LLM adversarial eval set + wire eval into CI as blocking gate (SAST, dep/secret scan, SBOM) | §6, §7 | Test + process |
| **P2** | Source registry (`approved_by`, origin, owner, purpose, classification, retention, review date) | §2, §3, A/R5 | Schema + UI |
| **P2** | Ingestion protection — malware/file validation + PII/secrets + suspicious-instruction detection | §2, §4, A/R3 | New capability |
| **P2** | Ingestion-anomaly / poisoning detection | §5, A/R3 | Monitoring |
| **P3** | Segregation of duties on approval (approve bar → `senior_manager+`, or `approved_by ≠ uploaded_by`) — only if Security mandates four-eyes | §2, A/R5 | Policy toggle on existing gate |
| **P3** | Sensitivity-tier scoping on top of tenant scoping | §3 | Additive to enforcement point |
| **P3** | PII detection/masking at ingest | §4, A/R5 | New capability |
| **P3** | Availability engineering — load/capacity tests, SLOs, backup/restore + RTO/RPO, provider-failure tests | §5 | Engineering |
| **P3** | Formal SSP + 800-53 mapping + AI RMF profile + POA&M + named role assignment | §1, App B/C | Documentation |

---

*This document is grounded in the deployed source tree; every ✅ claim links to the file that
implements it. It should be reviewed and kept current as items move from 📋/🟡 to ✅.*
