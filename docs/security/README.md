# Truenote security documentation

Start here to understand what the repository implements, what has evidence, and what still depends on a deployment or an organization.

## Claim model

Security statements use these grades:

| Grade | Meaning |
|---|---|
| Verified | Direct evidence exists and the acceptance check passed. |
| Implemented, unverified | Code or DDL exists, but runtime or CI proof is missing. |
| Configuration required | The control depends on deployed settings or secrets that are not proven here. |
| Operational evidence required | A policy, owner, recurring process, or retained artifact is missing. |
| Third-party evidence required | Assurance depends on a provider or assessor. |
| Gap | A required control is absent or ineffective. |
| Not applicable | A named owner and written justification show why the control does not apply. |

Comments, intended behavior, seeded data, and unchecked rollout steps do not raise a grade.

## Documents

### Security capabilities brief

[`truenote-security-capabilities.html`](./truenote-security-capabilities.html) explains the control architecture and traces capabilities to repository files. Use it for a technical overview.

### Dated P0/P1 posture review

[`truenote-p0-p1-security-review.html`](./truenote-p0-p1-security-review.html) is the detailed July 14, 2026 review packet. It records evidence grades, unresolved findings, rollout dependencies, acceptance tests, exact DDL copies, and claim limits.

The review is a dated artifact. Recheck current repository state, CI, deployed settings, provider assurances, and retained operational evidence before repeating any status from it.

### Database controls

- [`p0-p1-security-controls.sql`](./p0-p1-security-controls.sql) defines provenance, lifecycle, classification, approval, retention, distributed rate limits, and hash-chained security events.
- [`p1-siem-delivery-outbox.sql`](./p1-siem-delivery-outbox.sql) defines transactional SIEM enqueueing, lease-fenced claims, retries, dead-letter state, and delivery health.

These migrations are forward-only operational changes. Review the embedded guardrails and verification queries before applying them. Repository presence does not prove they are installed in a given database.

## Current claim limits

- The base P0/P1 database controls have owner-attested development acceptance, but raw verification output is not retained in this repository.
- The security workflow exercises type checks, unit tests, dependency audit, SBOM generation, Gitleaks, and CodeQL. Branch-protection configuration requires repository-owner confirmation.
- OIDC and MFA, the external malware scanner, durable SIEM delivery, browser policy, provider retention settings, backups, and incident or recovery processes require deployed or operational evidence.
- A hash-chained application ledger is not an external WORM archive.
- No independent application assessment or FedRAMP authorization is claimed.

## Reporting

Report suspected vulnerabilities through [`SECURITY.md`](../../SECURITY.md). Keep exploit details out of public issues.
