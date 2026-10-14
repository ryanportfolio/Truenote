# Repository verification record: 2026-10-14

**Evidence grade:** Local repository verification only
**Record coverage:** Domain transfer to Namecheap on 2026-10-14: TB-09 in the threat model names Namecheap as registrar and DNS host and gives Replit no production role
**Worktree base:** `da0d400259ec160d59d46d51b5e1665af3f4ae1d` (remote `main` when the branch was cut)

| Check | Result |
|---|---|
| Production verifier source identity | `production-control-verification.sql` SHA-256 `A6ECF082FD5F358A17F2A9CCCCD81495C28600A8699AABDFC2560732A9C77EC9`; unchanged since the 2026-10-12 record; source only, not an execution receipt |
| Threat-model source identity | `threat-model.md` SHA-256 `67BC579CF61B7999DAE6FCEFCECBF80FBB3E2CFD1D3E6D23E1D6B1352A594D2B`; engineering source only, not a signed review or risk acceptance |

This record supersedes
[`verification-record-2026-10-12.md`](./verification-record-2026-10-12.md) as the
record the PCI evidence gate (`scripts/src/verify-pci-evidence.ts`) reads for
pinned source hashes. The 2026-10-12 record stays unchanged as dated history.
This record is not a released-build, GitHub required-check, deployed-runtime, or
production-control receipt.

Both hashes are over the LF bytes stored in git, which is what a Linux CI
checkout reads. A Windows checkout with `core.autocrlf=true` holds CRLF copies,
so the gate reports a stale hash there unless the files are checked out with LF.
The gate reads the first line that names each pinned file, so the source
identity rows above must stay the first mention of those file names.

## What changed

- Threat model: TB-09 names Namecheap as registrar and DNS host for
  `truenote.org` since 2026-10-14, and no longer names Replit for DNS editing.
  The threat count and the nine trust boundaries are unchanged.
- Third-party responsibility matrix: new Namecheap row; the temporary Replit row
  no longer claims a DNS role.
- Contingency plan: the DNS dependency and the provider contact list name
  Namecheap instead of Name.com through Replit's DNS screen.
- Production control verification SQL: unchanged; its hash is carried forward.

## Checks

| Check | Result |
|---|---|
| Registry | RDAP for `truenote.org`: registrar NameCheap, Inc.; nameservers `dns1.registrar-servers.com`, `dns2.registrar-servers.com`; `delegationSigned` false; transfer event 2026-10-14T00:21:59Z |
| Delegation | A `.org` TLD server returned the Namecheap nameservers from about 17:05 UTC on 2026-10-14 (before that, four `name.com` servers that refused queries) |
| Production site | `https://truenote.org/health` 200 from Railway (`69.46.46.101`); `www` answers 308; both certificates Let's Encrypt, valid to 2027-01-05 |
| Hashes | Computed with SHA-256 over the git-stored (LF) bytes |

## Verification still required

Every item still open in the 2026-10-12 record remains open. In addition,
Namecheap account MFA, the registrar transfer lock and DNS change history have
not been collected as evidence (matrix row: third-party evidence required).
