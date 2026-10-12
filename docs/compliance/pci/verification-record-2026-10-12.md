# Repository verification record: 2026-10-12

**Evidence grade:** Local repository verification only  
**Record coverage:** Replit deployment unpublished on 2026-10-12: TB-09 in the threat model no longer names Replit as the DNS rollback target  
**Worktree base:** `047bc5b575a3612d8d97f6366e4e15f1c3469ab1` (remote `main` when the branch was cut)

| Check | Result |
|---|---|
| Production verifier source identity | `production-control-verification.sql` SHA-256 `A6ECF082FD5F358A17F2A9CCCCD81495C28600A8699AABDFC2560732A9C77EC9`; unchanged since the 2026-10-10 record; source only, not an execution receipt |
| Threat-model source identity | `threat-model.md` SHA-256 `1716386BF3BEFFD5B2A40A1BF42A47FE2DB81126F605B46AC3A1BF3C4644463B`; engineering source only, not a signed review or risk acceptance |

This record supersedes
[`verification-record-2026-10-10.md`](./verification-record-2026-10-10.md) as the
record the PCI evidence gate (`scripts/src/verify-pci-evidence.ts`) reads for
pinned source hashes. The 2026-10-10 record stays unchanged as dated history.
This record is not a released-build, GitHub required-check, deployed-runtime, or
production-control receipt.

Both hashes are over the LF bytes stored in git, which is what a Linux CI
checkout reads. A Windows checkout with `core.autocrlf=true` holds CRLF copies,
so the gate reports a stale hash there unless the files are checked out with LF.
The gate reads the first line that names each pinned file, so the source
identity rows above must stay the first mention of those file names.

## What changed

- Threat model: TB-09 names Replit only for `truenote.org` DNS editing until the
  transfer to Namecheap completes, and records that its deployment was
  unpublished on 2026-10-12. The threat count and the nine trust boundaries are
  unchanged.
- Third-party responsibility matrix: the temporary Replit row now covers DNS
  editing and the bucket with the 8 old demo uploads; the deployment is
  unpublished.
- Production control verification SQL: unchanged; its hash is carried forward.

## Checks

| Check | Result |
|---|---|
| Former deployment | A request for `truenote.org` sent to `34.111.179.208` answers 404 (2026-10-12, about 01:05 UTC) |
| Production site | `https://truenote.org/health` 200 from Railway (`69.46.46.101`); `www` answers 308 |
| Hashes | Computed with SHA-256 over `git show HEAD:<path>` bytes (LF) |

## Verification still required

Every item still open in the 2026-10-10 record remains open. In addition, the
Replit project (its copy of the demo data, the bucket with the 8 old demo
uploads, and its secrets) remains until the owner deletes it, and keys shared
with Railway have not been compared or rotated.
