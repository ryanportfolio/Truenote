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

### PCI DSS readiness ledger

The living
[`security-readiness session ledger`](../compliance/pci/security-readiness-session-report-2026-07-16.html)
is also published from that same source at `/security/pci/`. It records completed
Requirement 6 work, exact repository verification, open owner decisions, and
independent-assurance gaps. It is a readiness record, not a compliance or
certification claim.

### Database controls

- [`p0-p1-security-controls.sql`](./p0-p1-security-controls.sql) defines provenance, lifecycle, classification, approval, retention, distributed rate limits, and hash-chained security events.
- [`p1-siem-delivery-outbox.sql`](./p1-siem-delivery-outbox.sql) defines transactional SIEM enqueueing, lease-fenced claims, retries, dead-letter state, and delivery health.
- [`../compliance/pci/production-control-verification.sql`](../compliance/pci/production-control-verification.sql) and its runbook provide read-only production catalog/definition evidence without selecting application rows; no production result is retained yet.
- [`malware-scanning-control.sql`](./malware-scanning-control.sql) adds the explicit database state used by the audited super-user temporary scanner override.
- [`review-approval-control.sql`](./review-approval-control.sql) removes the legacy database-wide self-approval prohibition so authorized senior managers and super users can activate their own uploads.

These migrations are forward-only operational changes. Review the embedded guardrails and verification queries before applying them. Repository presence does not prove they are installed in a given database.

## Evidence and operations

- The base P0/P1 database controls passed owner-attested acceptance checks in the development database.
- The security workflow runs type checks, a production build, unit tests, dependency audit, SBOM generation, Gitleaks, and CodeQL.
- OIDC and MFA, malware scanning, durable SIEM delivery, browser policy, and provider settings have defined configuration and verification paths. Backup/recovery procedures, RTO/RPO, and a retained restore exercise remain operational evidence requirements.
- Hash-chained application events preserve tamper-evident receipts; the SIEM outbox provides durable external delivery with retry and dead-letter handling.

## PCI DSS readiness

[`../compliance/pci/README.md`](../compliance/pci/README.md) maps the current
repository and missing operational evidence to PCI DSS Requirement 6 and related
scope, provider, change-control, and penetration-testing dependencies. It is a
draft readiness package for the existing CDE assessment process, not a compliance
or certification claim. The
[`security-readiness session ledger`](../compliance/pci/security-readiness-session-report-2026-07-16.html)
preserves security-team feedback, completed changes, verification, open work, and
next actions across long-running tasks and context compaction.

## Reporting

Report suspected vulnerabilities through the dedicated
[`/security/report/` source](../../artifacts/rag-app/public/security/report/index.html),
which is linked from the public security-capabilities brief, or use the
repository [`SECURITY.md`](../../SECURITY.md). Keep exploit details out of public
issues. Public deployment and intake operation remain unverified until the
acceptance steps in the PCI evidence pack are retained.
