# Truenote contingency plan

**Status:** Draft for adoption. The recovery targets in section 3 were approved by the owner on 2026-10-10; every recovery time stays provisional until a timed test meets it (section 6). No contingency test has been run yet.
**Owner:** Truenote maintainer
**Related:** [`backup-restore-runbook.md`](./backup-restore-runbook.md) (cited below as the runbook; it holds every command), [`incident-response-plan.md`](./incident-response-plan.md), [`.claude/reference/deployment.md`](../../.claude/reference/deployment.md).
**Stage (owner statement, 2026-10-07):** pre-pilot. Production holds demo data only and no CSRs use it. This plan applies in full from the first real customer data. At that point, turn on Railway volume backups with `node scripts/railway-volume-backups.mjs --enable`; they stay off until then (owner decision, 2026-10-10), so scenario A falls back to the off-site copy and its 7-day RPO.

## 1. What must keep working

Truenote has one essential function: a CSR asks a question during a call and gets an answer with at least one citation, or a refusal. Everything else (uploads, admin pages, evaluation, email) can wait until that works again.

| Component | Needed for cited answers | Provider | If it is gone |
|---|---|---|---|
| `web` service (API and SPA) | Yes | Railway | Redeploy from GitHub with `Dockerfile.railway` (deployment.md, "Deploying") |
| `pgvector` database (documents, chunks, users, audit log) | Yes | Railway | Restore from a volume backup or the off-site copy (runbook, section 4) |
| Answer generation, embeddings, reranking | Yes | OpenRouter, OpenAI, Cohere | No fallback provider is configured. Answers stop until the provider returns or a replacement key or provider is set |
| `worker` service (ingestion, evaluation) | No | Railway | Uploads wait; existing answers keep working |
| Bucket `truenote-storage` (original files) | No | Railway (Tigris) | Rescans and re-ingests fail; existing answers keep working |
| Parsing of uploads | No | LandingAI | Uploads wait |
| Email (password reset, invitations) | No | Resend | Admins reset passwords from the Users page |
| DNS for `truenote.org` | Yes, for the custom domain | Name.com, edited through Replit's DNS screen | The Railway URL keeps working |
| Source code | For any rebuild | GitHub | Local clones, plus the code bundle in each off-site copy |
| Off-site copy | For recovery only | Backblaze B2, separate account | Railway volume backups still cover database failure |

Alternate storage site: the off-site copy is in B2 region `us-east-005`, in the same Virginia area as production (Railway `us-east4`, bucket region `iad`). A separate provider and account protect it from the loss of the Railway account or project, but not from a disaster affecting that whole region. The owner accepted this on 2026-10-10 rather than opening a second B2 account in a western region.

## 2. Roles

Truenote has one maintainer, who holds every role in this plan: decides to invoke it, runs every recovery step, and tells the customer. No alternate person is named. If the maintainer is unavailable, nobody can run a recovery; record this as an accepted risk until a second person is trained (section 6).

The customer security contact and program owners are listed in the incident response plan, section 2 (none yet; no customer contract).

## 3. Recovery targets

RPO is the most data that may be lost. RTO is the time from the decision to recover until a CSR gets a cited answer again. Approved by the owner on 2026-10-10, with a weekly off-site copy (owner decision, the same day).

| Scenario | Copy used | RPO | RTO |
|---|---|---|---|
| A. Database volume failure, corruption or a bad change | Railway daily volume backup (runbook path A); else the latest off-site copy (path C) | 24 hours | 8 hours (provisional) |
| B. Bucket loss (bucket deleted, many objects gone) | Railway's 52-hour bucket restore; else the latest off-site copy | 7 days | 1 business day (provisional) |
| C. Railway account or project loss | Off-site copy only; rebuild in a new Railway project in another region, or on another host | 7 days | 3 business days (provisional) |
| D. Single uploaded files deleted, overwritten or corrupt | Latest off-site copy that holds the file; else the program owner's original | 7 days | 2 business days (provisional) |
| E. Code repository loss | Local clones; else the code bundle in the latest off-site copy | Last push; at most 7 days for the bundle | 1 business day (provisional) |
| Secrets | Re-issue at each provider (runbook, section 7) | Not applicable | 4 hours (provisional) |

