# Repository verification record: 2026-10-10

**Evidence grade:** Local repository verification only  
**Record coverage:** Generation-excerpt firewall scope and OpenRouter guardrail preset change on 2026-10-10 (pull request #221)  
**Worktree base:** `3ecb58f10ef61b6d329322cc449522fa49c3d19c` (remote `main` when the branch was cut)

This record supersedes
[`verification-record-2026-10-07.md`](./verification-record-2026-10-07.md) as the
record the PCI evidence gate (`scripts/src/verify-pci-evidence.ts`) reads for
pinned source hashes. The 2026-10-07 record stays unchanged as dated history.
This record is not a released-build, GitHub required-check, deployed-runtime, or
production-control receipt.

## Passed checks

| Check | Result |
|---|---|
| Production verifier source identity | `production-control-verification.sql` SHA-256 `09C51D8D76BB5D468FEDB84D397FA35316CF3C6436048318B356A25569028CCB`; unchanged since the 2026-07-16 record; source only, not an execution receipt |
| Threat-model source identity | `threat-model.md` SHA-256 `5FED1C63D3B29E63D27E67FB8A9F665111B68EB2759355F030D0FBA5D7E0F3B9`; engineering source only, not a signed review or risk acceptance |
| Workspace TypeScript checks | `pnpm -r run check` passed in all four TypeScript workspaces with zero errors |
| Workspace tests | `pnpm -r run test` passed: frontend 110 tests, API 518 tests, scripts 77 tests |

Both hashes are over the LF bytes stored in git, which is what a Linux CI
checkout reads. A Windows checkout with `core.autocrlf=true` holds CRLF copies,
so the gate reports a stale hash there unless the files are checked out with LF.
The gate reads the first line that names each pinned file, so the source
identity rows above must stay the first mention of those file names.

## What changed

- Threat model: the TB-04 control column states that, since 2026-10-10,
  approved-document excerpts in answer-generation requests get only the
  blocking-class redaction (secrets, SSNs, payment cards). The question,
  history, rewrite and naming input keep the full deterministic firewall. The
  threat count stays 26 and all nine trust boundaries remain.
- Pre-provider firewall record, scope and data flow, and OpenRouter guardrail
  evidence record: the same excerpt scope, plus the owner's removal of the
  guardrail's person-name and street-address presets. A screenshot of the
  changed guardrail is not yet in `evidence/`.
- Production control verification SQL: unchanged; its hash is carried forward.

## Verification still required

Every item under "Verification still required" in the 2026-10-07 record remains
open. In addition:

- A screenshot or export of the changed OpenRouter guardrail configuration.
- A deployed answer request showing contact details from an approved excerpt
  reach the model while a synthetic secret in a document title does not.
