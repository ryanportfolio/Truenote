# Truenote secure-development training curriculum

**Curriculum ID:** `TN-SDLC-CURRICULUM-001`  
**Version:** 1.0 draft  
**Status:** Approval-ready content; not yet approved or delivered  
**Supports:** PCI DSS Requirement 6.2.2 and the Truenote secure development lifecycle  
**Curriculum owner:** Product Security - unassigned  
**Approval authority:** PCI scope owner and Engineering owner - unassigned  
**Review cadence:** At least annually and after a material language, framework,
architecture, provider, CDE-scope, or PCI DSS change

The current PCI DSS version is published through the
[PCI SSC document library](https://www.pcisecuritystandards.org/document_library/?class=pcidss&doc=pci_dss).
The curriculum is designed around the Requirement 6.2.2 expectation that people
working on bespoke/custom software receive training at least once every 12 months
on job- and language-relevant software security, secure design/coding, and use of
the vulnerability-detection tools they operate. The compliance-accepting entity
must approve this mapping before it is used as assessment evidence.

## Audience and completion standard

Required audience:

- developers who change Truenote application, API, database, CI, or security code;
- reviewers who approve those changes;
- platform/database engineers who change security-relevant runtime definitions;
- Product Security personnel who triage Truenote findings or approve treatments;
- temporary contributors before they receive approval authority.

Completion requires all of the following:

1. attendance or learning-platform completion for the core modules;
2. completion of the modules assigned to the participant's current role;
3. at least 80% on the knowledge check;
4. a passing practical exercise with no critical safety violation;
5. remediation and reassessment after a failed attempt; and
6. a restricted completion/certificate reference recorded in the annual
   [`secure-development training record`](./secure-development-training-record-template.md).

The normal delivery target is 120 minutes of core instruction, 30 minutes of
role-specific material, and a 30-60 minute practical assessment. Product Security
may accept equivalent external training only after documenting the exact coverage
mapping and assigning any missing Truenote-specific modules.

## Learning objectives

After completion, a participant must be able to:

1. explain Truenote's trust boundaries, sensitive data paths, and possible CDE
   relationship without placing restricted details in repository evidence;
2. design authorization, program, classification, and retrieval checks that fail
   closed on the server;
3. handle browser, API, uploaded-document, retrieved, provider-input, and
   provider-output data as untrusted;
4. prevent or test the attack classes relevant to TypeScript, React, Express,
   PostgreSQL, file ingestion, retrieval-augmented generation, and external AI
   providers;
5. use the repository's tests, CodeQL intake, dependency/secret checks, and
   evidence gates without weakening or misrepresenting results;
6. keep PAN, customer data, credentials, raw findings, and restricted environment
   details out of source, fixtures, pull requests, logs, and public reports;
7. complete a change record with requirements, threats, independent review,
   testing, approval, rollback, and deployed verification; and
8. distinguish repository implementation, configuration screenshots, deployed
   receipts, provider attestations, and independent reports.

## Core modules

| Module | Minimum content | Participant demonstration | Primary evidence |
|---|---|---|---|
| 1. Scope, PAN prohibition, and evidence boundaries | Possible CDE relationships; prohibited synthetic-test data; accountable scope decisions; safe versus restricted evidence; provider/data-flow inventory | Classify five sample artifacts as repository-safe, restricted, or prohibited | Knowledge check and practical worksheet |
| 2. Secure design and threat modeling | Assets, actors, trust boundaries, abuse cases, least privilege, fail-closed behavior, bounded calls, secure defaults; STRIDE plus prompt injection, data poisoning, cross-program leakage, and sensitive output | Add or update one stable threat with owner, treatment, test, and evidence boundary | Threat-model exercise |
| 3. Authentication, authorization, and isolation | Server-side identity; program and classification scope; object-level authorization; fresh-password and role gates; no client-trusted security decision | Identify and correct an intentionally client-trusted access check | Code-review exercise |
| 4. Input, query, file, and provider safety | Schema/length validation; injection; SSRF/provider abuse; upload validation, malware and decompression limits; local sensitive-input blocking/redaction; prompt injection; retrieved-content distrust; output refusal | Trace a synthetic request through local and provider boundaries and name every enforcement point | Data-flow exercise |
| 5. Language and framework attacks | TypeScript type/runtime boundary; React XSS and unsafe rendering; Express parsing, routing, error/log handling, rate limits and proxy assumptions; PostgreSQL parameterization, RLS/privilege/search-path/function safety; concurrency and business logic | Review a mixed frontend/API/SQL change and record concrete findings | Practical review record |
| 6. Secrets, cryptography, logging, and privacy | Secret lifecycle; approved cryptography; token/cookie handling; sensitive error and audit design; raw-match prohibition; safe identifiers and correlation; output/content retention | Redact an unsafe diagnostic while retaining actionable metadata | Practical exercise |
| 7. Vulnerability tools and treatment | CodeQL, dependency audit/Dependabot, Gitleaks, SBOM, unit/negative tests, DAST or web protection when applicable; source receipts; false-positive handling; owner/date/disposition/retest; no closure from disappearance alone | Triage a synthetic finding and produce a complete safe management entry | Assessment and source-receipt exercise |
| 8. Secure change and production proof | Security requirements; non-author review; CDE/significant-change decision; hosted checks; approval; rollback to secure state; deployed verification; incident/reporting triggers | Complete a sample released-change record and identify evidence that cannot be proven locally | Change-record exercise |

## Role-specific assignments

| Role | Required emphasis beyond the core |
|---|---|
| React/frontend developer or reviewer | DOM/XSS, URL handling, browser storage, CSP, CSRF/origin assumptions, accessibility-safe error states, and no client-enforced authorization |
| API/TypeScript developer or reviewer | Runtime schema validation, object authorization, error/log redaction, rate limits, external-call deadlines, provider request/response boundaries, and concurrency |
| Database/platform engineer | Least privilege, RLS/role context, `SECURITY DEFINER`, fixed `search_path`, forward-only changes, catalog verification, backup/restore, segmentation, SIEM, and safe evidence capture |
| AI/retrieval engineer | Prompt injection, untrusted retrieved text, provider routing/ZDR, deterministic redaction, contextual PII limits, citation/refusal, canaries, data poisoning, and output handling |
| Product Security/reviewer | Threat disposition, CodeQL/source reconciliation, independent review, exception expiry, evidence grades, red-team scope, production acceptance, and retest |
| Change authority or PCI scope owner | Scope/applicability decisions, separation, PAN policy, release blockers, emergency changes, evidence authenticity, and assessor/QSA escalation |

## Required tool demonstrations

Training delivery must show the current approved invocation or hosted equivalent
for each applicable tool. Screenshots alone are insufficient; participants must
interpret results and explain the evidence boundary.

| Tool/control | Required skill |
|---|---|
| TypeScript, unit, negative, and production-build checks | Select the relevant workspace; distinguish a runner/environment failure from a product failure; never relabel an unexecuted check as passed |
| CodeQL/SARIF intake | Verify provenance and artifact identity; preserve stable finding history; assign owner/date/disposition; reconcile removed/reappeared results; retain retest evidence |
| Dependency audit and Dependabot | Determine direct/transitive impact, use supported overrides narrowly, document exceptions, and verify the released dependency graph |
| Gitleaks/secret response | Stop publication, rotate exposed material through the approved process, avoid repeating the secret in tickets/logs, and retain sanitized response evidence |
| Provider and AI security tests | Use synthetic values; validate local firewall and OpenRouter guardrail separately; check provider payload, persistence, response, logs, telemetry, and failure mode |
| PCI evidence and change-record gates | Understand structural versus operational proof; preserve exact source/artifact hashes; resolve failures without weakening the invariant |

## Knowledge check

Product Security may randomize wording, but the assessment must retain equivalent
coverage. Passing score is 80%; questions 2, 5, 8, and 11 are critical and must
all be correct.

1. Which Truenote evidence can safely live in the repository, and which must use
   a controlled reference to restricted storage?
2. Why must PAN, real SSNs, credentials, and customer prompts never be used in a
   test fixture or synthetic production canary?
3. Name the server-side checks required before a user can retrieve or act on a
   program's content.
4. What is the difference between blocking the raw ask request and redacting a
   later provider-bound payload?
5. Does an OpenRouter configuration screenshot prove every production request
   used the guardrail and was redacted? State the additional evidence required.
6. Why is retrieved document text considered untrusted even when the document was
   previously approved?
7. What evidence is required before a vulnerability finding can be closed?
8. A scanner no longer reports a finding. May the register automatically mark it
   closed? Explain.
9. Give one TypeScript/Express, one React, and one PostgreSQL attack or misuse case
   relevant to Truenote and one appropriate control for each.
10. When does a security-relevant change require an updated threat review?
11. What must happen when a required production, security, or evidence check did
    not execute because of an environment/tooling failure?
12. Distinguish these claims: repository-tested, configured, deployed and
    observed, provider-attested, and independently tested.

## Practical assessment

Use synthetic data and a non-production or explicitly authorized target. Provide
the participant with a small change scenario involving one authorization/data
boundary, one provider interaction, one vulnerability-tool result, and one
deployment decision.

The participant must:

1. identify affected components, data, trust boundaries, and possible CDE impact;
2. add security requirements and negative acceptance tests;
3. identify at least four relevant threats, including one AI/provider threat;
4. review the proposed code/configuration and record concrete findings;
5. run or interpret the applicable checks and retain safe references;
6. triage the synthetic finding with owner, due date, disposition, treatment, and
   retest requirement;
7. complete the relevant sections of the secure-development review/change record;
8. define rollback to a secure state and deployed verification; and
9. state which conclusions remain unverified without external evidence.

Automatic failure conditions:

- use or disclosure of real PAN, customer data, credentials, raw findings, or
  restricted topology;
- accepting a client-side authorization decision as authoritative;
- labeling an unexecuted or failed check as passed;
- claiming configuration or repository tests prove deployed effectiveness;
- author self-approval where independent review is required; or
- closing a finding without treatment and retest evidence.

## Facilitator scoring record

Keep participant identity and detailed assessment output in the restricted
evidence system. The repository-safe annual record may retain only controlled
principal and evidence references.

| Area | Weight | Pass condition |
|---|---:|---|
| Knowledge check | 30% | At least 80% and every critical question correct |
| Threat/data-flow analysis | 20% | All material boundaries and CDE uncertainty identified |
| Secure review and tests | 25% | No critical miss; findings and negative tests are specific |
| Vulnerability treatment | 10% | Complete accountability, treatment, evidence, and retest |
| Change/release evidence | 15% | Independent review, rollback, approval, and production-proof boundary are correct |

## Operating evidence and acceptance

Before describing the curriculum as approved or the control as operating, retain:

- exact approved curriculum bytes or SHA-256 and approval date;
- approved role-to-module mapping and participant roster;
- delivery/session or learning-platform record;
- assessment version, result, remediation, and reassessment reference;
- completion/certificate reference and next due date for every participant;
- manager/training-owner reconciliation to the current in-scope roster; and
- distinct Product Security acceptance.

The blank training record remains intentionally incomplete. This curriculum proves
that role- and technology-specific content is prepared; it does not prove approval,
delivery, participant competence, annual currency, or PCI compliance.