Scenarios B to D depend on the off-site copy, so a daily copy would bring their RPO to 24 hours. Changing the schedule is one setting on the `backup` service (runbook, section 1).

## 4. When to invoke

Invoke this plan when any of these happens, or when an outage is expected to last longer than the RTO of its scenario:

- the database will not start, reports corruption, or holds data damaged by a bad change or an attacker;
- the bucket or its files are missing;
- the Railway account or the `truenote` project is lost, locked or unusable;
- the GitHub repository or account is lost;
- an AI provider used for answers is down for longer than 8 hours.

When the cause may be an attack, open an incident first (incident response plan, section 5.1) and run recovery as its recovery step. Record the decision time in UTC; RTO is measured from it.

## 5. Steps

1. Record the decision time, the scenario, and the restore point you will use.
2. Tell the customer security contact that cited answers are down and when you expect them back.
3. Recover, by scenario:
   - **A:** runbook, section 4, path A (volume backup) or path C (off-site copy) with the incident cut-over in section 4.4.
   - **B and D:** runbook, section 6. Existing answers keep working, so this can follow normal business hours.
   - **C:** rebuild (runbook, section 4.7, with production values in place of test ones): a new Railway account or project in another region, a `pgvector` service from the image digest in `Dockerfile.backup`, the off-site copy restored with path C, a new bucket filled from it, secrets re-issued and set (runbook, section 7), `web` and `worker` deployed from GitHub, then DNS moved to the new service (deployment.md, "Cutover", lists the records). If Railway as a whole is unusable, the same steps run on any host that can run `Dockerfile.railway` and the `pgvector` image.
   - **E:** push a local clone, or the code bundle from the off-site copy, to a new GitHub repository; reconnect deploys.
   - **Provider outage:** wait for the provider; if it lasts longer than the RTO, set a replacement provider key only after checking that the replacement keeps the same data handling ([`third-party-responsibility-matrix.md`](../compliance/pci/third-party-responsibility-matrix.md)).
4. Run the checks in runbook section 5 and the smoke test in section 5.4 against the recovered service.
5. Record the end time, the measured RPO and RTO, and what went wrong, in the runbook's evidence table (section 9) and, for an incident, the incident record.
6. Reconstitute: confirm backups run again on the recovered service (runbook, section 8 weekly check), and update deployment.md with every changed identifier.

## 6. Testing, training and review

- **Once a year:** a full contingency test. Rebuild in a separate Railway project in another region from the off-site copy (scenario C), timed from decision to first cited answer, together with a tabletop exercise of the incident response plan (section 11 there). The restore test receipt goes in `docs/security/evidence/`.
- **Every 3 months:** the restore test in runbook section 8.
- **Training:** the maintainer walks through this plan and the runbook before the first test, and anyone who takes a role later does the same before holding it. Record the date and who took part in the test receipt.
- **Review:** after every test or real use, after a change of host, provider or database image, and at least once a year. Each review updates the RTO values from the latest measured times.

## 7. Contacts and provider dependencies

Provider security and support contacts are in the incident response plan, section 2. Added for recovery:

| Provider | Role in recovery | Contact |
|---|---|---|
| Railway | Hosts production; volume backups; restore-test projects | Pro plan support through Central Station (incident response plan, section 2) |
| Backblaze B2 | Holds the encrypted off-site copy in an account separate from Railway | [Backblaze support](https://help.backblaze.com/) |
| Name.com, through Replit's DNS screen | Holds the `truenote.org` DNS records | deployment.md, "Cutover" |
| GitHub | Source code and deploy source | incident response plan, section 2 |

The age private key that decrypts the off-site copy is held by the maintainer outside Railway and Backblaze (runbook, section 1). Without it, the off-site copy cannot be restored; losing it means scenario C has no recovery path until a new copy is made with a new key.
