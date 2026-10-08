# Truenote incident response plan

**Status:** Proposed. Not yet exercised. Items marked `[CONFIRM: ...]` need an owner decision or a contract check before this plan is relied on.
**Owner:** Truenote maintainer (incident lead)
**Review:** After every SEV-1 or SEV-2 incident, after every tabletop exercise, and at least once a year.

## 1. Scope

This plan covers security and data incidents in the Truenote application and the services it runs on. Production runs on Railway, project `truenote`, environment `production` ([`.claude/reference/deployment.md`](../../.claude/reference/deployment.md), cited below as deployment.md):

- the `web` service (API server and the built React app) and the `worker` service (ingestion and evaluation jobs);
- the `pgvector` database service and its volume `pgvector-volume`, which hold every database row, and the bucket `truenote-storage`, which holds uploaded source files;
- the Railway service variables that hold provider keys and other settings, and the Railway account and CLI logins that can change any of the above;
- the outside services Truenote sends data to: OpenRouter (answer generation), OpenAI (embeddings), Cohere (reranking), LandingAI (document parsing), Resend (email), and, when configured, the organization's OIDC provider, a malware scanner, and a SIEM webhook;
- the GitHub repository, its Actions workflows, and its security alerts.

`truenote.org` and `www.truenote.org` point at Railway since the owner switched DNS on 2026-10-07 (deployment.md, "Cutover"). The old Replit deployment stays deployed only as the DNS rollback target. This plan covers the Railway deployment at `truenote.org` and at its Railway URL.

It does not cover the customer's own call-center systems, the customer's identity provider, or the providers' internal operations. When a provider reports a breach, this plan covers Truenote's response to that notice.

An **incident** is any event that has exposed, or may have exposed, customer data to someone not authorized to see it; that has changed customer data or answers without authorization; or that has stopped CSRs from getting cited answers. A suspected incident is handled as an incident until the incident lead closes it.

## 2. Roles and contacts

Truenote has one maintainer. That person holds every Truenote role below and must be able to run each step alone.

| Role | Who | Responsibilities |
|---|---|---|
| Incident lead | Truenote maintainer | Declares the incident and its severity, contains it, keeps the timeline, sends customer notices, runs the retrospective. |
| Customer security contact | `[CONFIRM: name, email, phone, and backup contact from the customer contract]` | Receives notices, confirms customer-side actions such as SSO account disablement, agrees on public statements. |
| Customer program owners | `[CONFIRM: per-program contact list]` | Confirm which documents are wrong or exposed and which CSRs to notify. |
| Backup decision maker | `[CONFIRM: who can act if the maintainer is unreachable for more than 24 hours, and whether that person has access to the Railway project]` | Can stop the Railway services and can receive provider notices. |

Provider contacts. Keep the current support or security contact for each service in the restricted contact sheet, not in this repository.

