# Repository verification record: 2026-10-14

**Evidence grade:** Local repository verification only
**Record coverage:** Two changes on 2026-10-14: the domain transfer to Namecheap (pull request #302), where TB-09 in the threat model names Namecheap as registrar and DNS host and gives Replit no production role; and the threat-model update for the compliance question-and-answer flow added by pull requests #298 to #301 (NIST SP 800-53 RA-3, POAM-2026-017)
**Worktree base:** `da0d400259ec160d59d46d51b5e1665af3f4ae1d` for #302 and `453352abfd6638bd3fbc17134de70a85a3c89f9c` for the compliance update (remote `main` when each branch was cut)

| Check | Result |
|---|---|
| Production verifier source identity | `production-control-verification.sql` SHA-256 `A6ECF082FD5F358A17F2A9CCCCD81495C28600A8699AABDFC2560732A9C77EC9`; unchanged since the 2026-10-12 record; source only, not an execution receipt |
| Threat-model source identity | `threat-model.md` SHA-256 `9B071A16A3F63B86B4D6C33AE7F19D904631E1FEBEB9F62C63B124853CAA6F4D`; includes both changes; engineering source only, not a signed review or risk acceptance |

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

From #302:

- Threat model: TB-09 names Namecheap as registrar and DNS host for
  `truenote.org` since 2026-10-14, and no longer names Replit for DNS editing.
  The threat count and the nine trust boundaries are unchanged.
- Third-party responsibility matrix: new Namecheap row; the temporary Replit row
  no longer claims a DNS role.
- Contingency plan: the DNS dependency and the provider contact list name
  Namecheap instead of Name.com through Replit's DNS screen.
- Production control verification SQL: unchanged; its hash is carried forward.

From the compliance threat-model update:

- Threat model: a new section describes the compliance question-and-answer flow
  (`POST /api/compliance/ask`). New trust boundary TB-10 and threats TN-TM-027
  to TN-TM-034 cover prompt injection through document text, disclosure to an
  unauthorized user, question or answer text in logs, provider retention, a
  misstated control, tampering in object storage, rate abuse and audit loss,
  each with the code that mitigates it. The threat count is now 34 with ten
  trust boundaries. The compliance documents are added to the primary assets,
  TN-TM-027 joins release blocker 5, and the review triggers name the compliance
  role, storage and providers.
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

For the compliance flow, the residual actions in TN-TM-027 to TN-TM-034 are open:
an injection test against the compliance corpus, a deployed access test and
super-user account review, a log canary and a forced audit-write failure,
provider retention evidence, a bucket credential review, a capacity test and a
spend alert. No compliance eval set exists, so the 0.5 rerank threshold is not
tuned against labeled questions.
