# Evidence harness

The evidence harness collects dated, tamper-evident proof that Truenote's security controls operate in production. Each check is mapped to NIST SP 800-53 Rev. 5 Moderate controls and to the SP 800-53A determination statements its result is evidence for. It answers the question a security reviewer asks after reading a control mapping: show me that it runs.

This is a self-assessment. Receipts are produced by the system under test and its operator, and independent assessment (CA-2(1)) is not met. Every receipt carries that statement.

Plan approved by the owner on 2026-10-10. The API contract for the gated compliance pages is in [evidence-api.md](evidence-api.md).

## How it works

1. The check catalog (`artifacts/api-server/src/lib/evidence/catalog.ts`) lists every check: the controls and 800-53A objectives it covers, how often it runs, and its exact pass condition. Objective labels are copied from NIST's OSCAL Moderate baseline (Rev. 5.2.0) into `nist-800-53r5-moderate.json` by `scripts/src/evidence-nist-ids.ts`, and a unit test rejects any label the baseline does not contain.
2. A daily pg-boss job in the `worker` service (`evidence-run`, 05:23 UTC) runs every automated check and appends one receipt per check.
3. A receipt records the check id, its controls and objectives, the catalog version, start and finish times, the deployed commit, what the check read (inputs), what it observed (outputs), and `pass`, `fail` or `error`. `error` means the check could not run, so there is no evidence for that day.
4. Receipts go to the append-only `evidence_receipts` table (`lib/db/sql/0012_evidence_receipts.sql`). A database function computes the hash chain, so an edited, removed or reordered receipt breaks every later hash:

   ```text
   receipt_hash = sha256(previous_hash | id | recorded_at_text | sha256(payload))
   ```

   The application role can read receipts and call the append function; it cannot insert, update or delete rows. Triggers refuse UPDATE, DELETE and TRUNCATE for every role, the owner included.
5. Every day the harness re-verifies the evidence chain and the `security_events` chain, then sends the chain head hash (and only the hash) to a public RFC 3161 time-stamping authority. The token is accepted only after its CMS signature, message digest, nonce and timeStamping key usage verify and its signer chains to a pinned root (`checks/tsa-trust.ts`: FreeTSA Root CA, DigiCert Trusted Root G4); then it goes into a receipt. Anyone can later check with `openssl ts -verify` that the chain existed at that time, which narrows how far back an owner with database access could rewrite history to about a day.
6. When a run changes something that needs attention, the owner gets one email: a new failure, a known-gap link that expired, or a check that could not run twice in a row. A failure that stays failing does not repeat daily. An alert that could not be sent (mail outage, no recipient configured) stays pending in `app_settings` and is resent with every run until delivery succeeds.
7. A public endpoint, `/api/evidence/heartbeat`, returns only the time of the last receipt. The `Evidence harness watch` GitHub Action reads it daily from outside Railway and fails, which emails the owner, when receipts are more than 26 hours old. The same Action repeats the passive public checks from GitHub's network.

## Check types

| Type | Runs | Source | Phase |
|---|---|---|---|
| GitHub posture | worker, daily | GitHub REST API with a read-only fine-grained token | 1 |
| Public site | worker, daily; repeated by the watch Action | HTTPS, TLS and DNS requests any visitor can make | 1 |
| Database posture | worker, daily | Catalog queries and rolled-back refusal probes as `truenote_app` | 1 |
| Integrity | worker, daily | Chain recomputation and RFC 3161 timestamp | 1 |
| Production behavior | worker, daily | Synthetic accounts over real HTTPS | 2 |
| Operator check | owner, monthly | Owner-run script over `railway ssh` as the migration role | 3 |
| Attestations | owner, on reminder | Uploaded proof (screenshots, reports) | 3 |
| Monthly summary | worker, monthly | Receipts of the month and the chain head | 3 |

The catalog lists the checks built so far. Phases 2 and 3 add theirs.

### Why the worker and not GitHub Actions

The repository is public, so Action logs and artifacts are public. GitHub posture results (open alert counts, which protections are off) are weakness details. Running the checks in the worker keeps them in the production database, readable only by a super_user, and keeps any production write credential out of GitHub. The only public part is the heartbeat and the passive public checks, which show nothing a visitor cannot already see.

### Known gaps

Some checks will fail on purpose during the demo phase. The result is always recorded as observed. A super_user can link a failing check to an accepted POA&M item in the private `evidence_known_gaps` table, with an optional expiry, through the admin API. A linked failure is reported as "known, tracked" instead of "new failure"; when the link expires, the owner gets an email. Links are never written to this repository, because the catalog is public and a list of expected failures would publish the weaknesses.

### Synthetic accounts (phase 2)

