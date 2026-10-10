# Evidence harness

The evidence harness collects dated, tamper-evident proof that Truenote's security controls operate in production. Each check is mapped to NIST SP 800-53 Rev. 5 Moderate controls and to the SP 800-53A determination statements its result is evidence for. It answers the question a security reviewer asks after reading a control mapping: show me that it runs.

This is a self-assessment. Receipts are produced by the system under test and its operator, and independent assessment (CA-2(1)) is not met. Every receipt carries that statement.

Plan approved by the owner on 2026-10-10. The API contract for the gated compliance pages is in [evidence-api.md](evidence-api.md).

## How it works

1. The check catalog (`artifacts/api-server/src/lib/evidence/catalog.ts`) lists every check: the controls and 800-53A objectives it covers, how often it runs, and its exact pass condition. Objective labels are copied from NIST's OSCAL Moderate baseline (Rev. 5.2.0) into `nist-800-53r5-moderate.json` by `scripts/src/evidence-nist-ids.ts`, and a unit test rejects any label the baseline does not contain.
2. A daily pg-boss job in the `worker` service (`evidence-run`, 05:23 UTC) runs every automated check and appends one receipt per check. Each check has a time limit, 90 seconds or 380 seconds for a synthetic check, and one that runs out records `error`. The job expires after 90 minutes; a run in which all 23 checks hit their limits takes about 59 minutes (`artifacts/api-server/src/lib/evidence/queue.ts` has the arithmetic).
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
| Production behavior | worker, daily | Two synthetic CSR accounts and the published demo account over HTTPS, and the audit log | 2 |
| Operator check | owner, monthly | Owner-run script over `railway ssh` as the migration role | 3 |
| Attestations | owner, on reminder | Uploaded proof (screenshots, reports) | 3 |
| Monthly summary | worker, monthly | Receipts of the month and the chain head | 3 |

The catalog lists the checks built so far: 18 from phase 1 and 5 from phase 2. Phase 3 adds its own.

### Why the worker and not GitHub Actions

The repository is public, so Action logs and artifacts are public. GitHub posture results (open alert counts, which protections are off) are weakness details. Running the checks in the worker keeps them in the production database, readable only by a super_user, and keeps any production write credential out of GitHub. The only public part is the heartbeat and the passive public checks, which show nothing a visitor cannot already see.

### Known gaps

Some checks will fail on purpose during the demo phase. The result is always recorded as observed. A super_user can link a failing check to an accepted POA&M item in the private `evidence_known_gaps` table, with an optional expiry, through the admin API. A linked failure is reported as "known, tracked" instead of "new failure"; when the link expires, the owner gets an email. Links are never written to this repository, because the catalog is public and a list of expected failures would publish the weaknesses.

### Synthetic checks (phase 2)

Five daily checks (`artifacts/api-server/src/lib/evidence/checks/synthetic.ts`) log in to production over HTTPS the way a user does and probe the access controls. The catalog holds the exact pass conditions.

| Check | What a pass proves | What it does not prove |
|---|---|---|
| `synthetic.program-isolation` | csr-a, a CSR in synthetic program A, cannot get canary B from program B: asking with B's token returns no source with B's id, no source or answer text holding the token, and `GET /api/kb/documents/<B>` and `GET /api/sessions/<csr-b's session>` answer 404. | Isolation for any other query, document, route or program pair. |
| `synthetic.classification-ceiling` | csr-a, cleared to `internal`, cannot get the `confidential` canary in its own program, by question or by `GET /api/kb/documents/<id>` (404). | Any other clearance level. |
| `synthetic.demo-write-block` | The published demo account with role manager gets 403 `demo_account` from `POST /api/documents/upload`. With no demo accounts published (`GET /api/config`), it passes with nothing to block. | Other write routes; they use the same middleware but are not probed. |
| `synthetic.bad-password-refused` | csr-a logs in with its right password (200, then logout), and then one login for csr-a with a random wrong password answers 401. If the right password does not get 200, the check records `error`: a server refusing every csr-a login would otherwise pass. | Account lockout or throttling after repeated failures (AC-7): it sends one wrong password per run, and the lock needs 5 consecutive failures by default (a success resets the count), so it is not lockout evidence. Nor password rules (IA-5(1)) or multi-factor authentication. |
| `synthetic.login-windows` | Every login and login attempt by a synthetic user (a current user with `is_synthetic`, or an actor email ending in `.invalid` in any letter case, so a synthetic user deleted since still counts) in the last 8 days recorded under `auth.local.login`, `auth.break_glass.login` or `auth.oidc.login` in `security_events`, whatever its outcome, falls inside a synthetic check's run, from its start minus 2 minutes to its finish plus 2 minutes, as recorded on its receipt. Refused attempts count (outcome `denied`, such as a refusal by `LOCAL_LOGIN_MODE` or an account lock), so a refused attempt with a synthetic account outside a run is flagged too. An event outside every window fails and is listed with its outcome. | That an event inside a window came from the harness; someone using the synthetic credentials during a run looks the same. A plain wrong password records no login event, so it is not counted. |

