# Repository verification record: 2026-10-07

**Evidence grade:** Local repository verification only  
**Record coverage:** Railway hosting update to the threat model and PCI documents on 2026-10-07  
**Worktree base:** `fafc1d59288b86226993fc4c02d15ac7f4b35b29` (remote `main` when the branch was cut)

This record supersedes
[`verification-record-2026-07-16.md`](./verification-record-2026-07-16.md) as the
record the PCI evidence gate (`scripts/src/verify-pci-evidence.ts`) reads for
pinned source hashes. The 2026-07-16 record stays unchanged as dated history.
This record is not a released-build, GitHub required-check, deployed-runtime, or
production-control receipt.

## Passed checks

| Check | Result |
|---|---|
| Locked local workspace install | Completed from existing `pnpm-lock.yaml`; no lockfile change |
| Workspace TypeScript checks | `pnpm -r run check` passed in all four TypeScript workspaces (`lib/db`, `artifacts/rag-app`, `artifacts/api-server`, `scripts`) with zero errors |
| Workspace tests | `pnpm -r run test` passed: frontend 14 files/63 tests, API 47 files/267 tests, scripts 19 suites/77 tests, 407 total. Scripts include a new test that the gate reads the newest dated verification record and that its first mention of each pinned file carries a SHA-256 |
| PCI evidence integrity gate | `verify:pci-evidence` passed with LF copies of the two pinned files: 40 PCI Markdown files, 1 public evidence grade, 1 read-only SQL artifact, 2 hash-bound OpenRouter screenshots, 26 threat rows, 51 vulnerability fingerprints, and 11 required vulnerability-source categories. On the Windows CRLF checkout it failed only on the two pinned hashes |
| Production verifier source identity | `production-control-verification.sql` SHA-256 `09C51D8D76BB5D468FEDB84D397FA35316CF3C6436048318B356A25569028CCB`; unchanged since the 2026-07-16 record; source only, not an execution receipt |
| Threat-model source identity | `threat-model.md` SHA-256 `9465762D7DFFBA54FFE2ECB2298142F1676BF8F4647EF4B8A9B473AB906F09A8`; engineering source only, not a signed review or risk acceptance |

Both hashes are over the LF bytes stored in git, which is what a Linux CI
checkout reads. A Windows checkout with `core.autocrlf=true` holds CRLF copies,
so the gate reports a stale hash there unless the files are checked out with LF.
The gate reads the first line that names each pinned file, so the source
identity rows above must stay the first mention of those file names.

## What changed

- Threat model: TB-08 now names `railway up` uploads from an operator
  workstation as the deployment path and records that nothing ties the deployed
  bytes to a CI-verified `main` commit; TN-TM-022 and its release blocker carry
  the same gap. TB-09 names Railway (`web` and `worker` services, Postgres 18
  with pgvector, Railway Bucket), Replit only as the DNS rollback target, and AI
  providers. The threat count stays 26 and all nine trust boundaries remain.
- Third-party responsibility matrix: a temporary Replit row and a Railway row
  that records the single `production` environment as a current gap.
- Production evidence capture runbook and AI adversarial regression procedure:
  the synthetic AI regression run is blocked until Railway has an authorized
  non-production environment.
- PCI README: current-as-of date and a link to this record.
- Production control verification SQL: unchanged; its hash is carried forward.

## Verification still required

Every item under "Verification still required" in the 2026-07-16 record remains
open, with Railway in place of Replit for deployment, production database
definitions, SIEM delivery, and backup/restore. In addition:

- Railway deployments are not bound to a CI-verified `main` commit (TN-TM-022).
- Railway has no non-production environment, which blocks the synthetic AI
  regression run and any change testing outside production.
- SIEM delivery is inactive on Railway: the outbox functions and trigger are
  absent and `SIEM_WEBHOOK_URL` is unset (`docs/security/README.md`).
- Railway has no database backups configured.