Production-behavior checks use two synthetic programs that hold only canary documents, and synthetic users on a reserved `.invalid` email domain. An `is_synthetic` flag on programs and users, enforced in the database, refuses a synthetic user in a real program and a real user in a synthetic one. Synthetic rows are excluded from usage, insights and exports. Each scope test includes a positive control: an in-program synthetic user must retrieve the canary in the same run, otherwise the cross-program refusal is recorded as `error`, because a refusal caused by low retrieval confidence would otherwise pass. Cross-program tests also cover access by id (documents, citations, conversation history). Synthetic users have the lowest clearance that still tests the classification ceiling, and a synthetic login outside a harness run fails a receipt. The bad-password check proves that a wrong password is refused. The login limiter is per IP only, so the check is not evidence of account lockout (AC-7).

### Operator check and export (phase 3)

Once a month the owner runs one script over `railway ssh` as the migration role. It runs the read-only PCI catalog verifier (`docs/compliance/pci/production-control-verification.sql`) and rollback-only negative tests showing that the append-only triggers refuse even the owner, and appends an `operator` receipt. The same step exports the month's receipts, the attachment list and the chain head to the private repository `ryanportfolio/truenote-evidence`, whose ruleset blocks force-push and deletion.

### Attestations and monthly summary (phase 3)

The harness emails a reminder when an attestation is due: operator MFA screenshots (quarterly), workstation patch and anti-malware status (monthly), access review (quarterly), policy review (annual). The owner uploads the proof through a super_user API endpoint; the file goes to the `truenote-storage` bucket under `evidence/`, and its sha256 goes into a receipt. On the first of each month the worker builds a summary (result per control, failures, known gaps, chain head hash), stores it as a receipt and emails it to the owner, who forwards it to the customer's security reviewer. The reviewer's copy anchors the chain head outside the owner's control.

## Cadence

All cadences are proposals until the owner approves the organization-defined parameter values (`cadenceStatus: "proposed"` in the catalog). Automated checks run daily. The remediation window used by the open-alerts check (30 days for critical and high) is also a proposed value.

## Configuration

| Variable | Service | Purpose |
|---|---|---|
| `EVIDENCE_GITHUB_TOKEN` | worker | Fine-grained token, Truenote repository only, read-only: Administration, Actions, Code scanning alerts, Dependabot alerts, Secret scanning alerts, Metadata. Maximum one-year expiry; the `github.credential-expiry` check fails 30 days before. |
| `EVIDENCE_ALERT_EMAIL` | worker | Optional, comma-separated. Where evidence alerts go; defaults to the security monitor's `SECURITY_ALERT_EMAIL` (`docs/security/monitoring.md`). With neither set, alerts stay pending. |
| `EVIDENCE_GITHUB_REPO` | worker | Optional; defaults to `ryanportfolio/Truenote`. |
| `EVIDENCE_WATCH_ENABLED` | GitHub repository variable | `true` turns on the daily schedule of the watch Action. |

The deployed commit comes from `.release-commit`, written before `railway up` (`.claude/reference/deployment.md`, "Deploying").

## Turning on phase 1

Each step changes production and waits for the owner's go.

1. Apply the schema: `node scripts/railway-apply-sql.mjs lib/db/sql/0012_evidence_receipts.sql` (dry run), then with `--apply`.
2. Create the queue as the migration role: `pnpm --filter @workspace/scripts run pgboss:install` through the SSH tunnel (`docs/security/backup-restore-runbook.md`, section 4.4, step 5). Without it the worker logs `[evidence] worker not started` and keeps ingesting.
3. Create the GitHub token and set `EVIDENCE_GITHUB_TOKEN` on the worker (alerts use `SECURITY_ALERT_EMAIL` unless `EVIDENCE_ALERT_EMAIL` is set).
4. Deploy web and worker from the same commit, with `.release-commit` written first.
5. Trigger a run (`POST /api/admin/evidence/runs` as a super_user) and check: 18 receipts, every one with a `release.commit`; `GET /api/admin/evidence/chain` shows both integrity checks passing and a timestamp token; `/api/evidence/heartbeat` reports `stale: false`.
6. Link the expected demo-phase failures to their POA&M items (`POST /api/admin/evidence/gaps`).
7. Set the repository variable `EVIDENCE_WATCH_ENABLED=true` and run the watch Action once by hand.

## Limits

- Self-assessment; see the statement at the top.
- The database checks run as the role they check. Refusals by the owner role are proven only by the monthly operator check.
- Anyone with the database owner role can rewrite the chain consistently. The daily timestamp, the monthly summary held by the reviewer and the monthly export to the private repository make that detectable after the fact; they do not prevent it.
- The worker's public-site checks start inside Railway's network. The watch Action repeats them from GitHub's network, but its results stay in Action logs, not receipts.
- A pass shows the control was in place when the check ran, not between runs.
