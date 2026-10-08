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

[`truenote-security-capabilities.html`](./truenote-security-capabilities.html) is
the public `/security/` source. It includes only completed safeguards with passed
repository checks and keeps each claim inside its stated evidence scope.

### Public PCI safeguards brief

[`truenote-pci-security-capabilities.html`](./truenote-pci-security-capabilities.html)
is the public `/security/pci/` source. It explains PCI DSS secure-software
expectations in plain language and lists only completed safeguards and passed
checks. It is not a compliance, certification, or independent-assessment claim.

### Internal PCI session ledger

The living security-readiness session ledger retains completed work, exact
verification, pending decisions, evidence grades, owners, blockers, and next
actions. The maintainer keeps it outside this public repository.

### Database controls

- [`p0-p1-security-controls.sql`](./p0-p1-security-controls.sql) defines provenance, lifecycle, classification, approval, retention, distributed rate limits, and hash-chained security events.
- [`p1-siem-delivery-outbox.sql`](./p1-siem-delivery-outbox.sql) defines transactional SIEM enqueueing, lease-fenced claims, retries, dead-letter state, and delivery health.
- [`../compliance/pci/production-control-verification.sql`](../compliance/pci/production-control-verification.sql) and its runbook provide read-only production catalog/definition evidence without selecting application rows; no production result is retained yet.
- [`malware-scanning-control.sql`](./malware-scanning-control.sql) adds the explicit database state used by the audited super-user temporary scanner override.
- [`review-approval-control.sql`](./review-approval-control.sql) removes the legacy database-wide self-approval prohibition so authorized senior managers and super users can activate their own uploads.

These migrations are forward-only operational changes. Review the embedded guardrails and verification queries before applying them. Repository presence does not prove they are installed in a given database.

## Evidence and operations

- The base P0/P1 database controls passed owner-attested acceptance checks in the former Replit development database. Railway has no development database; its production database is a 2026-10-07 copy of Replit production with constraint definitions and the `append_security_event` body checked identical to the source (`.claude/reference/deployment.md`). Production verification of these controls on Railway is still pending.
- The security workflow runs type checks, a production build, unit tests, dependency audit, SBOM generation, Gitleaks, and CodeQL.
- OIDC and MFA, malware scanning, durable SIEM delivery, browser policy, and provider settings have defined configuration and verification paths. Backup/recovery procedures, RTO/RPO, and a retained restore exercise remain operational evidence requirements.
- Hash-chained application events preserve tamper-evident receipts; the SIEM outbox provides durable external delivery with retry and dead-letter handling.
- [`incident-response-plan.md`](./incident-response-plan.md) defines severity levels, detection sources, containment steps mapped to the Railway services and CLI, proposed customer-notice windows, evidence preservation, and tabletop exercises. It is proposed and not yet exercised.
- [`backup-restore-runbook.md`](./backup-restore-runbook.md) defines proposed RPO/RTO targets, a restore-to-non-production-first procedure for the Railway stack, verification checks, and the restore evidence record. Volume backups on the `pgvector` database are off (owner decision, 2026-10-07) and must be turned on before full production; until then an operator's logical dump is the only database recovery copy, and uploaded files have no backup. No restore test has been run yet.

## PCI DSS readiness

[`../compliance/pci/README.md`](../compliance/pci/README.md) maps the current
repository and missing operational evidence to PCI DSS secure-software controls and related
scope, provider, change-control, and penetration-testing dependencies. It is a
draft readiness package for the existing CDE assessment process, not a compliance
or certification claim.

## Reporting

Report suspected vulnerabilities through GitHub's
[private vulnerability intake](https://github.com/ryanportfolio/Truenote/security/advisories/new)
or follow the repository [`SECURITY.md`](../../SECURITY.md). RFC 9116 discovery
at `/.well-known/security.txt` points directly to those maintained GitHub
surfaces. The broken `/security/report/` destination was removed from public
navigation and the sitemap; PCI Readiness now occupies that Security-page
position. Keep exploit details out of public issues. Intake operation remains
unverified until the acceptance steps in the PCI evidence pack are retained.
