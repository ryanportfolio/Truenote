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
| Operator check | owner, monthly | Owner-run script through the SSH tunnel to `pgvector` as the migration role | 3 |
| Attestations | owner, on reminder | Uploaded proof (screenshots, reports) | 3 |
| Monthly summary | worker, first run of each month | Receipts of the month and the chain head | 3 |

The catalog lists 29 checks: 18 from phase 1, 5 from phase 2 and 6 from phase 3 (four attestations, the operator check and the monthly summary). The worker runs the 23 automated ones; the phase 3 checks have no runner.

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

Catalog entry `operator.monthly-verification`. The application role cannot show that the append-only triggers also refuse the owner, so once a month the owner runs `scripts/src/evidence-operator.ts` (`pnpm --filter @workspace/scripts run evidence:operator`) on their own machine. It connects through the SSH tunnel to `pgvector` (`docs/security/backup-restore-runbook.md`, section 4.4, step 5) as the migration role, with `DATABASE_URL=postgresql://postgres@127.0.0.1:5434/railway`, and does everything over that one connection:

1. Role check. It stops unless the session user is a superuser or a member of the owner of `evidence_receipts`.
2. Verifier. It sets `truenote.evidence_runtime_role` to the runtime role (`truenote_app`; `--runtime-role <role>` overrides it) and runs `docs/compliance/pci/production-control-verification.sql` as a whole; the file opens and commits its own READ ONLY transaction. The receipt records the controls that failed and the sha256 of each object definition the verifier returns, not the definitions, plus the sha256 of the verifier file (line ends as Git stores them) and the commit the script ran from (`+dirty` when its files have local changes).
3. Negative tests. In one transaction that always ends in ROLLBACK (lock timeout 5 s, statement timeout 30 s), an UPDATE and a DELETE aimed at the newest row and a TRUNCATE run on `evidence_receipts` and on `security_events`, each in its own savepoint: six statements. A statement counts as refused only when it fails with SQLSTATE P0001 and a message ending in "is append-only", the error the triggers of `0008` and `0012` raise. Any other error is recorded with its SQLSTATE and message as not refused. On an empty table the UPDATE and DELETE have no row to aim at and count as not refused. A lock or statement timeout stops the run without a receipt. After the rollback, the rows that existed before the tests must be unchanged (their count and the newest row's hash), else the run stops without a receipt; rows the application appended meanwhile are allowed and reported.
4. Receipt. The result is `pass` only when the verifier returned at least one control, every control passed, and all six statements were refused. Without `--apply` the script prints the payload and appends nothing. With `--apply` it appends the receipt through `append_evidence_receipt` and prints its id, sequence and hash. `lib/db/sql/0020_operator_receipts.sql` makes that function refuse a payload of kind `operator` (compared case-insensitively) unless the session user is a member of the function's owner, the migration role, so `truenote_app` cannot append an operator receipt.
5. Export, with `--export-dir <path>`, with or without `--apply`. It only reads the database. The month is `--month YYYY-MM` or, by default, the previous UTC month (`--month` and `--push` need `--export-dir`). The month is a contiguous sequence range: from the first receipt recorded at or after the month's UTC start to the first recorded at or after the next month's start, exclusive (the head plus one when there is none). `append_evidence_receipt` reads the clock before it takes the chain lock, so recorded times near a month boundary can run against sequence order; the range still puts every receipt in exactly one month. In one REPEATABLE READ snapshot the script reads the range, the receipt before it and every later receipt, and before writing anything it recomputes the chain from the receipt before the range through the chain head (each `payload_sha256`, `receipt_hash` and `previous_hash` link), an empty month included. A mismatch writes nothing and names the first bad sequence. Then `<path>/<YYYY-MM>/` gets three files:
   - `receipts.jsonl`: one line per receipt of the month with its sequence, id, `recorded_at_text`, check id, kind, result, the exact payload text, `payload_sha256`, `previous_hash` and `receipt_hash`, so anyone can recompute the hashes.
   - `attachments.json`: key, sha256, size and content type of every attachment those receipts name. The files stay in the bucket.
   - `chain-head.json`: the month, the sequence range, the number of receipts exported, and the chain head at export time (sequence, `receipt_hash`, recorded time).

   No file holds the export time, so the same chain state gives the same bytes and an unchanged re-export makes no commit.

The export target is checked before the database is touched. A directory outside every Git work tree gets the files and no commit, and `--push` is refused there. The only Git target allowed is the top level of a repository whose `origin` URL ends in `truenote-evidence` (or `truenote-evidence.git`) and which is not the Truenote code repository the script runs from or one of its worktrees. There the script commits the month folder ("Evidence export for <month>", with the range and chain head in the body), and with `--push` runs `git push origin HEAD`. Any other target is refused and nothing is written. A failed commit unstages the month folder and leaves its files in the working tree. The script does not check the repository's ruleset; the owner sets it up once ("Turning on phase 3").

The operator receipt appended by an `--apply` run belongs to the current month, so the export of the previous month does not contain it; the next month's export does. The script exits non-zero on any error and never prints `DATABASE_URL`, its password, or credentials embedded in a URL (`https://user:token@host/...`), also when it shows git's error output.

### Attestations and monthly summary (phase 3)

Attestations are proof the owner supplies; the harness never runs them (`artifacts/api-server/src/lib/evidence/attestations.ts`). The catalog holds four, with proposed cadences:

| Check | Cadence | What the owner uploads |
|---|---|---|
| `attestation.operator-mfa` | quarterly | Screenshots or reports of the MFA settings of every operator account (hosting, source control and CI, identity provider, DNS, the alert mailbox) |
| `attestation.workstation-patch-malware` | monthly | OS update status and anti-malware status of each admin workstation |
| `attestation.access-review` | quarterly | The account and privilege review record, each account marked kept, changed or removed |
| `attestation.policy-review` | annual | The review record of the security policies, the system security plan, the incident response plan and the contingency plan |

A check is due when it was never attested or its latest `pass` receipt is at least 31 (monthly), 92 (quarterly) or 366 (annual) days old. After its alert email, every evidence run (daily or manual, `POST /api/admin/evidence/runs`) adds one "Attestation due" line per due check whose current due period was not reminded yet (remembered in `app_settings`, key `evidence_attestation_reminders`) to the pending evidence alert lines and sends them to the alert recipients. A failed send leaves the lines pending for the next run. A check attested since drops out and is reminded again when its next period starts.

Upload: `POST /api/admin/evidence/attestations/:checkId` as a super_user, multipart, with up to 10 files of at most 20 MiB each in the field `files` and a `statement` of 1 to 2,000 characters saying what the files show ([evidence-api.md](evidence-api.md) has the status codes). Accepted: `.png` sent as `image/png`, `.jpg` or `.jpeg` as `image/jpeg`, `.pdf` as `application/pdf`, `.txt` as `text/plain` and `.csv` as `text/csv`. The declared type must match the extension, an empty file is refused, and a PNG, JPEG or PDF must start with that format's magic bytes; text files get no content check. Every file is checked before anything is stored. Each file then goes to the bucket under `evidence/attestations/<checkId>/<uuid>/<i>-<sha16><ext>` (one uuid per upload, `i` the file's position, `sha16` the first 16 hex digits of its sha256). One transaction appends a receipt of kind `attestation` with result `pass` (the statement, the uploader's id and email, the cleaned file names, and per file its key, sha256, size and type) and the security event `evidence.attestation.recorded`. If a step after the first stored file fails, the stored objects are deleted, best effort.

Download: `GET /api/admin/evidence/receipts/:id/attachments/:index` reads the file, recomputes its sha256 and serves it only when it matches the receipt. A file that is missing or does not match answers 409, nothing is served, and the security event `evidence.attestation.attachment_check` records outcome `failure` with the expected and actual sha256.

Monthly summary (`artifacts/api-server/src/lib/evidence/summary.ts`, catalog entry `summary.monthly`). There is no monthly queue: every evidence run, daily or manual, ends by calling `ensureMonthlySummaries`, so the first run of a UTC month appends one receipt of kind `summary` for the previous calendar month. It records, for every other catalog check, its pass, fail and error counts over the month and its latest result in the month; for every control, its checks counted by latest result; the checks whose latest result is `fail` or `error`; the known-gap links active on the day it is built; each attestation check's latest pass and whether it was due at the month's end; and the chain head the summary is appended after (sequence, `receipt_hash`, recorded time). The summary is built under the chain lock, so that head is the summary's `previous_hash`. `GET /api/admin/evidence/summaries` lists the summaries.

Months without a summary after the newest one, up to the previous month, are appended oldest first, at most the three most recent of them, so a month in which no daily run happened still gets its summary; with no summary yet, only the previous month is appended. A month never gets a second summary receipt. Every run then emails the summaries of the previous month and the two before it to each configured recipient (`EVIDENCE_ALERT_EMAIL`, else `SECURITY_ALERT_EMAIL`, compared trimmed and lowercased) that has no send record for that month, one recipient at a time, each send within 30 s. Send records are per recipient, in `app_settings` under `evidence_summary_email_<YYYY-MM>` (`{ "receiptId": ..., "sentTo": { "<address>": "<time>" } }`). A failed send, or a sent email whose record could not be written, goes to the error log and stays pending, so the next run sends it to that recipient again. With no recipient configured, the emails stay pending and the error log gets one entry per run while a summary is pending. The owner forwards the email to the customer's security reviewer; the reviewer's copy anchors the chain head outside the owner's control.

Known limits:

- Upload files are held in memory while the request is parsed: up to 10 files of 20 MiB each per request.
- If storing or appending fails and the cleanup delete then fails too, the objects stay in the bucket without a receipt, and nothing reports it.
- A `.csv` file must be declared `text/csv`; a client that labels it with another type gets 400.
- A summary send that completes after its 30 s deadline counts as failed and is sent again, so that recipient can get two copies.
- The summary has no guard of its own against two concurrent calls. Its only caller runs under the daily run's try-lock (`truenote.evidence.run`). Two concurrent calls would still append one receipt per month, because the check for an existing summary runs under the chain lock, but could send the same email twice.

## Cadence

All cadences are proposals until the owner approves the organization-defined parameter values (`cadenceStatus: "proposed"` in the catalog). Automated checks run daily. The remediation window used by the open-alerts check (30 days for critical and high) is also a proposed value.

## Configuration

| Variable | Service | Purpose |
|---|---|---|
| `EVIDENCE_GITHUB_TOKEN` | worker | Fine-grained token, Truenote repository only, read-only: Administration, Actions, Code scanning alerts, Dependabot alerts, Secret scanning alerts, Metadata. Maximum one-year expiry; the `github.credential-expiry` check fails 30 days before. |
| `EVIDENCE_ALERT_EMAIL` | worker | Optional, comma-separated. Where evidence alerts, attestation reminders and monthly summaries go; defaults to the security monitor's `SECURITY_ALERT_EMAIL` (`docs/security/monitoring.md`). With neither set, alerts stay pending. |
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

## Turning on phase 3

Each step changes production or the owner's accounts and waits for the owner's go, in this order. Run the local steps from a checkout of the `main` commit being deployed.

1. Apply the operator rule: `node scripts/railway-apply-sql.mjs lib/db/sql/0020_operator_receipts.sql` (dry run), then with `--apply`. Afterwards check the definition in the database: `pg_get_functiondef('public.append_evidence_receipt(text)'::regprocedure)` must contain the `operator` rule, and the function must still be owned by the migration role and executable by `truenote_app`.
2. Deploy web and worker from the same commit through the "Deploy production" workflow (`gh workflow run deploy-production.yml --repo ryanportfolio/Truenote --ref main -f message="<what ships>" -f service=both`, then approve the job). If phase 2's deploy (step 3 there) has not run yet, this one deploy ships both.
3. Confirm that `EVIDENCE_ALERT_EMAIL`, or else `SECURITY_ALERT_EMAIL`, is set on `worker`. The attestation reminders and the monthly summary go there; with neither set they stay pending.
4. Create the private repository `ryanportfolio/truenote-evidence` with a ruleset on its default branch that blocks force-push and deletion, and clone it to the owner's machine, outside the Truenote checkout.
5. Each month: open the SSH tunnel to `pgvector` on port 5434 (`docs/security/backup-restore-runbook.md`, section 4.4, step 5) and run the operator script as `postgres`, first as a dry run, then with `--apply`, then the export with `--push` (the month defaults to the previous UTC month):

   ```text
   DATABASE_URL=postgresql://postgres@127.0.0.1:5434/railway pnpm --filter @workspace/scripts run evidence:operator
   DATABASE_URL=postgresql://postgres@127.0.0.1:5434/railway pnpm --filter @workspace/scripts run evidence:operator -- --apply
   DATABASE_URL=postgresql://postgres@127.0.0.1:5434/railway pnpm --filter @workspace/scripts run evidence:operator -- --export-dir <clone> --push
   ```

   The export run repeats the verifier and the negative tests as a dry run and appends no second receipt.
6. Upload the first attestations, one request per check: `POST /api/admin/evidence/attestations/:checkId` as a super_user, with the files and the statement ("Attestations and monthly summary (phase 3)").

## Status

Phase 1 runs in production since 2026-10-10: `0012_evidence_receipts.sql` applied at 05:07 UTC, `evidence-run` queue created, web and worker deployed from `0e2035df`. The first run (05:11 UTC) wrote 18 receipts, each naming that commit: 12 pass, the CAA check fails (linked to its POA&M item until the record is added after the domain transfer), and the five GitHub checks record `error` until `EVIDENCE_GITHUB_TOKEN` is set. Both chains verified (801 security events) and FreeTSA's token verified to its pinned root. The watch Action is on (`EVIDENCE_WATCH_ENABLED=true`) and its first run passed.

Phase 2 is built and partly on. Steps 1 and 2 of "Turning on phase 2" are done: `0019_synthetic_fence.sql` was applied on 2026-10-10 at 17:53 UTC (`schema_migrations` sha256 `d456fab7b42fa96e56ca98c690292d3253b4840c9f7e5f20fe0a6f7cc7bdb216`), and `pgboss:install` ran again the same day and raised the stored `evidence-run` expiry to 5400 s. Still pending: the deploy (the deployed code has none of the five synthetic checks), the synthetic accounts and canaries, and `EVIDENCE_SYNTHETIC_ACCOUNTS`.

Phase 3 is built and not yet on: `0020_operator_receipts.sql` is not applied, the deployed code has no attestation routes, reminders or monthly summary, the repository `ryanportfolio/truenote-evidence` does not exist, and no operator run, attestation or summary has been recorded. "Turning on phase 3" lists the steps.

## Limits

- Self-assessment; see the statement at the top.
- The database checks run as the role they check. Refusals by the owner role are proven only by the monthly operator check.
- Anyone with the database owner role can rewrite the chain consistently. The daily timestamp, the monthly summary held by the reviewer and the monthly export to the private repository make that detectable after the fact; they do not prevent it.
- The worker's public-site checks start inside Railway's network. The watch Action repeats them from GitHub's network, but its results stay in Action logs, not receipts.
- A pass shows the control was in place when the check ran, not between runs.
- The synthetic checks probe one pair of synthetic programs, one clearance level and one write route, with one canary per probe. They show the controls held for those requests, not for every user, document or route.