| Provider | What Truenote sends or stores there | Contact |
|---|---|---|
| Railway (hosting, service variables, `pgvector` database and volume, bucket) | Application code and images, every variable value, all database rows, uploaded files. Railway Buckets run on Tigris servers ([Railway: storage buckets](https://docs.railway.com/guides/storage-buckets), accessed 2026-10-07). | `[CONFIRM: Railway support and security contact, and the support level on Truenote's plan]` |
| OpenRouter | Questions and retrieved excerpts for answer generation | `[CONFIRM: security contact]` |
| OpenAI | Chunk and question text for embeddings | `[CONFIRM: security contact]` |
| Cohere | Question and candidate chunk text for reranking | `[CONFIRM: security contact]` |
| LandingAI | Uploaded PDF and image bytes for parsing | `[CONFIRM: security contact]` |
| Resend | Email addresses and password-reset links | `[CONFIRM: security contact]` |
| Malware scanner and SIEM receiver (not configured on Railway today, deployment.md) | File bytes (scanner); security events (SIEM) | `[CONFIRM: customer or vendor contact for each, once configured]` |
| GitHub | Source code, Actions logs, security alerts | GitHub Support `[CONFIRM: account recovery path]` |

`[CONFIRM: which mailbox receives provider security notices, and that the maintainer checks it daily]`

## 3. Severity levels

Pick the highest level that fits. Raise the level when new facts arrive; lower it only after the facts support it. The response times are proposed targets for one maintainer.

| Level | Meaning | Examples for Truenote | Start response within | Customer notice |
|---|---|---|---|---|
| SEV-1 | Customer data exposed or changed, or the product's safety rails broken | A CSR in one program receives an answer, citation, or preview from another program's documents. A production database connection string, the bucket credentials, a Railway login or token, or the OpenRouter or OpenAI key is leaked and used. A super-user account is taken over. A file flagged as malware reaches the active state and is cited. A provider's breach notice says Truenote data was accessed. | 1 hour | Yes (section 7) |
| SEV-2 | High risk of exposure, or wrong answers at scale | A provider key or the SIEM signing key appears in a public place with no sign of use yet. A manager or CSR account is taken over. Many answers ship without citations, cite the wrong document, or state facts the excerpts do not support, for example after a model-route change or a bad document upload. A provider breach notice that may include Truenote data. | 4 hours | Yes if customer data may be involved |
| SEV-3 | A control worked but needs follow-up, or limited impact | The scanner quarantined a malware upload. Security events are piling up in SIEM dead-letter. A spike in rate-limited or denied requests. A high-severity Dependabot or CodeQL alert with no sign of exploitation. One reported wrong answer. | 1 business day | No, unless it escalates |
| SEV-4 | No customer impact | A low-severity scanner finding, a failed login burst from one address, a private vulnerability report that does not reproduce. | 5 business days | No |

## 4. Detection sources

These sources exist in the code, on Railway, or in the repository's GitHub setup today.

**Security events (hash-chained audit log).** The `security_events` table is append-only; each row stores the SHA-256 hash of the previous row. Events written today include:

- `http.security_mutation` for every non-read request that Express routes under `/api/admin`, `/api/documents`, and `/api/auth`, matched without regard to letter case and including absolute-form request targets, with outcome `success`, `denied` (4xx), or `failure` (5xx), the actor, source IP, and request id;
- `auth.local.login`, `auth.break_glass.login` (super-user password login while SSO is on), and `auth.oidc.login`;
- `workload.rate_limited` (uploads, rescans, evaluation runs, bulk imports, user administration, password changes) and `ask.rate_limited`;
- `ask.sensitive_input_blocked` when a question contains data the input policy blocks;
- `document.lifecycle.<state>` on every document version state change, including `quarantined`, `active`, and `revoked`;
- `document.purge`, `security.malware_scanning.enabled` and `security.malware_scanning.disabled`, and `error_log.clear`.

Useful starting queries, run read-only in a production psql session (open it as described in the "Shells" section of [`backup-restore-runbook.md`](./backup-restore-runbook.md): `railway ssh -s pgvector`, then `psql -h localhost -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X` inside the container):

```sql
-- Denied or failed security-relevant requests in the last 24 hours, by route and source IP
SELECT resource_id, source_ip, outcome, count(*)
FROM security_events
WHERE occurred_at > now() - interval '24 hours'
  AND outcome <> 'success'
GROUP BY 1, 2, 3
ORDER BY count(*) DESC;
```

```sql
-- Answers that cited a chunk from a different program than the one asked in (cross-program check)
SELECT ql.id, ql.created_at, ql.program_id AS asked_in, c.program_id AS cited_from
FROM query_log ql
CROSS JOIN LATERAL unnest(ql.cited_chunk_ids) AS cited(chunk_id)
JOIN chunks c ON c.id = cited.chunk_id
WHERE ql.program_id IS DISTINCT FROM c.program_id
  AND ql.created_at > now() - interval '30 days';
```

The second query misses chunks that were purged after the answer. Any row it returns is a SEV-1 until explained.

**SIEM delivery health.** A trigger copies each security event into a delivery outbox; a loop in the API server (the `web` service) signs and sends it to the SIEM webhook, retries with backoff, and moves rows that keep failing to `dead_letter`. `GET /api/admin/observability/security-audit` (super user) reports pending, delivering, delivered, and dead-letter counts, the oldest pending time, and `healthy`. A non-zero dead-letter count, or `deliveryConfigured: false` in production, means the SIEM copy is incomplete. The SIEM variables are not set on Railway today (deployment.md), so production reports `deliveryConfigured: false` and no copy of the audit log exists outside Truenote's control.

**Application error log and Railway logs.** `GET /api/admin/errors` lists recorded server errors with severity and source. Railway keeps each service's output: `railway logs -s worker` carries the `[ingestion] version <id> quarantined ...` lines (`artifacts/api-server/src/lib/ingestion/run.ts`, which the worker runs), and `railway logs -s web` carries `[security-audit] SIEM outbox worker failed` (`artifacts/api-server/src/lib/security/siem-outbox.ts`). `railway logs -s web --http` shows HTTP request logs with method, path, status, and source IP (Railway CLI 5.26 `railway logs --help`). Railway keeps logs for 7 days on the Hobby plan and 30 days on Pro ([Railway: logs](https://docs.railway.com/guides/logs), accessed 2026-10-07). Truenote's workspace is on Pro: on 2026-10-07 the Railway API returned `plan: "PRO"` and `logRetentionDays: 30` (`workspace.plan`, `workspace.subscriptionPlanLimit.observability`).

**Admin security page.** `GET /api/admin/security` (the Security page) shows the malware-scanning setting, quarantined-version counts, recent scan findings, and recent control events.

**Answer quality signals.** `query_log` records each answer's cited chunk ids, the `refused` flag, CSR feedback, and "flag missing" reports. The admin Queries, Insights, and Observability pages show these, including the refusal rate. The eval harness (`pnpm --filter @workspace/scripts run eval`, or a run from the admin Evaluations page) scores answers against the eval question set.

**GitHub.** The `security.yml` workflow runs on pull requests, on `main`, weekly, and on demand; it includes Gitleaks secret scanning, CodeQL, and a high-severity dependency audit. Dependabot opens weekly update pull requests for npm and GitHub Actions. As of 2026-10-07 the repository settings have GitHub secret scanning, push protection, private vulnerability reporting, and Dependabot vulnerability alerts turned on; Dependabot automated security-update pull requests are off. Secret scanning and Dependabot alerts appear on the repository's Security tab. Vulnerability reports arrive through GitHub private vulnerability reporting, as described in [`SECURITY.md`](../../SECURITY.md).

**Provider notices.** Breach, abuse, and key-exposure emails from the providers in section 2.

**Customer reports.** CSRs and program owners reporting a wrong answer, a citation from another program, or a suspicious account.

## 5. Response steps

### 5.1 Declare and record

1. Open an incident record (template in section 10) in the restricted evidence location `[CONFIRM: location]`. Give it an id such as `INC-2026-001`.
2. Write down in UTC: when the event happened (if known), when it was detected, how it was detected, and who reported it.
3. Set the severity from section 3.
4. Preserve evidence (section 8) before changing anything you can avoid changing.

### 5.2 Contain

Pick the actions that match the incident. Each application action below exists in the code today and each Railway command exists in Railway CLI 5.26, unless it is marked `[CONFIRM]`. Railway commands assume a directory linked to the production project and environment with `railway link` (backup-restore-runbook.md, top). Without a link, `railway variable`, `down`, `deployment list`, `up`, `logs`, and `ssh` accept `-p <project> -e <environment>`; `railway bucket` commands accept only `-e` and `-b` and need the linked directory (Railway CLI 5.26 `--help` for each command).

Railway variables. `railway variable set <KEY> --stdin -s <service>` reads the new value from standard input, which keeps it off the command line, and redeploys that service unless `--skip-deploys` is given; `--skip-deploys` batches several changes before one deploy ([Railway CLI: variable](https://docs.railway.com/cli/variable), accessed 2026-10-07; deployment.md). `railway variable delete` always redeploys (deployment.md). Most variables are set on both `web` and `worker` (deployment.md, "Variables"); change each service that has the variable. While a service is stopped, any of these commands without `--skip-deploys` starts it again.

Stopping and starting a service. `railway down -s <service> -y` removes the service's latest successful deployment; the service remains and can be deployed again with `railway up` ([Railway CLI: down](https://docs.railway.com/cli/down), accessed 2026-10-07). Railway's dashboard Remove action "will remove the deployment and stop any further project usage" ([Railway: deployment actions](https://docs.railway.com/guides/deployment-actions), accessed 2026-10-07). Railway keeps one deployment per service by default and stops and removes the previous one after a new one deploys ([Railway: deployment teardown](https://docs.railway.com/deployments/deployment-teardown), accessed 2026-10-07); on 2026-10-07 `railway deployment list --json` showed one `SUCCESS` deployment each for `web` and `worker` and every older one `REMOVED` or `FAILED`, so no older deployment is running that could take over. After stopping `web`, still confirm that `https://web-production-62818.up.railway.app/health` and `https://truenote.org/health` no longer answer. To start a service again, deploy the intended commit with the `railway up` commands in deployment.md ("Deploying"), with the owner's go.

| Situation | Action | How |
|---|---|---|
| A user account is compromised | Deactivate the user. This deletes all of that user's sessions in the same database transaction, and the session lookup also rejects any session whose user is inactive. | Admin Users page, **Deactivate** (`PATCH /api/admin/users/:id` with `isActive: false`). An admin cannot deactivate their own account. |
| A password may be known to an attacker | Reset the password. This sets a temporary password, forces a change at next login, and deletes all of that user's sessions in one transaction. | Admin Users page, **Reset password** (`POST /api/admin/users/:id/reset-password`). |
| Many sessions may be stolen, or a super user is compromised | Revoke every session. Session tokens are stored only as hashes in the `sessions` table, so deleting the rows logs everyone out. | Production psql session: `DELETE FROM sessions;` Then sign in again. If the compromised account is the only active super user, no other admin can deactivate it, and changing the bootstrap variables does not reset an existing super user. Instead: run `UPDATE users SET is_active = false WHERE id = '<compromised user id>';` and `DELETE FROM sessions;`, then on `web` set `BOOTSTRAP_SUPER_USER_EMAIL` to a new address that is not already a user and `BOOTSTRAP_SUPER_USER_PASSWORD` to a new value at least as long as the configured minimum (15 characters by default), the first with `--skip-deploys` and the second without, so `web` redeploys. At startup the API server creates a new super user only when no active super user exists (`artifacts/api-server/src/lib/auth/bootstrap.ts`), and that account must change its password at first login. The bootstrap variables are not set on Railway today (deployment.md); remove them after the new account has signed in. |
| Password login is being abused while SSO is configured | Turn off local password login. `LOCAL_LOGIN_MODE=disabled` refuses all password logins; `break_glass` allows only super users. Both apply only when OIDC is fully configured. | `railway variable set LOCAL_LOGIN_MODE --stdin -s web`. OIDC is not configured on Railway today (deployment.md), so this setting has no effect there now; to stop password logins, deactivate the accounts involved or stop `web`. |
| A provider key is leaked | Rotate the key: create a new key in the provider's console, set it on each service that has it, let the services redeploy, confirm the app works, then revoke the old key at the provider. | Variable names: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `COHERE_API_KEY`, `VISION_AGENT_API_KEY`, `RESEND_API_KEY` (on `web` and `worker`, deployment.md), and, once configured, `OIDC_CLIENT_SECRET`, `OIDC_STATE_SECRET`, `SIEM_WEBHOOK_SIGNING_KEY`, `MALWARE_SCANNER_TOKEN`, `MALWARE_SCANNER_HMAC_KEY`. |
| The bucket credentials are leaked | Reset them: `railway bucket credentials --reset -b truenote-storage` invalidates the existing credentials and creates new ones ([Railway CLI: bucket](https://docs.railway.com/cli/bucket), accessed 2026-10-07). | `railway bucket credentials -b truenote-storage` prints the new pair; set `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` on `web` and `worker`. Uploads and rescans fail until both services redeploy. Never paste the printed values into chat or tickets. |
| The production database connection string is leaked | Close the `pgvector` public TCP proxy, which the template opens and the app does not use (the app connects through `DATABASE_URL_PRIVATE`, deployment.md); a leaked public connection string then no longer reaches the database. Then change the database password and redeploy `web` and `worker`. | `railway tcp-proxy list -s pgvector --json` shows the proxy id; `railway tcp-proxy delete <proxy id> -s pgvector --yes` removes the proxy (Railway CLI 5.26 `railway tcp-proxy --help`). Networking changes apply immediately, without a deploy ([Railway: staged changes](https://docs.railway.com/deployments/staged-changes), accessed 2026-10-07). The server does not serve TLS (`SHOW ssl;` returned `off` on 2026-10-07), so anything sent through the proxy, the password included, crossed the internet unencrypted. Change the password with the runbook, section 7, step 3. |
| A Railway login or CLI token is leaked | Revoke the token and sign out other sessions; review recent deployments (`railway deployment list -s <service> --json`) and variable changes. A Railway login can read every variable, so rotate every key in the rows above. | Sessions: the account security page `https://railway.com/account/security` lists "all active browser and CLI sessions"; "Revoking a session will immediately log that device out" ([Railway: accounts](https://docs.railway.com/access/accounts), accessed 2026-10-07). Account and workspace tokens: the tokens page `https://railway.com/account/tokens`; project tokens: the tokens page in the project's settings ([Railway: public API](https://docs.railway.com/integrations/api), accessed 2026-10-07). Audit log: workspace admins open Audit Logs in the workspace settings (`https://railway.com/workspace/audit-logs`); it records changes to "projects, services, deployments, variables, and workspace settings" with the actor and time, and keeps them 30 days on Pro ([Railway: audit logs](https://docs.railway.com/enterprise/audit-logs), accessed 2026-10-07). On 2026-10-07 the Railway API `auditLogs` query returned entries for Truenote's workspace, among them `Deployment.created` and `SSHSession.authenticated`. Export the entries for the incident window before they age out. |
| A model route gives wrong or unsafe answers | Move the route to the end of the fallback chain on the Model Routing page (super user, `PUT /api/admin/model-routing`). The change applies within 30 seconds. The page cannot remove a route: every approved route stays in the chain as a last fallback. To remove a route fully, delete it from `APPROVED_MODEL_ROUTES` in `artifacts/api-server/src/lib/generation/model-routing.ts`, merge, and deploy (deployment.md). | All routes go through OpenRouter with zero-data-retention routing required; there is no direct-provider path to switch off separately. |
| A document is wrong, malicious, or in the wrong program | Revoke the active version. Retrieval returns only active versions, the citation layer refuses revoked ones, and revocation clears stored citation snapshots for the document. Retire the whole document if no version should stay. | Document preview panel, **Revoke now** (`POST /api/documents/:versionId/revoke`, senior manager or super user, reason required). Document list, **Retire** (`DELETE /api/documents/:id`, reason required). Permanent purge (`POST /api/documents/:id/purge`, super user, title confirmation, retention gate) is for eradication, not containment, because it deletes evidence. |
| A file needs to be held for review | The scanner path quarantines automatically: any upload whose scan is not clean, or whose content trips a blocking finding, goes to `quarantined` and is never embedded. There is no admin button to quarantine an already active version; revoke it instead. | `lib/ingestion/run.ts` sets the quarantine. Keep malware scanning **on** on the Security page. |
| Uploads must stop | Stop the worker: `railway down -s worker -y`. Uploads still land in the job queue and the bucket, but nothing is parsed, scanned, embedded, or sent to LandingAI or OpenAI until the worker runs again. This also stops evaluation runs. To block new uploads as well, deactivate the uploading accounts. | Start it again with the `railway up` command for `worker` in deployment.md. There is no single ingestion on/off setting. `[CONFIRM: whether to add one]` |
| The whole service must go dark | Stop both application services: `railway down -s web -y` and `railway down -s worker -y`. | See "Stopping and starting a service" above. The database keeps running; close its public TCP proxy too if it may be part of the exposure. |
| The database or bucket is exposed to the internet | The `pgvector` template opens a public TCP proxy on 5432 that the app does not use (deployment.md); closing it is an open decision there ("After cutover"). | `railway tcp-proxy delete <proxy id> -s pgvector --yes`, with the id from `railway tcp-proxy list -s pgvector --json` (Railway CLI 5.26 `railway tcp-proxy --help`). Tools that reach the database from outside Railway through the proxy stop working; `railway ssh -s pgvector` still works. |
| An attack is coming from many requests | Lower the per-user workload limits (`DOCUMENT_INGEST_RATE_LIMIT_PER_USER`, `EVAL_RUN_RATE_LIMIT_PER_USER`, `BULK_USER_IMPORT_RATE_LIMIT_PER_USER`, `USER_ADMIN_RATE_LIMIT_PER_USER`, `PASSWORD_CHANGE_RATE_LIMIT_PER_USER`, window `WORKLOAD_RATE_LIMIT_WINDOW_SECONDS`) on `web`, where the routes that apply them run. The minimum limit is 1; zero is ignored. | `railway variable set <KEY> --stdin -s web`, the last change without `--skip-deploys`. Deactivate the source accounts if the requests are authenticated. |

For a cross-program exposure (SEV-1): revoke the documents involved, then decide whether to stop `web` until the cause is fixed. Program scoping is a security boundary; a confirmed cross-program retrieval bug is a reason to go dark.

For uncited or wrong answers at scale (SEV-2): demote the model route that changed, revoke any document that introduced the wrong facts, and run the eval harness before and after the change to show the fix.

### 5.3 Eradicate

1. Find the root cause: a code defect, a configuration change, a leaked credential, a malicious document, or a provider failure.
2. Fix code through a pull request with the normal review gate, then deploy it as in deployment.md. Add a regression test or eval question that would have caught it.
3. Remove what the attacker left: accounts they created (deactivate, then delete), documents they uploaded (revoke or retire; purge only after evidence is preserved and the retention gate allows it), and keys they could have read (rotate).
4. If customer data was changed, restore it by re-uploading the correct documents. Use a database restore only when a large set of rows is damaged; follow [`backup-restore-runbook.md`](./backup-restore-runbook.md). Volume backups on `pgvector` are off today (owner decision, 2026-10-07); the owner will turn them on before full production, and backups being on is a precondition for full production. Until then the only database recovery copy is the latest dump the operator took; uploaded files have no backup at all (runbook, section 1).

### 5.4 Recover

1. Re-enable what you turned off, one item at a time: worker, local login mode, model route order, `web`, the TCP proxy if it is still needed. Each service start is a deploy from deployment.md.
2. Confirm the service works: `GET /health` returns `{"ok":true}`, `railway logs -s web` shows `[api-server] listening on http://0.0.0.0:8080` and `railway logs -s worker` shows `[worker] ready` (deployment.md), a CSR test account gets a cited answer in a test program, a question from another program is refused, and the eval harness shows no new failures.
3. Watch the detection sources in section 4 closely for 7 days. Check SIEM health and the denied-request query daily during that window.
4. Close the incident only after the customer notices in section 7 are sent and the retrospective is scheduled.

## 6. Communication rules

- Talk about the incident only with the customer security contact, the affected program owners, and the providers involved, until the customer agrees on wider communication.
- Do not put incident details in public GitHub issues, pull request titles, or commit messages until the fix is deployed and the customer agrees. Use the private vulnerability advisory for the fix discussion.
- State facts that are known, what is not yet known, and when the next update will come. Do not guess at scope.

## 7. Customer notification

These timelines are **proposed commitments**. They do not bind until the owner checks them against the customer contract and any law that applies. `[CONFIRM: notification windows in the customer contract or data processing terms]`

When the incident lead confirms an incident that affects customer data:

- **Initial notice within 24 hours** of confirmation, to the customer security contact. Include: what happened as far as known, when it was detected, which programs and data types may be affected, containment done so far, what the customer should do now (for example, disable accounts in their identity provider), and when the next update will come.
- **Written report within 72 hours** of confirmation. Include: timeline in UTC, root cause if known, the data and users affected, every containment and eradication action with its time, evidence preserved, remaining risk, and planned follow-up.
- **Updates** at least every 24 hours while the incident is open, and a final report after the retrospective.

For a provider breach notice, the 24-hour clock starts when the maintainer confirms that the notice covers Truenote data.

Who notifies regulators or individuals, if anyone must, is decided with the customer. `[CONFIRM: regulator and individual notification responsibilities between Truenote and the customer]`

## 8. Evidence preservation

Collect evidence before cleanup. Store it in the restricted evidence location, not in this repository. Record for each item who collected it, when (UTC), from where, and its SHA-256 hash.

1. **Security events.** Export the rows for the incident window, including `sequence`, `previous_hash`, and `event_hash`:

   ```sql
   SELECT * FROM security_events
   WHERE occurred_at BETWEEN '<start UTC>' AND '<end UTC>'
   ORDER BY sequence;
   ```

   To write the result to a file, use `\copy (...) TO '<file>.csv' WITH (FORMAT csv, HEADER)` in the production psql session, and copy the file off the volume as the runbook's "Shells" section describes. Rows cannot be updated or deleted through normal SQL because a trigger blocks it. The hash chain links each row to the one before it; a check that the links are unbroken is in [`backup-restore-runbook.md`](./backup-restore-runbook.md#53-security-event-hash-chain). If a SIEM receiver is configured, also export its copy for the same window; it is the copy outside Truenote's control.
2. **SIEM outbox state.** Save the output of `GET /api/admin/observability/security-audit`.
3. **Application data.** Export the affected `query_log` rows (question, answer, cited chunk ids, program, user, time), the affected users' rows without password hashes, and the affected document versions' lifecycle fields.
4. **Logs.** Save the Railway logs for the window before they age out (section 4 gives retention): `railway logs -s web --since <start UTC> --until <end UTC> --json`, the same for `worker`, and `railway logs -s web --http --since <start UTC> --until <end UTC> --json` for request logs, each written to a file. In bash, redirect with `> <file>.json`. In PowerShell 7.4 or later, `> <file>.json` writes UTF-8 without a BOM. In Windows PowerShell 5.1, first run `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` in the same session, then pipe each command to `Out-File -Encoding utf8 <file>.json`; this writes UTF-8 with a BOM. Without that first command, PowerShell 5.1 decodes the CLI output with the console code page and corrupts non-ASCII text such as names, and its `>` writes UTF-16LE. Without a deployment id the command reads the most recent successful deployment; list earlier ones with `railway deployment list -s <service> --json` and pass the id (Railway CLI 5.26 `railway logs --help`). Also save the application error log (`GET /api/admin/errors`).
5. **GitHub.** Save links to the relevant alerts, workflow runs, and commits.
6. **Provider records.** Ask the provider for usage logs of a leaked key before revoking it, if the provider supports that.
7. **Before any database restore**, export every security event and session newer than the restore point, and a snapshot of every user's authorization fields; a restore removes or reverts them. See the runbook, step 4.1.4.

Use UTC everywhere. Note clock source differences: database times come from Postgres `clock_timestamp()`; Railway, GitHub, and other providers use their own clocks.

## 9. Retrospective

Hold a written retrospective within **10 business days** of closing every SEV-1 and SEV-2 incident (proposed). For SEV-3, write a short note in the incident record.

The retrospective records: timeline, what detected it and how long detection took, what worked, what did not, root cause, and actions with an owner and due date. Actions that change code go through pull requests. Update this plan if a step was wrong or missing. Send the customer the final report from section 7.

## 10. Incident record template

```
Incident id:
Severity (initial / final):
Status: open | contained | recovered | closed
Detected at (UTC):           Detected by / source:
Started at (UTC, if known):  Confirmed at (UTC):
Programs affected:           Users affected:
Data types affected:
Customer initial notice sent (UTC):     Written report sent (UTC):
Containment actions (UTC, action, by whom):
Eradication actions:
Recovery checks and results:
Evidence items (name, location, SHA-256, collected by, UTC):
Root cause:
Retrospective date:          Actions (owner, due date):
```

## 11. Tabletop exercises

Run a tabletop exercise **twice a year** (proposed), and after any change that alters a containment step in section 5.2. Each exercise uses one scenario from section 3, walks through sections 5 to 8 against the real admin pages, the variable names in deployment.md, and the Railway CLI help, without changing production, and times each step. Rotate scenarios so that cross-program exposure, a leaked provider key, account takeover, wrong answers at scale, a provider breach notice, and a malware upload are each covered at least once every three years.

Record each exercise:

| Date | Facilitator | Participants | Scenario | Steps that worked | Gaps found | Actions (owner, due date) | Plan updated (Y/N) |
|---|---|---|---|---|---|---|---|
| | | | | | | | |
