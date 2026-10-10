# Repository verification record: 2026-10-10

**Evidence grade:** Local repository verification only  
**Record coverage:** Retirement of the SIEM delivery outbox in favor of the worker security monitor, 2026-10-10  
**Worktree base:** `5ac3068d` (remote `main` when the branch was cut)

| Check | Result |
|---|---|
| Production verifier source identity | `production-control-verification.sql` SHA-256 `A6ECF082FD5F358A17F2A9CCCCD81495C28600A8699AABDFC2560732A9C77EC9`; source only, not an execution receipt |
| Threat-model source identity | `threat-model.md` SHA-256 `88F89D51D5AF064C4AFE371475AD34715ADDBE94A75E21A5F5BF779AAF5AD423`; engineering source only, not a signed review or risk acceptance |

This record supersedes
[`verification-record-2026-10-07.md`](./verification-record-2026-10-07.md) as the
record the PCI evidence gate (`scripts/src/verify-pci-evidence.ts`) reads for
pinned source hashes. The earlier records stay unchanged as dated history. This
record is not a released-build, GitHub required-check, deployed-runtime, or
production-control receipt.

Both hashes are over the LF bytes stored in git. The gate reads the first line
that names each pinned file, so the two source identity rows above must stay the
first mention of those file names.

## Passed checks

| Check | Result |
|---|---|
| Locked local workspace install | Completed from existing `pnpm-lock.yaml`; no lockfile change |
| Workspace TypeScript checks | `pnpm -r run check` passed in all four TypeScript workspaces with zero errors |
| Workspace tests | `pnpm -r run test` passed: frontend 19 files/110 tests, API 63 files/548 tests, scripts 21 suites/85 tests |

## What changed

- The SIEM delivery outbox is retired (owner decision, 2026-10-10). Its code
  (`artifacts/api-server/src/lib/security/siem-outbox.ts` and its tests) and
  `docs/security/p1-siem-delivery-outbox.sql` are removed;
  `lib/db/sql/0013_drop_siem_delivery_outbox.sql` drops the empty table. The
  worker's security monitor replaces it (`docs/security/monitoring.md`).
- Production control verification SQL: the outbox table, columns, constraints,
  indexes, functions, trigger and privilege checks are removed. It now expects
  `service_heartbeats` and `security_monitor_state` (`lib/db/sql/0011`), checks
  that `PUBLIC` cannot execute `append_security_event` and that the runtime role
  can, and checks that `PUBLIC` has no privilege on `security_events`.
- Threat model: TB-07 now covers worker log lines, alert email and the daily log
  copy in a private GitHub repository. TN-TM-017 covers skipped, suppressed or
  delayed events and alerts and a stopped log copy. The threat count stays 26 and
  all nine trust boundaries remain.
- Production evidence ids `siem_delivery_alert`, `siem_retry_recovery` and
  `siem_dead_letter_response` are renamed `security_alert_delivery`,
  `security_monitor_recovery` and `audit_write_failure_alert`; runbook section 5
  describes the new exercises.

## Verification still required

Every item under "Verification still required" in the 2026-10-07 record remains
open, except SIEM delivery, which is replaced by:

- six of eleven alert rules not yet tested in production
  (`docs/security/monitoring.md`, "Alert test record");
- a review of the daily log export to `ryanportfolio/truenote-ops`, which first
  ran on 2026-10-10 and committed 2026-10-07 to 2026-10-09;
- the audit retention period (AU-11), open until the employer names its
  assessment framework;
- `lib/db/sql/0013_drop_siem_delivery_outbox.sql`, not yet applied in production.