Every refusal is paired with a positive control in the same run: csr-b must get canary B by question, and csr-a must get canary A by question and by id, before a refusal counts. A refusal caused by low retrieval confidence would otherwise pass. Before their HTTPS probes, the isolation and classification checks read the database to confirm the canaries are live in the expected synthetic programs and the users are synthetic, in those programs, with the expected clearance. A failed login, a missed positive control, an unexpected status or a mismatched setup records `error`, not `pass` or `fail`. Receipts record emails, document ids, status codes and the names of response fields that held a canary; passwords and canary tokens are never recorded. Every session a check opens is logged out, also after its time limit ran out. A failed logout (non-2xx or no response) is retried once; one still failed after its retry turns a `pass` into `error`, leaves a `fail` a `fail` (a cleanup problem never hides a leak), and is listed in the receipt without the cookie.

`synthetic.login-windows` reads only the database and runs without any configuration. The other four record `error` ("Not configured") until `EVIDENCE_SYNTHETIC_ACCOUNTS` is set.

### Synthetic accounts and canaries

`scripts/src/evidence-synthetic-provision.ts` creates them, connected as the migration role through the SSH tunnel to `pgvector`:

- Programs `zz-synthetic-a` and `zz-synthetic-b`, both synthetic.
- Users `csr-a@synthetic.truenote.invalid` in `zz-synthetic-a` and `csr-b@synthetic.truenote.invalid` in `zz-synthetic-b`: role `csr`, `max_classification` `internal`, active, no forced password reset, each with a random 43-character password. They are created in SQL because only the migration role may insert synthetic rows and no API sets `max_classification`.
- Canary documents "Synthetic canary A" (`internal`) and "Synthetic canary A confidential" (`confidential`) in `zz-synthetic-a`, and "Synthetic canary B" (`internal`) in `zz-synthetic-b`. Each holds one random token (`zzcanary` and 16 hex digits) and no customer data. The agent super_user (deployment.md, "Agent account") uploads them through `POST /api/documents/upload`, so they go through the real ingestion path; the script waits until each is active.

Without `--apply` the script is a dry run: one read-only transaction, no login, no file. With `--apply` it writes the programs and users in one transaction with an `evidence.synthetic.provisioned` security event and prints what it created or changed only after the commit; a failure before the commit prints that the transaction was rolled back and nothing was changed. It then saves the passwords and tokens to `~/.claude/secrets/truenote-synthetic-accounts.json` (override with `EVIDENCE_PROVISION_OUT`) right after the commit, then uploads the canaries and completes the file. That file is the value of `EVIDENCE_SYNTHETIC_ACCOUNTS`. It never prints a password, token or connection string. A rerun reuses what exists: users keep their passwords (which must be in the file and match), active canaries with the ids in the file are not uploaded again. `--apply --rotate-passwords` gives both users new passwords and, in the same transaction, deletes their sessions and unconsumed MFA challenges, as the admin password reset does, so nothing opened with an old password stays usable; other users' sessions are untouched. Set the variable again afterwards. Other inputs: `EVIDENCE_PROVISION_BASE_URL` (default `https://truenote.org`) and `EVIDENCE_PROVISION_AGENT_FILE` (default `~/.claude/secrets/truenote-agent.json`).

### Database fence

`lib/db/sql/0019_synthetic_fence.sql` adds `is_synthetic` to `programs` and `users` (false for every existing row) and keeps synthetic and real data apart in the database, whatever the application does:

- A user's `is_synthetic` must equal its program's (composite foreign key `users_program_synthetic_fkey` on `(program_id, is_synthetic)`), so a synthetic user cannot sit in a real program or a real user in a synthetic one.
- A super_user is never synthetic (`users_synthetic_not_super_user_check`).
- Synthetic emails end in `.invalid` (RFC 2606, never deliverable) and real emails must not (`users_synthetic_email_check`).
- `is_synthetic` never changes after insert, for any role, and only the tables' owner, the migration role, can insert a synthetic row (trigger function `block_synthetic_flag_change`). `truenote_app` still creates real programs and users and updates synthetic users' login fields.

The application checks the email rule first: creating a user (`POST /api/admin/users`) or importing users (`POST /api/admin/users/bulk`) with an email ending in `.invalid` answers 400.

### Synthetic programs in admin views

A super_user's all-program views leave synthetic programs out: the query log with no program selected (`GET /api/admin/queries`) and the cross-program pipeline telemetry (`GET /api/admin/observability`). In the query log, selecting a synthetic program still shows its rows; `GET /api/admin/observability` always leaves synthetic programs out, whatever program is selected. Program-scoped views (insights, evaluations, documents) show a synthetic program's data only when it is selected. The program and user lists (`GET /api/admin/programs`, `GET /api/admin/users`) include synthetic rows and mark them with `isSynthetic: true`.

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
| `EVIDENCE_SYNTHETIC_ACCOUNTS` | worker | JSON written by the provisioning script: `{"csrA":{"email","password"},"csrB":{"email","password"},"canaries":{"a":{"documentId","token"},"b":{...},"aConfidential":{...}}}`. Both emails must end in `.invalid` and differ, so the harness can never log in as a real person; the three canaries need distinct UUID document ids and distinct tokens. Holds passwords: set it from the file over stdin, never on a command line. Missing or invalid, the four account checks record `error` ("Not configured"), and the error never quotes the value. |
| `EVIDENCE_SYNTHETIC_BASE_URL` | worker | Optional; defaults to `https://truenote.org`. Where the synthetic checks send their requests; http or https. |
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

## Turning on phase 2

Each step changes production and waits for the owner's go, in this order. Run the local steps from a checkout of the `main` commit being deployed.

1. Apply the fence. First count the users whose email ends in `.invalid`; the count must be 0, or `users_synthetic_email_check` fails and the file rolls back:

   ```text
   railway ssh -p 2aa5cb01-5438-4fbd-aade-626d4e252977 -e b35c4090-cbcd-4deb-9434-e9b63a309bd9 -s pgvector -- psql -h localhost -p 5432 -U postgres -d railway -X -At -c "'SELECT count(*) FROM users WHERE lower(email) LIKE '\''%.invalid'\'''"
   ```

   The SQL is quoted twice because `railway ssh` hands the words to a remote shell (`.claude/reference/pitfalls.md`). Then `node scripts/railway-apply-sql.mjs lib/db/sql/0019_synthetic_fence.sql` (dry run), and with `--apply`.
2. Rerun `pnpm --filter @workspace/scripts run pgboss:install` as the migration role through the SSH tunnel (`.claude/reference/deployment.md`, "Database roles"). It writes the evidence queue's new expiry over the stored one and prints `evidence-run: retryLimit 1, retryDelay 600, expireInSeconds 5400`. Until then a run longer than 30 minutes is marked failed and retried.
3. Deploy web and worker from the same commit through the "Deploy production" workflow: `gh workflow run deploy-production.yml --repo ryanportfolio/Truenote --ref main -f message="<what ships>" -f service=both`, then approve the job. A daily run between this deploy and step 5 records `error` ("Not configured") for the four account checks; a second one in a row emails the owner.
4. Provision the accounts and canaries through the SSH tunnel, first as a dry run, then with `--apply`:

   ```text
   DATABASE_URL=postgresql://postgres@127.0.0.1:5434/railway pnpm --filter @workspace/scripts run evidence:synthetic-provision
   DATABASE_URL=postgresql://postgres@127.0.0.1:5434/railway pnpm --filter @workspace/scripts run evidence:synthetic-provision -- --apply
   ```

   It needs the agent's credentials in `~/.claude/secrets/truenote-agent.json` and writes `~/.claude/secrets/truenote-synthetic-accounts.json`.
