# Independent security testing plan

**Status:** Scope draft; engagement not commissioned  
**Owner:** Unassigned Security/PCI lead  
**Independence requirement:** Testers must be organizationally independent of
the people who designed and implemented the tested controls

This plan turns the audit's broad request for red-team and independent testing
into evidence that can support the existing CDE assessment. The PCI owner and QSA
must approve final applicability, scope, timing, and tester qualifications.

## Preconditions

Do not begin the final assurance engagement until:

- the CDE boundary, PAN policy, connected systems, and intended segmentation are
  documented and approved;
- the tested build is traceable to a commit and deployed configuration;
- provider paths and guardrail assignments are inventoried;
- test tenants, roles, synthetic data, stop conditions, and incident contacts are
  ready; and
- known critical/high internal findings are either remediated or disclosed to the
  tester so the engagement is not wasted rediscovering them.

An earlier discovery exercise may run before these gates, but it must not be
presented as the final independent validation.

## Workstream A — Application and API penetration test

At minimum, test:

- authentication, session management, OIDC/MFA integration, recovery, and rate
  limits;
- authorization across roles, programs, classifications, document versions,
  evaluation data, and administrative routes;
- injection, request forgery, server-side request forgery, file upload/parsing,
  path/object access, mass assignment, and business-logic abuse;
- browser controls, cross-origin behavior, cookies, framing, caching, and security
  headers;
- sensitive-data exposure through APIs, errors, logs, exports, citations, query
  history, temporary storage, and retained artifacts; and
- provider outages, timeouts, retries, concurrency, queue pressure, and unsafe
  fallback behavior.

## Workstream B — AI adversarial test

Use direct and indirect prompt injection across first-turn questions, conversation
history, retrieved excerpts, uploaded documents, image/PDF parser output, and any
administrative rewrite or evaluation path. Include:

- instruction hierarchy attacks, delimiter/format tricks, encoded and fragmented
  payloads, Unicode/confusable text, multilingual attacks, and long-context
  placement;
- attempts to reveal prompts, hidden instructions, retrieved text, provider
  details, secrets, PII/PAN, other programs' data, and higher-classification data;
- citation fabrication, citation swapping, low-confidence answer coercion, refusal
  bypass, retrieval poisoning, and malicious document content;
- provider/fallback manipulation, guardrail evasion, output-DLP evasion, and
  false-positive denial-of-service cases; and
- repeated/adaptive attack campaigns rather than only single prompts.

Report both attack success rate and control side effects: false positives, latency,
availability, user-visible failure behavior, and observability without sensitive
payload retention.

## Workstream C — CDE and segmentation test

If the approved scope relies on segmentation, test from every relevant Truenote
zone, provider integration, administrative path, CI/deployment path, and support
access path toward the CDE. Include routing, firewall/security-group rules, DNS,
identity pathways, shared services, logging, management planes, and failure-state
behavior. Application-level `program_id` isolation is not a substitute for this
test.

If Truenote is placed inside the CDE instead, test how compromise of Truenote,
its deployment platform, credentials, providers, or administrators could affect
CDE confidentiality, integrity, or availability.

## Threat-model coverage

The final scope and report must map every applicable stable ID in
[`threat-model.md`](./threat-model.md). At minimum:

- Workstream A covers TN-TM-001 through TN-TM-007, TN-TM-010, TN-TM-015,
  TN-TM-018 through TN-TM-020, TN-TM-025, and TN-TM-026.
- Workstream B covers TN-TM-008, TN-TM-009, and TN-TM-011 through TN-TM-014,
  including bypass, obfuscation, false-positive, fail-closed, and downstream
  receipt testing of the local OpenAI/Cohere pre-OpenRouter firewall plus the
  still-uncovered contextual name/address classes.
- The tester may use
  [`ai-adversarial-regression.md`](./ai-adversarial-regression.md) and its eight
  fixed cases as a regression seed, but must add independent methods/cases and
  must not treat fixture passing as sufficient scope or assurance.
- Workstream C covers TN-TM-023 and any shared identity, provider, CI/deployment,
  logging, management-plane, or recovery path relevant to TN-TM-001, TN-TM-012,
  TN-TM-017, TN-TM-021, TN-TM-022, and TN-TM-024.

An omitted threat requires a written applicability rationale approved by Product
Security and the PCI owner/QSA. Internal repository tests do not replace these
independent workstreams.

## Rules of engagement

- Written authorization identifies targets, exclusions, dates, source addresses,
  prohibited actions, data handling, stop conditions, and emergency contacts.
- Use synthetic PAN/PII and isolated test accounts. Never place live cardholder or
  customer data in the test report.
- Testers receive architecture and control documentation but retain freedom to
  test undocumented assumptions and alternate paths.
- Critical exploitable findings use the agreed immediate-notification channel.
- Detailed findings and exploit material stay in restricted storage.

## Required deliverables

- signed scope, methodology, dates, environment, tested commit/release, and
  tester organization/qualifications/independence statement;
- attack inventory with reproducible evidence, affected assets and data paths,
  severity/risk rationale, and control bypass or failure mode;
- explicit coverage limits and untested paths;
- management finding register with owners, due dates, and approved exceptions;
- remediation validation and independent retest results; and
- a shareable executive attestation/summary after remediation. Detailed reports
  should be distributed under the approved access policy, not automatically
  published.

## Acceptance

The engagement is complete only when the PCI owner/QSA accepts its scope, all
critical/high findings are independently retested closed or formally accepted by
authorized risk owners, residual findings have tracked owners/dates, and the
report maps to the assessed Truenote release and CDE boundary.
