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
the public `/security/` source. It distinguishes repository-tested safeguards
from deployed configuration, operational dependencies, and open requirements
before customer use. Each claim stays inside its stated evidence scope.

### Public PCI safeguards brief

[`truenote-pci-security-capabilities.html`](./truenote-pci-security-capabilities.html)
is the public `/security/pci/` source. It explains the PCI DSS 4.0.1 review basis,
payment-data and raw-file boundaries, software safeguards, draft procedures,
all 12 requirement families, and approval requirements. It is not a compliance,
certification, or independent-assessment claim.

[`security-review-2026-10-09.md`](./security-review-2026-10-09.md) records the
latest-main page review, scoped live observations, claim corrections, control
grades, and five dependency-ordered actions. P0 remains incomplete; the report
does not authorize customer use or production changes.

### Internal PCI session ledger

The living security-readiness session ledger retains completed work, exact
verification, pending decisions, evidence grades, owners, blockers, and next
actions. The maintainer keeps it outside this public repository.

### Database controls

- [`p0-p1-security-controls.sql`](./p0-p1-security-controls.sql) defines provenance, lifecycle, classification, approval, retention, distributed rate limits, and hash-chained security events.
- [`p1-siem-delivery-outbox.sql`](./p1-siem-delivery-outbox.sql) defines transactional SIEM enqueueing, lease-fenced claims, retries, dead-letter state, and delivery health.
- [`../compliance/pci/production-control-verification.sql`](../compliance/pci/production-control-verification.sql) and its runbook provide read-only production catalog/definition evidence without selecting application rows. A [limited October 9 audit-catalog receipt](evidence/railway-audit-catalog-2026-10-09.json) is retained; the full formal verifier has not been executed.
- [`malware-scanning-control.sql`](./malware-scanning-control.sql) adds the explicit database state used by the audited super-user temporary scanner override.
- [`review-approval-control.sql`](./review-approval-control.sql) removes the legacy database-wide self-approval prohibition so authorized senior managers and super users can activate their own uploads.

These migrations are forward-only operational changes. Review the embedded guardrails and verification queries before applying them. Repository presence does not prove they are installed in a given database.

[`../../lib/db/sql/0000_baseline.sql`](../../lib/db/sql/0000_baseline.sql) is a schema-only dump of the Railway production database as of 2026-10-07. The October 9 live catalog check found the hash-chain append function present but the audit mutation-blocking, lifecycle and source-audit functions and triggers absent, and both application processes connected as a database superuser ([receipt](evidence/railway-audit-catalog-2026-10-09.json)). Later on October 9, `lib/db/sql/0007` to `0009` were applied: the append-only and truncate guards and the lifecycle and source-audit triggers are installed, and `web` and `worker` connect as `truenote_app`, a role that owns nothing, runs no DDL, and can read `security_events` but write it only through the append function ([remediation receipt](evidence/railway-app-role-2026-10-09.json)). SIEM delivery functions and their enqueue trigger remain absent. The full formal catalog verifier and synthetic acceptance checks are still required. New schema changes, security DDL included, are numbered files in `lib/db/sql/` applied to production by `scripts/railway-apply-sql.mjs`, which records each file in `schema_migrations`. The production image is built from `Dockerfile.railway`.

## Evidence and operations

- The base P0/P1 database controls passed owner-attested acceptance checks in the former Replit development database. Railway has no development database; its production database is a 2026-10-07 copy of Replit production with constraint definitions and the `append_security_event` body checked identical to the source (`.claude/reference/deployment.md`). Limited October 9 live checks confirmed missing audit controls and excessive runtime privilege; both were remediated the same day and rechecked with a privilege sweep and rolled-back negative tests. Full production acceptance remains pending.
- The security workflow runs type checks, a production build, unit tests, dependency audit, SBOM generation, Gitleaks, and CodeQL.
- OIDC and MFA, malware scanning, durable SIEM delivery, browser policy, and provider settings have defined configuration and verification paths. Backup/recovery procedures, RTO/RPO, and a retained restore exercise remain operational evidence requirements.
- Hash-chained application events are append-only in the database: the application role cannot update, delete or truncate them, and triggers refuse updates, deletes and truncation from any role, the owner included. The owner can still disable those triggers, so retention that resists a database administrator needs the external SIEM copy. The SIEM outbox provides durable external delivery with retry and dead-letter handling once installed and configured.
- SIEM delivery is not active on Railway (catalog rechecked 2026-10-09). The `siem_delivery_outbox` table exists, but the functions from `p1-siem-delivery-outbox.sql` (`enqueue_security_event_for_siem`, `claim_siem_deliveries`, `complete_siem_delivery`, `fail_siem_delivery`, `get_siem_delivery_health`) and the `security_events_siem_enqueue` trigger are absent, a gap inherited from the Replit database. The live web endpoint and signing-key settings are absent.
- [Current CodeQL review](../compliance/pci/codeql-review-2026-10-09.md) and its [API receipt](evidence/github-codeql-status-2026-10-09.json) replace historical counts in current reporting: 31 open alerts, eight fixed and nine dismissed. Source review distinguishes seven false positives, one expected operator credential flow and 23 intentional demo-phase omissions of application rate limits. The July 51-result baseline remains unreconciled historical evidence, not a current vulnerability count.
- [`monitoring.md`](./monitoring.md) describes security alerting, the `/health/ready` readiness check, where logs are kept and for how long, and the alert test record. The code is in the repository; it is not deployed and no alert has been tested yet.
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