5. Set `EVIDENCE_SYNTHETIC_ACCOUNTS` on the worker from that file over stdin, so the value never appears on a command line or in the terminal. Without `--skip-deploys` this redeploys the worker, which then reads the value.

   ```text
   Get-Content -Raw "$HOME\.claude\secrets\truenote-synthetic-accounts.json" | railway variable set EVIDENCE_SYNTHETIC_ACCOUNTS --stdin -p 2aa5cb01-5438-4fbd-aade-626d4e252977 -e b35c4090-cbcd-4deb-9434-e9b63a309bd9 -s worker
   ```

   In Git Bash, redirect the file instead: `railway variable set EVIDENCE_SYNTHETIC_ACCOUNTS --stdin ... -s worker < ~/.claude/secrets/truenote-synthetic-accounts.json`.
6. Once the worker is back, trigger a run of the five checks as a super_user: `POST /api/admin/evidence/runs` with `{"checkIds":["synthetic.program-isolation","synthetic.classification-ceiling","synthetic.demo-write-block","synthetic.bad-password-refused","synthetic.login-windows"]}`. Check the five new receipts (`GET /api/admin/evidence/receipts`): each has a result and a `release.commit`, an `error` names its cause, no receipt holds a password or canary token, and `synthetic.login-windows` passes: no synthetic login or login attempt was recorded outside a check's run, provisioning included. List `synthetic.login-windows` last, as above, so it sees the windows of the other four.

### Known risk: local login restrictions

The synthetic checks log in with a password, and the local password login follows `LOCAL_LOGIN_MODE` (`getOidcConfig()` in `artifacts/api-server/src/lib/auth/oidc.ts`, `isLocalLoginAllowed()` in `lib/auth/local-login-policy.ts`; PR #226, merged, applies the same rule to password login, reset-link completion and session lookup):

| Mode | Roles that keep local login |
|---|---|
| `enabled` | every role |
| `break_glass` | `super_user` only (the emergency account, which also needs a passkey) |
| `disabled` | none |

A valid value in `LOCAL_LOGIN_MODE` always applies. Unset, empty or whitespace only (the value is trimmed, and an empty result counts as unset), the mode follows the SSO variables: with none of `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` or `OIDC_STATE_SECRET` set it is `enabled`; with SSO fully configured (valid issuer and redirect URLs, client id and secret, a state secret of at least 32 characters, at least one program in `OIDC_ALLOWED_PROGRAM_IDS`, and for a Microsoft Entra issuer a matching `OIDC_TENANT_ID`) it is `break_glass`; with SSO partly configured, or any other non-empty value in `LOCAL_LOGIN_MODE` (a typo, for example), it is `disabled`.

So turning on SSO, fully or partly, without setting `LOCAL_LOGIN_MODE=enabled` stops the synthetic CSR logins: `POST /api/auth/login` answers 401 for csr-a, csr-b and the demo manager, whatever the password. The isolation, classification and demo-write-block checks then record `error`, and so does the bad-password check, whose positive control (csr-a's login with the right password) fails first. The owner must decide on an exemption for the synthetic accounts, or another way for the checks to sign in, before enabling SSO.

## Status

Phase 1 runs in production since 2026-10-10: `0012_evidence_receipts.sql` applied at 05:07 UTC, `evidence-run` queue created, web and worker deployed from `0e2035df`. The first run (05:11 UTC) wrote 18 receipts, each naming that commit: 12 pass, the CAA check fails (linked to its POA&M item until the record is added after the domain transfer), and the five GitHub checks record `error` until `EVIDENCE_GITHUB_TOKEN` is set. Both chains verified (801 security events) and FreeTSA's token verified to its pinned root. The watch Action is on (`EVIDENCE_WATCH_ENABLED=true`) and its first run passed.

Phase 2 is built and not yet on: `0019_synthetic_fence.sql` is not applied, the stored `evidence-run` expiry is still 30 minutes, no synthetic account or canary exists, `EVIDENCE_SYNTHETIC_ACCOUNTS` is not set, and the deployed code has none of the five synthetic checks. "Turning on phase 2" lists the steps.

## Limits

- Self-assessment; see the statement at the top.
- The database checks run as the role they check. Refusals by the owner role are proven only by the monthly operator check.
- Anyone with the database owner role can rewrite the chain consistently. The daily timestamp, the monthly summary held by the reviewer and the monthly export to the private repository make that detectable after the fact; they do not prevent it.
- The worker's public-site checks start inside Railway's network. The watch Action repeats them from GitHub's network, but its results stay in Action logs, not receipts.
- A pass shows the control was in place when the check ran, not between runs.
- The synthetic checks probe one pair of synthetic programs, one clearance level and one write route, with one canary per probe. They show the controls held for those requests, not for every user, document or route.
