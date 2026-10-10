# Repository verification record: 2026-10-10

**Evidence grade:** Local repository verification only  
**Record coverage:** Two changes on 2026-10-10: the generation-excerpt firewall scope and OpenRouter guardrail preset change (pull request #221), and the retirement of the SIEM delivery outbox in favor of the worker security monitor (pull request #223)  
**Worktree base:** `3ecb58f10ef61b6d329322cc449522fa49c3d19c` for #221 and `5ac3068d` for #223 (remote `main` when each branch was cut); this combined record was written when #223 merged `main` at `365c447b`

| Check | Result |
|---|---|
| Production verifier source identity | `production-control-verification.sql` SHA-256 `A6ECF082FD5F358A17F2A9CCCCD81495C28600A8699AABDFC2560732A9C77EC9`; changed by #223; source only, not an execution receipt |
| Threat-model source identity | `threat-model.md` SHA-256 `22E242B35664065B21EB08112161603E8A2FD12D0E77F627F0520E514A784038`; includes both changes; engineering source only, not a signed review or risk acceptance |

This record supersedes
[`verification-record-2026-10-07.md`](./verification-record-2026-10-07.md) as the
record the PCI evidence gate (`scripts/src/verify-pci-evidence.ts`) reads for
pinned source hashes. The 2026-10-07 record stays unchanged as dated history.
#221 first wrote this file with its own hashes; #223 merged both changes into it.
This record is not a released-build, GitHub required-check, deployed-runtime, or
production-control receipt.

Both hashes are over the LF bytes stored in git, which is what a Linux CI
checkout reads. A Windows checkout with `core.autocrlf=true` holds CRLF copies,
so the gate reports a stale hash there unless the files are checked out with LF.
The gate reads the first line that names each pinned file, so the source
identity rows above must stay the first mention of those file names.

## Passed checks

| Check | Result |
|---|---|
| Workspace TypeScript checks (#221) | `pnpm -r run check` passed in all four TypeScript workspaces with zero errors |
| Workspace tests (#221) | `pnpm -r run test` passed: frontend 110 tests, API 518 tests, scripts 77 tests |
| Workspace TypeScript checks and tests (#223, after merging `main`) | Counts in the pull request's verification section at its merge head |

## What changed

From #221:

- Threat model: the TB-04 control column states that, since 2026-10-10,
  approved-document excerpts in answer-generation requests get only the
  blocking-class redaction (secrets, SSNs, payment cards). The question,
  history, rewrite and naming input keep the full deterministic firewall.
- Pre-provider firewall record, scope and data flow, and OpenRouter guardrail
  evidence record: the same excerpt scope, plus the owner's removal of the
  guardrail's person-name and street-address presets. A screenshot of the
  changed guardrail is not yet in `evidence/`.

From #223:

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
  delayed events and alerts and a stopped log copy.
- Production evidence ids `siem_delivery_alert`, `siem_retry_recovery` and
  `siem_dead_letter_response` are renamed `security_alert_delivery`,
  `security_monitor_recovery` and `audit_write_failure_alert`; runbook section 5
  describes the new exercises.

The threat count stays 26 and all nine trust boundaries remain.

## Verification still required

Every item under "Verification still required" in the 2026-10-07 record remains
open, except SIEM delivery, which #223 replaces. In addition:

- A screenshot or export of the changed OpenRouter guardrail configuration.
- A deployed answer request showing contact details from an approved excerpt
  reach the model while a synthetic secret in a document title does not.
- Six of eleven alert rules not yet tested in production
  (`docs/security/monitoring.md`, "Alert test record").
- A review of the daily log export to `ryanportfolio/truenote-ops`, which first
  ran on 2026-10-10 and committed 2026-10-07 to 2026-10-09.
- The audit retention period (AU-11), open until the employer names its
  assessment framework.
- `lib/db/sql/0013_drop_siem_delivery_outbox.sql`, not yet applied in production.
