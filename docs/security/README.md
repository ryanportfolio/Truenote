# Truenote security documentation

Start here to understand Truenote's security architecture, the controls implemented in this repository, and the evidence used to test them.

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

### Database controls

- [`p0-p1-security-controls.sql`](./p0-p1-security-controls.sql) defines provenance, lifecycle, classification, approval, retention, distributed rate limits, and hash-chained security events.
- [`p1-siem-delivery-outbox.sql`](./p1-siem-delivery-outbox.sql) defines transactional SIEM enqueueing, lease-fenced claims, retries, dead-letter state, and delivery health.

These migrations are forward-only operational changes. Review the embedded guardrails and verification queries before applying them. Repository presence does not prove they are installed in a given database.

## Evidence and operations

- The base P0/P1 database controls passed owner-attested acceptance checks in the development database.
- The security workflow runs type checks, a production build, unit tests, dependency audit, SBOM generation, Gitleaks, and CodeQL.
- OIDC and MFA, malware scanning, durable SIEM delivery, browser policy, provider settings, backups, and recovery procedures each have explicit configuration and verification paths.
- Hash-chained application events preserve tamper-evident receipts; the SIEM outbox provides durable external delivery with retry and dead-letter handling.

## Reporting

Report suspected vulnerabilities through [`SECURITY.md`](../../SECURITY.md). Keep exploit details out of public issues.
