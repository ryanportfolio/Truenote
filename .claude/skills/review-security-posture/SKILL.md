---
name: review-security-posture
description: Use when assessing Truenote security posture, reviewing FedRAMP alignment, checking P0/P1 or later phase progress, deciding what security work comes next, validating security claims, or refreshing the shared security posture HTML.
---

# Review Truenote security posture

Use the shared HTML as baseline. Repository, runtime, and retained evidence are authoritative. Plans and code do not prove operation.

## Sources

1. Read `docs/security/truenote-p0-p1-security-review.html` completely.
2. Read `CLAUDE.md` plus `.claude/reference/environment.md`, `secrets.md`, `ingestion.md`, and `data-model.md`.
3. Inspect implementation, tests, CI, configuration defaults, `.env.example`, DDL, diffs, and verification output. Find fail-open behavior and conflicts with the HTML.
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

1. Inventory HTML claims and open items: implementation, gaps, rollout, verification, DDL, and evidence map.
2. Re-grade each from current evidence. Cite exact files, command output, configuration, or external records.
3. Check authentication, authorization, program/classification isolation, ingestion failures, approval separation, retrieval/citations, audit integrity/delivery, retention/purge, browser defenses, secrets, dependencies, and recovery.
4. Determine the earliest incomplete gate:
   - **P0:** safe deployment prerequisites, DDL, fail-closed integrations, SSO/MFA, audit delivery, negative tests, and staged verification.
   - **P1:** boundary, governance, vendor, cryptography, incident/recovery, evidence ownership, and recurring review.
   - **Later phase:** label **proposed** unless already defined. Derive it from residual engineering, continuous evidence, and assessment work.
5. Order five next actions by dependency. Give each an owner, evidence artifact, and binary acceptance test.

Return date/scope/confidence, phase gate, five next actions, blockers, claim limits, evidence questions, and a table of control, grade, evidence, risk, owner, action, and acceptance test.

Use calibrated language. Never say “FedRAMP compliant,” “FedRAMP-ready,” “fully controlled ingestion,” “production secure,” or “control effective” without the specific authorization or evidence needed for that statement.

## Updating the shared HTML

Default read-only. Update only when asked to refresh, save, or record posture.

When updating it:

- Preserve the claim disclaimer, source links, full embedded DDL, and displayed DDL hash.
- Add review date, grade, owner, acceptance test, and evidence location for changed claims.
- Keep unresolved findings visible.
- Compare embedded DDL byte-for-byte with `docs/security/p0-p1-security-controls.sql` and recompute SHA-256.
- Validate HTML and run available checks. State what could not run.

Do not treat the HTML as proof, equate local code with an operating control, infer provider eligibility from badges, collapse unlike gap types, or recommend rollout past an incomplete gate.
