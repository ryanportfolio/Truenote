---
name: review-security-posture
description: Use when assessing Truenote security posture, reviewing FedRAMP alignment, checking P0/P1 or later phase progress, deciding what security work comes next, validating security claims, or refreshing the public security capabilities brief.
---

# Review Truenote security posture

Use the public capabilities brief as the baseline claim inventory. Repository, runtime, and retained evidence are authoritative. Plans and code do not prove operation.

## Sources

1. Read `docs/security/truenote-security-capabilities.html` and `docs/security/README.md` completely.
2. Read `docs/security/p0-p1-security-controls.sql`, `docs/security/p1-siem-delivery-outbox.sql`, `CLAUDE.md`, and the relevant `.claude/reference/` files.
3. Inspect implementation, tests, CI, configuration defaults, `.env.example`, DDL, diffs, and verification output. Find fail-open behavior and conflicts with published claims.
4. Request missing Replit, configuration, IdP/MFA, scanner, SIEM, vendor, branch-protection, incident, recovery, and assessment evidence.
5. Recheck time-sensitive claims using official regulatory/provider sources. Record URL and access date; label unavailable verification explicitly.

## Evidence grades

Use exactly these grades:

- **Verified:** direct evidence and acceptance check passed.
- **Implemented, unverified:** code exists; runtime/CI proof is missing.
- **Configuration required:** deployed settings or secrets are unproven.
- **Operational evidence required:** policy, owner, recurring execution, or retained proof is missing.
- **Third-party evidence required:** assurance depends on a provider or assessor.
- **Gap:** required control is absent or ineffective.
- **Not applicable:** named owner and written justification exist.

Never promote a grade from comments, intended behavior, unchecked boxes, seeded data, or a workflow that has not passed.

## Review workflow

1. Inventory published capability claims and their evidence locations, then identify gaps, rollout requirements, verification needs, and DDL dependencies.
2. Re-grade each from current evidence. Cite exact files, command output, configuration, or external records.
3. Check authentication, authorization, program/classification isolation, ingestion failures, approval separation, retrieval/citations, audit integrity/delivery, retention/purge, browser defenses, secrets, dependencies, and recovery.
4. Determine the earliest incomplete gate:
   - **P0:** safe deployment prerequisites, DDL, fail-closed integrations, SSO/MFA, audit delivery, negative tests, and staged verification.
   - **P1:** boundary, governance, vendor, cryptography, incident/recovery, evidence ownership, and recurring review.
   - **Later phase:** label **proposed** unless already defined. Derive it from residual engineering, continuous evidence, and assessment work.
5. Order five next actions by dependency. Give each an owner, evidence artifact, and binary acceptance test.

Return date/scope/confidence, phase gate, five next actions, blockers, claim limits, evidence questions, and a table of control, grade, evidence, risk, owner, action, and acceptance test.

Use calibrated language. Never say “FedRAMP compliant,” “FedRAMP-ready,” “fully controlled ingestion,” “production secure,” or “control effective” without the specific authorization or evidence needed for that statement.

## Updating the public capabilities brief

Default read-only. Update only when asked to refresh, save, or record posture.

When updating it:

- Preserve source links, evidence grades, and the evidence map.
- Lead with implemented capabilities and the acceptance checks that support them.
- Keep configuration or operational dependencies attached to the relevant capability.
- Keep internal database names, rollout prompts, secrets, and owner-only operational details out of the public brief.
- Treat the SQL files under `docs/security/` as canonical; link to them instead of embedding duplicate copies in HTML.
- Validate HTML and run available checks. State what could not run.

Do not treat the HTML as proof, equate local code with an operating control, infer provider eligibility from badges, collapse unlike gap types, or recommend rollout past an incomplete gate.
