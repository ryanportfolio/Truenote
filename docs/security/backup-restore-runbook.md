# Truenote backup and restore runbook

**Status:** Proposed. No restore test has been run yet; the evidence table in section 9 is empty. RPO and RTO values are proposed targets, not measured results. Items marked `[CONFIRM: ...]` need an owner check before this runbook is relied on.
**Current state (owner decision, 2026-10-07):** volume backups on the `pgvector` database service are off. The owner will turn them on (daily and weekly schedules proposed) before Truenote goes to full production; backups being on is a precondition for full production. Until then Railway holds no backup of the database, and a logical dump taken by the operator (section 4.1, step 5) is the only recovery copy. The volume-backup restore (path A) is written for that later state and is **not yet usable**.
**Owner:** Truenote maintainer
**Related:** [`incident-response-plan.md`](./incident-response-plan.md), [`.claude/reference/deployment.md`](../../.claude/reference/deployment.md) (Railway services, variables, deploys, schema changes; cited below as deployment.md), threat model entry TN-TM-024 in [`../compliance/pci/threat-model.md`](../compliance/pci/threat-model.md), evidence gaps in [`../compliance/pci/evidence-index.md`](../compliance/pci/evidence-index.md).

Production runs on Railway: project `truenote`, one environment `production` with no other environment and no development database, application services `web` and `worker`, database service `pgvector`, and bucket `truenote-storage` (deployment.md).

One person must be able to follow every step. You need the Railway CLI, logged in (the commands below were checked against CLI 5.26), an OpenSSH client (`ssh`) with the SSH key that `railway ssh` uses, for the tunnel in section 4.2, and a repository checkout with pnpm for the test instance in section 5.4. Postgres client tools are not needed on your machine: `psql`, `pg_dump`, and `pg_restore` run inside the `pgvector` container, including against the temporary test service in section 4.2.

Railway commands below leave out the project and environment flags. Run them from a directory linked to production:

```
railway link -p 2aa5cb01-5438-4fbd-aade-626d4e252977 -e b35c4090-cbcd-4deb-9434-e9b63a309bd9
```

Linking is the route to use: the commands do not all accept the same flags (Railway CLI 5.26 `--help` for each command). `railway ssh`, `logs`, `variable`, `down`, `deployment list`, and `up` accept `-p <project> -e <environment>`. `railway bucket` commands accept only `-e` and `-b`, so they need a linked directory for the project. For `railway volume`, the project and environment flags go before `files`, as in `railway volume -p <project> -e <environment> files --volume pgvector-volume download ...`; after `files` they are rejected.

## Shells

Commands that run on your machine are written for bash or zsh: Git Bash on Windows, or a macOS or Linux terminal running bash or zsh. Plain POSIX shells such as dash reject the `read -rs` form in the table below. PowerShell does not read the bash patterns these commands use; each command that uses one has its PowerShell form beside it. `railway`, `ssh`, `node`, and `pnpm` commands that use no shell variable are the same in both shells, except `railway volume files` commands (last row of the table). Commands run inside a container (after `railway ssh`) run in that container's Linux shell and are the same whichever shell you started from. SQL blocks run inside `psql`.

| Pattern | bash | PowerShell |
|---|---|---|
| Set a connection string for this session only (paste it at the prompt, so it stays out of shell history) | `read -rs TARGET_DATABASE_URL && export TARGET_DATABASE_URL` | `$env:TARGET_DATABASE_URL = Read-Host 'Connection string'` |
| Read it in a command | `"$TARGET_DATABASE_URL"` | `$env:TARGET_DATABASE_URL` |
| Set variables before starting a server | `API_PORT=3001 pnpm ...` (applies to that one command) | `$env:API_PORT = '3001'; pnpm ...` (stays set until the PowerShell window closes) |
| Remove a variable for this session | `unset NAME` | `Remove-Item Env:NAME -ErrorAction SilentlyContinue` |
| Pass a remote path that starts with `/` to `railway volume files` | `MSYS_NO_PATHCONV=1 railway volume files ...`. Git Bash needs the prefix: without it, `/truenote-dumps/x.dump` reaches Railway as `C:/Program Files/Git/truenote-dumps/x.dump`. Other bash and zsh shells ignore it. | `railway volume files ...`, unchanged, without the prefix |

`PROD_DATABASE_URL`, `DATABASE_URL`, and `POSTGRES_PASSWORD` follow the same pattern.

**Production psql session.** Steps that run SQL against production use this session. Open a shell in the database container:

```
railway ssh -s pgvector
```

Then, inside the container:

```
mkdir -p /var/lib/postgresql/truenote-dumps && cd /var/lib/postgresql/truenote-dumps
psql -h localhost -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X
```

This is the connection `scripts/railway-apply-sql.mjs` uses. Always pass `-h localhost -p 5432`: in this container `PGPORT` points at the public TCP proxy ([`.claude/reference/pitfalls.md`](../../.claude/reference/pitfalls.md), entry of 2026-10-07). `/var/lib/postgresql` is where the `pgvector-volume` volume is mounted (deployment.md), so files that `\copy` and `pg_dump` write to `truenote-dumps` stay on the volume. Copy each one to your machine, then delete it from the volume:

```
MSYS_NO_PATHCONV=1 railway volume files --volume pgvector-volume download /truenote-dumps/<file> ./<file>
MSYS_NO_PATHCONV=1 railway volume files --volume pgvector-volume delete /truenote-dumps/<file>
```

In PowerShell, drop `MSYS_NO_PATHCONV=1` (section "Shells"). The `--volume` option goes before the subcommand ([Railway CLI: volume](https://docs.railway.com/cli/volume), accessed 2026-10-07). That page does not say whether a remote path is relative to the volume or to its mount point `[CONFIRM: with MSYS_NO_PATHCONV=1 railway volume files --volume pgvector-volume list / that /truenote-dumps/ is the folder created above]`. It also says `files delete` refuses to run when an AI agent invokes it, so a person runs it. Files left on the volume hold production data, including password hashes, and once volume backups are on they are copied into every later backup.

## 1. What holds data and what backs it up

Provider statements below were read on 2026-10-07. Re-read the cited page before each restore test; providers change these features.

| Data | Where it lives | What backs it up | Gaps |
|---|---|---|---|
| All application rows: programs, users, sessions, documents, document versions, parsed text, chunks and embeddings, query log, security events, SIEM outbox, settings, the schema ledger `schema_migrations`, and the job queue (`pgboss` schema) | Service `pgvector`, image `pgvector/pgvector:pg18`, volume `pgvector-volume` mounted at `/var/lib/postgresql` (deployment.md) | **Nothing on Railway today.** deployment.md: "Backups: none yet"; the owner decided on 2026-10-07 to leave volume backups off until before full production. Operator dumps (section 4.1, step 5) are the only copy. **Once turned on**, Railway volume backups run on schedules: "Daily - Backed up every 24 hours, kept for 6 days", "Weekly - Backed up every 7 days, kept for 27 days", "Monthly - Backed up every 30 days, kept for 89 days"; one volume can have several schedules, and "Manual backups are limited to 50% of the volume's total size". A restore stages "a new volume mounted to the same location as the original volume"; "The previous volume will be retained but has been unmounted from the service"; the restore completes when you click Deploy. "Backups can only be restored into the same project + environment." "Wiping a volume deletes all backups." Backups are billed like volumes, only for "the data exclusive to them". ([Railway: backups](https://docs.railway.com/reference/backups), accessed 2026-10-07.) The page describes no point-in-time restore. | No backup until the owner turns schedules on. A volume backup restores only onto the `pgvector` service itself, so it cannot be checked on a separate target before it replaces production data (section 3, rule 1). Railway documents point-in-time recovery for Postgres through WAL archiving that its own Postgres image performs ([Railway: point-in-time recovery](https://docs.railway.com/volumes/point-in-time-recovery), accessed 2026-10-07); `pgvector` runs `pgvector/pgvector:pg18`, which that page does not mention `[CONFIRM: with Railway whether point-in-time recovery can work for the pgvector service]`. It is not on. A Railway guide words the retention as "kept for 1 month" and "kept for 3 months" and says restoring "removes any newer backups" ([Railway: back up and restore Postgres](https://docs.railway.com/guides/postgres-backups-restores), accessed 2026-10-07), while the reference page says newer backups stay on the previous volume; this runbook follows the reference page `[CONFIRM: which page is current]`. `[CONFIRM: with Railway that a volume backup taken while Postgres is running restores to a database Postgres can recover]` |
| Uploaded source files (PDF, DOCX, images, text) | Bucket `truenote-storage`, S3-compatible, endpoint `https://t3.storageapi.dev`, keys `uploads/<sha256>-<name>` (deployment.md). Each document version's key is in `document_versions.source_url`. | **None.** Railway: "Railway doesn't currently offer automatic backups or snapshots for buckets"; "Object versioning", "Object locks", and "Bucket lifecycle configuration" are listed as not yet supported. A deleted bucket "stays restorable for 52 hours, after which every object in it is destroyed." Buckets "run on Tigris's metal servers". ([Railway: storage buckets](https://docs.railway.com/guides/storage-buckets), accessed 2026-10-07.) No document or script in this repository backs up the bucket. | Gap: a deleted or overwritten object cannot be recovered, and a database restore does not bring files back. `[CONFIRM: with Railway that truenote-storage has no backup or versioning; and a periodic export of the bucket to owner-controlled storage, for which no tool exists in the repository]`. Truenote reads the original file only during ingestion and rescan. Answers, citations, and previews use the parsed text and chunks in the database. Losing a file blocks rescans of that version; it does not break existing answers. Eight objects the database references were not copied to Railway on 2026-10-07, so rescans of those versions already fail (deployment.md, "Data copy"). |
| Secrets (provider keys, bucket credentials, sign-in and email settings) | Railway service variables on `web` and `worker` (deployment.md, "Variables"); the owner keeps the source values outside git (deployment.md) | Not backed up by Truenote. Each value can be re-issued at its provider; bucket credentials can be reset (section 7). | `[CONFIRM: whether the owner's source file is encrypted and has its own backup]`. Keep a list of variable names and where each is issued, not the values. Names used by the code are listed in the incident response plan, section 5.2. |
| Application code and database DDL | GitHub repository. Baseline DDL: the files under `docs/security/`, already in the database copied on 2026-10-07. Later changes: numbered files in `lib/db/sql/`, recorded in `schema_migrations` when applied (deployment.md, "Schema changes"). | Git history on GitHub. Railway keeps earlier deployments (deployment.md, "Deploying"). | A database restore does not roll back code, and a code rollback does not restore the database. |

## 2. Recovery targets (proposed)

These are proposed targets for one maintainer. They are not measured. Replace "proposed" with "approved" only after the owner agrees and a restore test meets them. RPO follows from how often a recovery copy is made.

| Situation | RPO (most data that may be lost) | RTO (time from the decision to restore until CSRs get cited answers again) |
|---|---|---|
| Today: no volume backups; restore from the latest operator dump (path B) | Time since that dump: up to 7 days with the weekly dump below (proposed) | 8 hours (proposed) |
| After the owner turns on daily volume backups (path A) | Up to 24 hours, because a daily backup runs every 24 hours. Restore points reach back 6 days with the daily schedule and 27 days with the weekly one (proposed) | 8 hours (proposed) |
| Uploaded source files | Every file since the last bucket export. No export exists today, so every file is at risk `[CONFIRM: export schedule; proposed weekly]` | 2 business days to collect missing files from program owners and re-upload (proposed) |
| Secrets | Not applicable (re-issue) | 4 hours to re-issue and set all variables (proposed) |

Dump cadence until volume backups are on (proposed): one dump a week, and one immediately before each risky change: applying a `lib/db/sql/` file, a bulk user import, a re-ingest, a document purge, or a deploy that changes ingestion or data handling. Take every dump, including these, with section 4.1, step 5, so each gets its count record. Record each dump (UTC time, size, SHA-256, storage location) in the restricted evidence location, and store its count record next to it.

Measure RPO as the gap between the chosen restore point and the last good write that the restore discarded. Measure RTO from the recorded decision time to the first passing smoke test against production after cutover.

## 3. Safety rules for any restore

1. **Restore to a non-production target first.** Railway has one environment for Truenote, `production`, and no development database (deployment.md), so a non-production target is one of these:
   - a temporary Railway service in the `truenote` project, created from the `pgvector/pgvector:pg18` image for each scheduled test and deleted when its evidence is recorded (sections 4.2 and 4.6). It runs its own Postgres server with its own password and no volume, separate from the `pgvector` service and `pgvector-volume`. It sits in the `production` environment, the only one, and so on production's private network `[CONFIRM: that the owner accepts a temporary test service in the production environment]`;
   - for an incident restore from a dump (path B), a separate scratch database inside the `pgvector` server (section 4.4). It is not production until it is renamed into place, but it shares the production server's disk, memory, and credentials `[CONFIRM: that the owner accepts this Railway-hosted target, and that pgvector-volume has room for a second copy of the database]`.

   A volume-backup restore (path A) has no non-production target: Railway restores only into the same project and environment and mounts the restored volume on the `pgvector` service ([Railway: backups](https://docs.railway.com/reference/backups), accessed 2026-10-07). For path A the rule becomes: take a dump first (section 4.1, step 5), keep `web` and `worker` stopped, run section 5 against the restored production database before either starts, and keep the previous volume for rollback (section 4.5). Record in the evidence table which form of this rule applied.
2. **Isolate the test app instance.** When running Truenote against a restored target:
   - from a repository checkout, start only the API server (`pnpm --filter @workspace/api-server run dev`) and, for the smoke test, the Vite frontend dev server (section 5.4). Do **not** start the worker (`pnpm --filter @workspace/scripts run worker`, the process the Railway `worker` service runs, `scripts/src/worker.ts`): it processes queued ingestion and evaluation jobs, sends files to LandingAI and OpenAI, and writes to object storage;
   - set `RAG_STORAGE_DRIVER=memory` and leave every `S3_*` variable unset. `getObjectStorage()` (`artifacts/api-server/src/lib/storage/object-storage.ts`) selects the in-memory store only for `memory`; any other value, unset included, selects the S3 adapter, which with production's `S3_*` values can read and delete objects in `truenote-storage`;
   - leave `SIEM_WEBHOOK_URL` unset, so outbox rows copied from production are not re-sent to the SIEM. The outbox delivery loop runs inside the API server (`artifacts/api-server/src/index.ts`). The SIEM variables are not set on Railway today (deployment.md); the rule holds for any shell that has them;
   - leave `RESEND_API_KEY`, `BOOTSTRAP_SUPER_USER_*`, and `DEMO_LOGIN_ACCOUNTS` unset, and do not set `NODE_ENV=production`. Do not run the test instance from the Railway image, which sets `NODE_ENV=production` (`Dockerfile.railway`), and do not start it with `railway run`, which runs a local command with the variables of the linked Railway environment and so brings in production's `DATABASE_URL`, `S3_*`, `RESEND_*`, and `DEMO_LOGIN_ACCOUNTS` (deployment.md, "Variables");
   - leave every `OIDC_*` variable unset and set `LOCAL_LOGIN_MODE=enabled`. `getOidcConfig()` (`artifacts/api-server/src/lib/auth/oidc.ts`) turns company SSO on when `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, and an `OIDC_STATE_SECRET` of at least 32 characters are set, and when `LOCAL_LOGIN_MODE` is unset it then defaults the password login to `break_glass`. In `break_glass` mode `POST /api/auth/login` (`artifacts/api-server/src/routes/auth.ts`) checks the password and then refuses every account except a `super_user` with HTTP 403 `Use company SSO to sign in.`; a super user's sign-in is recorded as `auth.break_glass.login`. In `disabled` mode it refuses every account and the sign-in page hides the password field. OIDC is not set on Railway today (deployment.md), but a shell that inherits OIDC values, for example through `railway run` after OIDC is configured, would block the CSR password sign-in that section 5.4 needs. SSO from the test instance does not work either: `GET /api/auth/oidc/start` sends the browser to the identity provider with the production `OIDC_REDIRECT_URI`, so the provider returns it to the production deployment, whose callback rejects it because the state cookie was set on the test origin. Without the five SSO values SSO is off and every active account can use its password; `LOCAL_LOGIN_MODE=enabled` keeps the password field on the sign-in page even when the shell inherited `LOCAL_LOGIN_MODE=disabled`. Before starting the test servers, in each shell:

     ```
     unset OIDC_ISSUER_URL OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_REDIRECT_URI OIDC_STATE_SECRET OIDC_REQUIRED_ACR OIDC_REQUIRE_MFA OIDC_ALLOWED_DOMAINS && export LOCAL_LOGIN_MODE=enabled
     ```

     PowerShell:

     ```
     Remove-Item Env:OIDC_* -ErrorAction SilentlyContinue; $env:LOCAL_LOGIN_MODE = 'enabled'
     ```

     To test SSO itself, register a separate test client at the identity provider whose redirect URI is the test origin's callback (`http://localhost:5173/api/auth/oidc/callback`, which the Vite proxy forwards to the API), set the five `OIDC_*` values to that client, and still set `LOCAL_LOGIN_MODE=enabled` so the CSR password sign-in keeps working. Outside `NODE_ENV=production` the code accepts `http` issuer and redirect URLs. `[CONFIRM: whether the identity provider allows a separate client with a localhost redirect URI]` Never reuse the production client: its redirect URI points at production;
   - never run `sweep-orphans` or the document purge against a restored target. `scripts/src/sweep-orphans.ts` deletes nothing today: it lists the keys the connected database references. It stays on this list because a version that deletes unreferenced keys, which its comments plan, would delete files production still needs when pointed at a restore. The purge deletes the document's files from the bucket.
3. **Keep connection strings and variable values out of shell history, chat, tickets, and this repository.** Paste them into an environment variable for the session only.
4. **Record times in UTC** as you go. The evidence table needs them.

## 4. Restore procedure

Paths:

- **Path A, volume backup** (not yet usable: backups are off). Restores the `pgvector` volume from a Railway backup.
- **Path B, operator dump** (available today). Restores a `pg_dump` taken by the operator: into a temporary Railway service for a scheduled test (section 4.2), or into a scratch database on the `pgvector` server for an incident (section 4.4).

### 4.1 Prepare

1. Write down the start time (UTC) and why you are restoring: scheduled test, or incident id.
2. Choose the restore point.
   - Incident: the last time before the damage. Use `security_events.occurred_at`, `query_log.created_at`, and the document lifecycle events (`document.lifecycle.*`) to find it. Path A: the newest backup taken before that time; Railway lists backups by date stamp. Path B: the newest dump taken before that time. A dump taken during the incident contains the damage.
   - Scheduled test: path B with a dump taken for the test (step 5). The restore point is the dump's start time.
3. Capture a production baseline (read-only, in the production psql session), so the restored target can be compared with it:

   ```sql
   SELECT now() AS captured_at,
     (SELECT count(*) FROM programs) AS programs,
     (SELECT count(*) FROM users) AS users,
     (SELECT count(*) FROM documents) AS documents,
     (SELECT count(*) FROM document_versions) AS document_versions,
     (SELECT count(*) FROM chunks) AS chunks,
     (SELECT count(*) FROM query_log) AS query_log,
     (SELECT count(*) FROM security_events) AS security_events,
     (SELECT max(sequence) FROM security_events) AS last_event_sequence;
   ```

   Also record the same counts as of the restore point where the table has a timestamp, for example `SELECT count(*) FROM query_log WHERE created_at <= '<restore point>';`.
4. For an incident restore, export what the restore will remove or revert. In the production psql session (files land in `/var/lib/postgresql/truenote-dumps/`):

   ```
   \copy (SELECT * FROM security_events WHERE occurred_at > '<restore point>' ORDER BY sequence) TO 'security-events-after-restore-point-<UTC date>.csv' WITH (FORMAT csv, HEADER)
   \copy (SELECT user_id, created_at FROM sessions WHERE created_at > '<restore point>') TO 'sessions-after-restore-point-<UTC date>.csv' WITH (FORMAT csv, HEADER)
   ```

   Also export a snapshot of every user's sign-in and authorization fields. The application does not record resulting user state in its audit events. The generic audit middleware (`artifacts/api-server/src/middleware/security-audit.ts`) writes one `http.security_mutation` event only for requests whose method is not GET, HEAD, or OPTIONS (in practice POST, PATCH, PUT, and DELETE) and that Express routes under `/api/admin`, `/api/documents`, or `/api/auth`. Express matches these bases without regard to letter case and also for absolute-form request targets. For each such request the middleware stores the method and path (the base in lower case, the rest of the path as the client sent it, and the raw path when it differs), the response status and outcome, the actor (user id, email, and role), the actor's program, the request id, the source IP, and the request duration. It does not store the request body or the resulting user state: the account's role, active flag, program, clearance, or password changes. The admin user routes write no event with the account's new role, active flag, or program. The exported `security_events` therefore cannot rebuild these fields, and this snapshot is the only record of them. In the production psql session:

   ```
   \copy (SELECT id, email, role, program_id, is_active, must_reset_password, max_classification, password_hash FROM users ORDER BY id) TO 'truenote-users-before-restore-<UTC date>.csv' WITH (FORMAT csv, HEADER)
   ```

   `program_id` is the user's program assignment (the only one; NULL only for `super_user`), and `max_classification` is the user's clearance for document classification. The file holds password hashes. Copy all three files to your machine and delete them from the volume (section "Shells"), store them encrypted in the restricted evidence location `[CONFIRM: location]`, never in this repository, and delete local copies with the dump file (section 4.6).

   When the cutover in section 4.4 stops writes, run all three exports in this step again and use the later files for reconciliation, so changes made while the target was being verified are not lost.
5. Take a logical dump of production for every path B restore, including scheduled tests; before every path A restore, as a last-resort rollback copy; and on the cadence in section 2. The command matches the 2026-10-07 data copy (deployment.md, "Data copy"): `pg_dump` 18 inside `pgvector`, custom format, `--no-owner --no-acl`, without the `_system` and `pgboss` schemas and without the rows of `sessions` and `password_reset_tokens`. Excluding `_system` changes nothing when that schema does not exist.

   The dump and its count record are written to `pgvector-volume`, the production volume. For a scheduled test they are the one write the test makes to it; both files are deleted from the volume after section 4.2 has restored the dump, and no later than section 4.6, step 3. Before writing them, check that the volume has room. Inside the container, `df -h /var/lib/postgresql` shows the free space on the volume; in the production psql session, `SELECT pg_size_pretty(pg_database_size(current_database()));` shows the database size. Continue only when the free space is larger than the database size; a custom-format dump of the database is smaller than the database itself. `[CONFIRM: on the first test, that df inside the container reports the volume's size limit; railway metrics -s pgvector --volume also shows volume metrics (Railway CLI 5.26 railway metrics --help)]`

   First, in the production psql session, immediately before the dump, write the dump's count record: the baseline query from step 3, run again with its output sent to a file next to the dump. Enter `\o truenote-prod-<UTC date>-counts.txt`, paste the step 3 query, then enter `\o` to send output back to the screen. Every dump gets a count record: the weekly dumps, the dumps before risky changes (section 2), and the dumps taken for a test or before a restore. A restore from a dump is checked against that dump's own count record (section 5.2). The step 3 baseline does not serve: writes made between step 3 and the dump change production counts, and an incident restore uses a dump taken long before. `pg_dump` exports one consistent snapshot taken when it starts, so only writes made between the count query and that start can still cause a difference. Then leave `psql` (`\q`) and, still inside the container:

   ```
   pg_dump -h localhost -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl --exclude-schema=_system --exclude-schema=pgboss --exclude-table-data=public.sessions --exclude-table-data=public.password_reset_tokens --file=/var/lib/postgresql/truenote-dumps/truenote-prod-<UTC date>.dump
   sha256sum /var/lib/postgresql/truenote-dumps/truenote-prod-<UTC date>.dump
   ```

   Copy the dump and its count record to your machine (section "Shells") and record the dump's SHA-256. Store both together, encrypted, outside the repository `[CONFIRM: storage location for dumps]`, then delete both from the volume. For a scheduled test, delete them only after section 4.2 has restored the dump: that restore reads the file on the volume. An incident restore uses an earlier dump taken before the damage; section 4.4 uploads that one back to the volume, and section 5.2 compares the restore with that dump's count record.

   What the dump leaves out: sessions and reset tokens, so everyone signs in again after a restore from it; and the `pgboss` job queue, which the first boot of `web` or `worker` recreates empty (deployment.md, "Data copy"). Ingestion or evaluation jobs queued at dump time are lost; a version that was waiting on one needs a new upload `[CONFIRM: which document version states such a version is left in]`.

### 4.2 Create the test service (path B, scheduled tests)

Create a temporary service in the `truenote` project that runs an empty Postgres 18 server from the image production uses (deployment.md). The service costs money for as long as it runs, whether or not a test is in progress. Railway's pricing page lists container prices of $10 per GB of RAM per month and $20 per vCPU per month, each shown with its per-minute equivalent ([Railway: pricing plans](https://docs.railway.com/reference/pricing/plans), accessed 2026-10-07). Create it once the dump from step 4.1.5 is on the volume, and delete it as soon as the evidence is recorded (section 4.6).

1. On your machine, generate the service's password into a session variable. The value stays out of shell history. It is 64 hex characters, so it needs no escaping in a connection string.

   ```
   POSTGRES_PASSWORD=$(openssl rand -hex 32) && export POSTGRES_PASSWORD
   ```

   PowerShell:

   ```
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $env:POSTGRES_PASSWORD = -join ($b | ForEach-Object { $_.ToString('x2') })
   ```

2. Create the service from the image, with that password as its `POSTGRES_PASSWORD` variable:

   ```
   railway add --image pgvector/pgvector:pg18 --service truenote-restore-test --variables "POSTGRES_PASSWORD=$POSTGRES_PASSWORD"
   ```

   PowerShell:

   ```
   railway add --image pgvector/pgvector:pg18 --service truenote-restore-test --variables "POSTGRES_PASSWORD=$env:POSTGRES_PASSWORD"
   ```

   `--image` creates the service from an image and `--variables` sets `"{key}={value}"` pairs on it (Railway CLI 5.26 `railway add --help`). Shell history keeps the variable name, not the value; the value is on the `railway` process's command line while it runs. The server's user and database are both `postgres`, the image defaults when `POSTGRES_USER` and `POSTGRES_DB` are unset `[CONFIRM: the pgvector/pgvector:pg18 defaults]`. `railway add` also links the new service to the current directory ([Railway CLI: add](https://docs.railway.com/cli/add), accessed 2026-10-07). Every Railway command in this runbook that targets a service passes `-s`, so none of them falls through to the test service.

   The service has no volume. Its data lives on the container's ephemeral storage and is gone when the service is deleted; a restart or redeploy also loses it, and the restore must then be repeated. Ephemeral storage per service is 1 GB on the Trial and Free plans and 100 GB on Hobby and Pro (Railway: pricing plans) `[CONFIRM: the workspace's plan, and that the restored database fits]`. `[CONFIRM: that Railway attaches no volume to a service created from this image]`; section 4.6 checks for one before deleting the service.

   Right after creating it, check that the service has no TCP proxy, so it is never reachable from the internet during the test:

   ```
   railway tcp-proxy list -s truenote-restore-test --json
   ```

   It must list no proxy. If it lists one, delete it with `railway tcp-proxy delete <proxy id> -s truenote-restore-test --yes` and run the list again before going on.
3. Wait until the server is up: `railway deployment list -s truenote-restore-test --json` shows `SUCCESS`, and `railway logs -s truenote-restore-test` shows `database system is ready to accept connections` `[CONFIRM: that the first deployment starts with POSTGRES_PASSWORD set; if the log says the superuser password is not specified, run railway redeploy -s truenote-restore-test -y]`. Read the service's private DNS name with `railway private-network status -s truenote-restore-test`. The commands below assume `truenote-restore-test.railway.internal`, Railway's `SERVICE_NAME.railway.internal` form ([Railway: private networking](https://docs.railway.com/networking/private-networking), accessed 2026-10-07).
4. Restore from inside the production `pgvector` container, over Railway's private network. The dump does not leave Railway for this: the restore reads the file that step 4.1.5 wrote to `pgvector-volume`. Print the password once to paste at the prompts (bash: `printf '%s\n' "$POSTGRES_PASSWORD"`; PowerShell: `$env:POSTGRES_PASSWORD`), open a shell in the container (section "Shells"), and run:

   ```
   pg_isready -h truenote-restore-test.railway.internal -p 5432
   psql -h truenote-restore-test.railway.internal -p 5432 -U postgres -d postgres -X -W -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
   pg_restore -h truenote-restore-test.railway.internal -p 5432 -U postgres -d postgres -W --no-owner --no-acl --single-transaction --exit-on-error /var/lib/postgresql/truenote-dumps/truenote-prod-<UTC date>.dump
   ```

   `pg_isready` must report `accepting connections` before the other two run. The extensions are the ones the schema uses (deployment.md: `vector`, `pg_trgm`, `pgcrypto`). `-W` makes `psql` and `pg_restore` ask for the password, so a `PGPASSWORD` in the production container's environment, if one is set, is not used for the test server. `-h` names the test service on every command: `localhost` in this container is production. Run the SQL checks in section 5 in the same container with `psql -h truenote-restore-test.railway.internal -p 5432 -U postgres -d postgres -X -W`.
5. Give the section 5.4 test instance a connection through an SSH tunnel from your machine to the test service. Railway SSH forwards local ports to "the container's loopback and your project's private network", and dials the connection from inside the container ([Railway CLI: ssh](https://docs.railway.com/cli/ssh), accessed 2026-10-07). Write an OpenSSH config block for the service, then open the tunnel in a separate shell and leave it running through section 5.4:

   ```
   railway ssh config --service truenote-restore-test --alias truenote-restore-test
   ```

   ```
   ssh -N -L 127.0.0.1:5433:127.0.0.1:5432 truenote-restore-test
   ```

   The same page says a service without a domain uses its service instance ID as the SSH user `[CONFIRM: on the first test, that the generated block and the tunnel work for this service, which has no domain]`. The target's connection string uses user `postgres`, the password above, host `127.0.0.1`, port `5433`, and database `postgres`. Set it as `TARGET_DATABASE_URL` with the pattern in the shell table.

   Do not open a TCP proxy on the test service instead. A proxy is a public endpoint, and Railway's TCP proxy page does not say whether the traffic is encrypted ([Railway: TCP proxy](https://docs.railway.com/networking/tcp-proxy), accessed 2026-10-07) `[CONFIRM: whether the pgvector image serves TLS; if the tunnel fails and the owner approves a proxy, create it with railway tcp-proxy create --port 5432 -s truenote-restore-test, connect to the domain and port railway tcp-proxy list -s truenote-restore-test prints, and delete it at the end of section 5.4]`. Never point a test at production's `pgvector` proxy.

Scheduled tests do not use a scratch database inside the production `pgvector` server, the target of Railway's restore drill ([Railway: back up and restore Postgres](https://docs.railway.com/guides/postgres-backups-restores), accessed 2026-10-07): it would put a second copy of the data on production's disk and load production's server at every test. Section 4.4 uses that target only for incidents.

Path B tests Truenote's own dump, not a Railway backup. It restores the state at dump time, not a chosen point in the past, so it cannot show that a backup is recoverable. Record which path you used. Until the owner turns on volume backups and path A is rehearsed (section 8), path A is untested.

### 4.3 Verify the target

Run every check in section 5 against the target. Stop and record the failure if any check fails.

### 4.4 Cut over (incident restores only)

Skip this section for a scheduled test.

1. Tell the customer security contact the planned downtime window.
2. Stop writes by removing the running deployment of both application services:

   ```
   railway down -s web -y
   railway down -s worker -y
   ```

   `railway down` removes the latest successful deployment; the service is not deleted and can be deployed again with `railway up` ([Railway CLI: down](https://docs.railway.com/cli/down), accessed 2026-10-07). The page does not say whether an older deployment takes over `[CONFIRM: on the first use, that nothing keeps serving]`, so check: `railway deployment list -s web --json` and `railway deployment list -s worker --json` show no active deployment, `https://web-production-62818.up.railway.app/health` (deployment.md, "Hosts") no longer answers, and in the production psql session no application connection remains:

   ```sql
   SELECT pid, application_name, client_addr, backend_start
   FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid();
   ```

   Then repeat the exports in step 4.1.4. Both services stay stopped until step 6. Until then nothing may start them: no `railway up` or `railway redeploy` on `web` or `worker`, no `railway variable set` on them without `--skip-deploys` (it triggers a deploy, [Railway CLI: variable](https://docs.railway.com/cli/variable), accessed 2026-10-07), and no `railway variable delete` on them (it always redeploys, deployment.md). A start would put production in front of users, and let the worker process restored jobs, before step 5 has reconciled authorization fields, removed restored sessions and reset tokens, and re-applied document revocations.
3. Restore production to the **same restore point** that passed section 5.

   **Path A, volume backup (not yet usable: backups are off).** In the Railway dashboard, open the `pgvector` service, Backups tab, find the backup by its date stamp, and click Restore. Railway stages a new volume, named for the backup's date stamp and mounted at the same location; click Deploy to complete it. The previous volume stays in the project, unmounted, and keeps any backups newer than the one restored ([Railway: backups](https://docs.railway.com/reference/backups), accessed 2026-10-07). `[CONFIRM: that deploying the staged restore redeploys only pgvector and leaves web and worker stopped]` The exports from step 4.1.4 were on the previous volume; that is why they were copied off first. Then run every check in section 5 against production, with `web` and `worker` still stopped; if any fails, go to section 4.5.

   **Path B, operator dump (available today).** Use a dump taken before the damage. If it is no longer on the volume, upload it:

   ```
   MSYS_NO_PATHCONV=1 railway volume files --volume pgvector-volume upload ./truenote-prod-<UTC date>.dump /truenote-dumps/truenote-prod-<UTC date>.dump
   ```

   In PowerShell, drop `MSYS_NO_PATHCONV=1` (section "Shells").

   In a shell in the `pgvector` container (section "Shells"), restore it into a new database next to production:

   ```
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -c "CREATE DATABASE truenote_restore"
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d truenote_restore -X -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
   pg_restore -h localhost -p 5432 -U "$POSTGRES_USER" -d truenote_restore --no-owner --no-acl --single-transaction --exit-on-error /var/lib/postgresql/truenote-dumps/truenote-prod-<UTC date>.dump
   ```

   Run every check in section 5 against `truenote_restore` (`psql -h localhost -p 5432 -U "$POSTGRES_USER" -d truenote_restore -X`). Postgres refuses to rename a database that has open connections, and the section 5.4 test API server keeps pooled connections to `truenote_restore` while it runs. So before the swap, stop the test API server and the Vite frontend dev server (Ctrl+C in each shell) and close every `psql` session. Then check, in the `pgvector` container, that neither database has a connection left:

   ```
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -c "SELECT datname, pid, application_name, client_addr, backend_start FROM pg_stat_activity WHERE datname IN ('$POSTGRES_DB', 'truenote_restore')"
   ```

   Continue only when it returns no rows; otherwise find and close each listed connection, then run the check again. Swap the databases:

   ```
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -c "ALTER DATABASE \"$POSTGRES_DB\" RENAME TO truenote_before_restore"
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -c "ALTER DATABASE truenote_restore RENAME TO \"$POSTGRES_DB\""
   ```

   If the first rename succeeds and the second fails, no database has the name `$POSTGRES_DB`. Rename the first one back at once, then run the connection check again, close what it lists, and repeat the swap:

   ```
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -c "ALTER DATABASE truenote_before_restore RENAME TO \"$POSTGRES_DB\""
   ```

   The application reaches `$POSTGRES_DB` through `DATABASE_URL_PRIVATE` `[CONFIRM: that DATABASE_URL_PRIVATE names $POSTGRES_DB, as scripts/railway-apply-sql.mjs assumes for production]`. `truenote_before_restore` is the rollback copy (section 4.5).
4. Bring the restored schema forward to the deployed code, with `web` and `worker` still stopped. A database restore does not restore code, so the restored database has the schema of the restore point while step 6 starts the currently deployed commit. That code needs the tables and columns in `lib/db/src/schema.ts` plus the objects the DDL files created. A Railway restore point is never older than the 2026-10-07 baseline, which already holds every file under `docs/security/` (deployment.md, "Schema changes"), so only `lib/db/sql/` files can be missing. Check at every restore:
   - In the production psql session, list the recorded files: `SELECT filename, sha256 FROM schema_migrations ORDER BY filename;`. Compare with the files in `lib/db/sql/` at the deployed commit. A file in the folder and not in the result needs applying. If the table itself is missing, `0001_schema_migrations.sql` comes first.
   - Run the section 5.1 query and [`../compliance/pci/production-control-verification.sql`](../compliance/pci/production-control-verification.sql) against production and compare the output with the last production run from before the incident.
   - Apply each missing file in number order, from the repository root of a checkout at the deployed commit:

     ```
     node scripts/railway-apply-sql.mjs lib/db/sql/NNNN_<name>.sql
     node scripts/railway-apply-sql.mjs lib/db/sql/NNNN_<name>.sql --apply
     ```

     The first command prints the file's status (`no-table`, `not-applied`, or the recorded SHA-256) and its local SHA-256. The second runs the file with `psql --single-transaction` inside `pgvector` over `railway ssh` and records it in `schema_migrations` in the same transaction; it refuses a file already recorded (`scripts/railway-apply-sql.mjs`, deployment.md). It talks only to `pgvector`, so `web` and `worker` stay stopped. Read each file before running it.
   - Run the comparison again. Continue only when the output matches the last production run.
   - Do not deploy an older commit to match the restored schema: `railway up` starts the service before step 5 is done. If forward DDL cannot be found or applied, keep both services stopped and record the blocker.
5. Reconcile changes the restore removed. Do every part of this step while `web` and `worker` are still stopped.
   - Restore user sign-in and authorization fields from the user snapshot exported after writes stopped (step 4.1.4), and remove every session and reset token, in one production psql session. Upload the snapshot to `/truenote-dumps/` first if it is not on the volume; after path A it is not, because the volume was replaced (use the restored volume's name in `--volume`, from `railway volume list`). The snapshot was taken after the damage, so it can hold the attacker's changes: a raised role, a password the attacker set, a reactivated account, or an account moved into another program. Copying it without review would put that damage back, including access to another program's documents. The operator therefore reviews every changed account before the copy and excludes the ones the incident explains or that nobody can explain.

     Load the snapshot and list every account whose authorization fields differ between the snapshot and the restored database:

     ```
     BEGIN;
     CREATE TEMP TABLE users_snapshot (
       id uuid PRIMARY KEY, email text, role user_role, program_id uuid,
       is_active boolean, must_reset_password boolean,
       max_classification text, password_hash text
     ) ON COMMIT DROP;
     \copy users_snapshot FROM 'truenote-users-before-restore-<UTC date>.csv' WITH (FORMAT csv, HEADER)
     -- Review list: accounts present in both, with any authorization field changed after the restore point.
     SELECT u.id, s.email,
            u.role AS restored_role, s.role AS snapshot_role,
            u.program_id AS restored_program_id, s.program_id AS snapshot_program_id,
            u.is_active AS restored_is_active, s.is_active AS snapshot_is_active,
            u.must_reset_password AS restored_must_reset, s.must_reset_password AS snapshot_must_reset,
            u.max_classification AS restored_clearance, s.max_classification AS snapshot_clearance,
            u.password_hash IS DISTINCT FROM s.password_hash AS password_changed
     FROM users u JOIN users_snapshot s ON s.id = u.id
     WHERE (u.role, u.program_id, u.is_active, u.must_reset_password, u.max_classification, u.password_hash)
       IS DISTINCT FROM
           (s.role, s.program_id, s.is_active, s.must_reset_password, s.max_classification, s.password_hash)
     ORDER BY s.email;
     -- Accounts created after the restore point (absent from the restored database).
     SELECT s.id, s.email, s.role, s.program_id, s.is_active
     FROM users_snapshot s
     WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.id)
     ORDER BY s.email;
     ```

     Review each row of both lists against the incident's scope and timeline, and record the decision for each account in the evidence record. To explain a change, match it to the `security_events` exported in step 4.1.4: admin changes to an account appear as `http.security_mutation` events whose `resource_id` is `PATCH /api/admin/users/<id>`, `POST /api/admin/users/<id>/reset-password`, or `DELETE /api/admin/users/<id>`, with the actor and `occurred_at`. Only the `/api/admin` part is stored in lower case; the rest keeps the client's spelling, so match without regard to case. These events show who acted and when, not the new values. A signed-in password change appears as `POST /api/auth/change-password` with the account as actor. A reset-link password change appears as `POST /api/auth/reset-password` with no actor and no account id, so it cannot be tied to an account; treat a password change with no matching event as unexplained unless the account's owner confirms it. A change is legitimate only if a known, uncompromised actor made it outside the incident's window or scope, or its owner confirms it. Exclude from the copy every account whose change is attributable to the incident or cannot be explained, still inside the same transaction:

     ```
     CREATE TEMP TABLE reconcile_exclusions (
       id uuid PRIMARY KEY,
       action text NOT NULL CHECK (action IN ('keep_restored', 'deactivate'))
     ) ON COMMIT DROP;
     -- One row per excluded account, for example:
     -- INSERT INTO reconcile_exclusions VALUES ('<user id>', 'keep_restored');
     -- INSERT INTO reconcile_exclusions VALUES ('<user id>', 'deactivate');
     ```

     Use `keep_restored` when the incident explains the change and the restored, pre-damage values are known to be correct. Use `deactivate` when the change cannot be explained or the account itself may be under the attacker's control; the account stays blocked until its owner and an admin confirm it. For an account in the second list (created after the restore point), do not recreate it unless its creation is explained and legitimate. Account creation appears as `POST /api/admin/users` or `POST /api/admin/users/bulk` without the new account's id, so match it by actor and time.

     If a scheduled restore test rehearses this step, or a restore has no incident behind it, the review still runs, but every legitimate change is kept: `reconcile_exclusions` stays empty unless a change cannot be explained.

     Then apply the snapshot to every account that was not excluded, block the rest, remove sessions and reset tokens, and check the result:

     ```
     -- Users that existed when writes stopped and were not excluded: take every field from the snapshot.
     UPDATE users u
     SET role = s.role, program_id = s.program_id, is_active = s.is_active,
         must_reset_password = s.must_reset_password,
         max_classification = s.max_classification, password_hash = s.password_hash
     FROM users_snapshot s
     WHERE u.id = s.id
       AND NOT EXISTS (SELECT 1 FROM reconcile_exclusions x WHERE x.id = u.id)
       AND (s.program_id IS NULL OR EXISTS (SELECT 1 FROM programs p WHERE p.id = s.program_id));
     -- Users whose program was created after the restore point: block sign-in.
     UPDATE users u SET is_active = false
     FROM users_snapshot s
     WHERE u.id = s.id AND s.program_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM reconcile_exclusions x WHERE x.id = u.id)
       AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.id = s.program_id);
     -- Users deleted after the restore point came back: block sign-in.
     UPDATE users u SET is_active = false
     WHERE NOT EXISTS (SELECT 1 FROM users_snapshot s WHERE s.id = u.id);
     -- Excluded accounts marked deactivate: block sign-in, keep the other restored values.
     UPDATE users u SET is_active = false
     FROM reconcile_exclusions x
     WHERE x.id = u.id AND x.action = 'deactivate';
     DELETE FROM password_reset_tokens;
     DELETE FROM sessions;
     SELECT count(*) AS active_users_differing_from_snapshot
     FROM users u JOIN users_snapshot s ON s.id = u.id
     WHERE u.is_active
       AND NOT EXISTS (SELECT 1 FROM reconcile_exclusions x WHERE x.id = u.id)
       AND (u.role, u.program_id, u.is_active, u.must_reset_password, u.max_classification, u.password_hash)
       IS DISTINCT FROM
           (s.role, s.program_id, s.is_active, s.must_reset_password, s.max_classification, s.password_hash);
     ```

     If `active_users_differing_from_snapshot` is 0, run `COMMIT;`. Otherwise run `ROLLBACK;`, find the cause, and do not reopen production. A rollback discards the exclusions too; enter them again on the next attempt.

     Why each part is needed:
     - The restore brings back each user's role, active flag, program assignment, clearance, and password hash as of the restore point. Without the snapshot, a user deactivated, demoted, or moved out of a program after that point regains the withdrawn access, including another program's documents (program scoping is a security boundary), and a password changed after a compromise reverts to the known one. The exported `security_events` cannot replace the snapshot, because they do not record the resulting user state.
     - `DELETE FROM password_reset_tokens;` invalidates every reset and invitation link. A path A restore makes tokens that were consumed after the restore point unused again, and `POST /api/auth/reset-password` accepts any unused, unexpired token, sets a new password, and signs the holder in. An old link could then take over the account. A path B dump holds no tokens, so there the statement removes nothing. No route re-sends an invitation link to an existing account. A user who still needs to set a password has two options: request a new reset link from the sign-in page's forgot-password form (`POST /api/auth/forgot-password`, which emails a link only to an active account and only when `APP_BASE_URL`, `RESEND_API_KEY`, and `RESEND_FROM_EMAIL` are set; deployment.md records that email does not work on Railway yet), or ask an admin to reset the password from the admin Users page (`POST /api/admin/users/<id>/reset-password`). The admin reset returns a temporary password once, which the admin passes to the user outside Truenote, and forces a password change at the next sign-in.
     - `DELETE FROM sessions;` stops sessions revoked after the restore point from coming back. Everyone signs in again.
     - Users created after the restore point are missing from the restored database. Recreate only the accounts the review kept, through the admin Users page. Creating one user (`POST /api/admin/users`) sends no email: the admin sets a password or receives a generated temporary password once, passes it to the user outside Truenote, and the user must change it at the first sign-in. Bulk import (`POST /api/admin/users/bulk`) creates CSR accounts only, in the admin's current program, and emails each new account an invitation link to set its password; it creates nothing unless `APP_BASE_URL` is set and, in production, `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are set. Recreate managers and other non-CSR accounts one at a time.
     - Programs created after the restore point are missing too. Recreate them, then reassign and reactivate the users the second `UPDATE` blocked.
   - Using the exported `security_events`, re-apply every document revocation and retirement made after the restore point. The `document.lifecycle.*` events carry the document version, the previous and new lifecycle state, and the actor in their `details`. `web` is stopped, so use a local instance: from a repository checkout, start the API server and the Vite frontend as in section 5.4, with every section 3 isolation setting but `DATABASE_URL` set to production (`$PROD_DATABASE_URL`, PowerShell `$env:PROD_DATABASE_URL`). From your machine, production is reachable through the `pgvector` public TCP proxy that the template opens (deployment.md) `[CONFIRM: the pgvector variable that holds the public connection string, and the tunnel to use instead if containment closed the proxy]`. Sign in as a super user and revoke or retire each version from the admin Documents page. Revocation (`POST /api/documents/<versionId>/revoke`) and retirement (`DELETE /api/documents/<id>`) change only database rows and write their audit events; neither touches the bucket. Sign out when done, which deletes the session this created, and stop both servers.
   - Documents purged after the restore point come back as rows, but their files were deleted from the bucket. Revoke or retire them again the same way.
   - Documents uploaded after the restore point are gone from the database but their files are still in the bucket. After step 6, ask program owners to re-upload them. Do not run `sweep-orphans` until this is done.
6. Start `web` and `worker` only after steps 4 and 5 are complete, with the owner's go: deploy the currently deployed commit with the two `railway up` commands in deployment.md ("Deploying"), from a checkout at that commit. Dashboard Redeploy on the removed deployment may also work `[CONFIRM: whether Railway can redeploy a removed deployment]`. Wait for `SUCCESS` in `railway deployment list -s <service> --json`, then check that `/health` returns `{"ok":true}`, `railway logs -s web` shows `[api-server] listening on http://0.0.0.0:8080`, and `railway logs -s worker` shows `[worker] ready` (deployment.md). Then run the section 5.4 smoke test against production.
7. Record the end time. RTO is end time minus decision time.

### 4.5 Roll back a cutover

If production fails the checks or the smoke test after cutover:

1. Stop `web` and `worker` again (`railway down -s web -y`, `railway down -s worker -y`) and keep them stopped through this section, under the rules in section 4.4, step 2.
2. Path A: mount the previous volume again; Railway keeps it in the project, unmounted ([Railway: backups](https://docs.railway.com/reference/backups), accessed 2026-10-07). `[CONFIRM: the exact steps, for example railway volume detach and railway volume attach (Railway CLI: volume), and whether the swap is staged until Deploy like the restore]`
3. Path B: swap the databases back, in a shell in the `pgvector` container. First run the connection check from section 4.4, step 3, with `truenote_before_restore` in place of `truenote_restore`. Then swap:

   ```
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -c "ALTER DATABASE \"$POSTGRES_DB\" RENAME TO truenote_failed_restore"
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -c "ALTER DATABASE truenote_before_restore RENAME TO \"$POSTGRES_DB\""
   ```

   If the first rename succeeds and the second fails, no database has the name `$POSTGRES_DB`. Rename the first one back at once, then run the connection check again, close what it lists, and repeat the swap:

   ```
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -c "ALTER DATABASE truenote_failed_restore RENAME TO \"$POSTGRES_DB\""
   ```

4. Last resort: restore the dump taken in step 4.1.5 into a new database and swap it in, the same way as path B.
5. Before starting `web` and `worker` on the rolled-back database, get the incident lead's decision. That database holds the pre-restore state, including the damage the restore was meant to remove and the sessions and reset tokens that existed then. Remove those in one production psql session (`DELETE FROM password_reset_tokens; DELETE FROM sessions;`), contain the damage under the incident response plan, and only then start the services as in section 4.4, step 6.
6. Record the rollback in the evidence table and open an incident if one is not already open.

### 4.6 Clean up

1. After a scheduled test, stop the test API server and the Vite frontend dev server, close the SSH tunnel (Ctrl+C in its shell), and leave every `psql` session on the test service, so nothing holds a connection to it. An incident restore stopped the servers before the swap (section 4.4, step 3) and again after re-applying revocations (section 4.4, step 5).
2. Delete the test service once the evidence is recorded. It holds the restored production data, including password hashes, and costs money for as long as it runs (section 4.2). First check what is attached to it; each list must come back empty, and anything listed is deleted first:

   ```
   railway tcp-proxy list -s truenote-restore-test --json
   railway domain list -s truenote-restore-test --json
   railway volume list --json
   ```

   Delete a listed proxy with `railway tcp-proxy delete <proxy id> -s truenote-restore-test --yes` and a listed domain with `railway domain delete <domain> -s truenote-restore-test --yes`. `railway volume list` covers the whole project: only `pgvector-volume` may appear, and a volume mounted on `truenote-restore-test` is deleted with `railway volume delete --volume <volume id> --yes`; never delete `pgvector-volume`. Then remove the SSH config block and delete the service:

   ```
   railway ssh config remove --service truenote-restore-test
   railway service delete --service truenote-restore-test --yes
   ```

   `railway service delete` asks for `--2fa-code <code>` when the account has two-factor authentication and the run is non-interactive (Railway CLI 5.26 `railway service delete --help`). `[CONFIRM: whether deleting a service also deletes its proxy, domains, and volumes; the checks above do not rely on it]` Check that it is gone: `railway service list --json` no longer lists `truenote-restore-test`, and `railway volume list --json` lists only `pgvector-volume`. Then remove the password from the session (bash: `unset POSTGRES_PASSWORD`; PowerShell: `Remove-Item Env:POSTGRES_PASSWORD -ErrorAction SilentlyContinue`) and run the `railway link` command at the top of this runbook again, so the directory is no longer linked to the deleted service `[CONFIRM: that relinking without -s clears the linked service]`. After a path B incident restore, drop `truenote_before_restore` (and `truenote_failed_restore`, if it exists) once the incident is closed and the evidence is stored: `psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -c "DROP DATABASE truenote_before_restore"`. Both hold pre-restore production data, including password hashes and the damage. After a path A restore, the previous volume holds the same, plus every backup newer than the one restored; delete it only after the incident is closed and no newer backup is needed `[CONFIRM: owner decision on how long to keep it]`.
3. Delete the dump, its count record, and the export files from the volume, and local copies once they are stored in the restricted location.

## 5. Verification checks

### 5.1 Schema present

```sql
SELECT t AS missing_table
FROM unnest(ARRAY[
  'programs', 'users', 'sessions', 'documents', 'document_versions', 'chunks',
  'query_log', 'content_sources', 'security_events', 'security_rate_limits',
  'siem_delivery_outbox', 'schema_migrations'
]) AS t
WHERE to_regclass('public.' || t) IS NULL;
```

Pass: no rows. For a deeper check, run [`../compliance/pci/production-control-verification.sql`](../compliance/pci/production-control-verification.sql) against the target and compare its output with the last production run; it reads catalog definitions only.

### 5.2 Row counts in the expected range

Run the baseline query from step 4.1.3 against the target.

Pass, for a restore point in the past:

- each count is no higher than the production baseline, unless the record explains the excess by rows deleted after the restore point. A correct restore brings those rows back, so it can hold more rows than production holds now. Deletions that raise restored counts: users removed through `DELETE /api/admin/users/<id>`, and documents removed by a purge, which also removes their versions and chunks. Find them in the `security_events` exported in step 4.1.4, or for a scheduled test run against production: `SELECT occurred_at, action, resource_id FROM security_events WHERE occurred_at > '<restore point>' AND outcome = 'success' AND (action = 'document.purge' OR resource_id ILIKE 'DELETE /api/admin/users/%') ORDER BY sequence;`. `ILIKE` matches the path whatever letter case the client used after `/api/admin`. Count only rows with `outcome = 'success'`. The audit middleware also records refused and failed requests, with `outcome` set to `denied` (HTTP status 400 to 499) or `failure` (500 and above), and those deleted nothing. A purge writes its `document.purge` event in the same transaction as the delete, so that event exists only for a completed purge. A higher count that no recorded deletion explains fails;
- `chunks` can also differ because a version's chunks were replaced after the restore point. A rescan (`POST /api/documents/<versionId>/rescan`, allowed only for a quarantined or failed version) queues the version for ingestion again, and ingestion deletes the version's chunks and inserts a new set in one transaction (`artifacts/api-server/src/lib/ingestion/run.ts`). The re-ingest script (`scripts/src/reingest.ts`, run on Railway inside the `worker` container) does the same for every active, ready version, or one program's with `--program`, and the new set can have a different number of chunks. The target then holds the chunk set from before the replacement, which can be larger or smaller than production's, with no purge or user delete behind it. A rescan appears in `security_events` as an `http.security_mutation` event with `resource_id` `POST /api/documents/<versionId>/rescan` (match without regard to case) and `outcome = 'success'`. The re-ingest script writes no security event. Find both from the chunk timestamps instead: replaced chunks get a new `created_at`. Run against production:

  ```sql
  SELECT c.document_version_id, count(*) AS production_chunks,
         min(c.created_at) AS chunks_written_at
  FROM chunks c
  JOIN document_versions dv ON dv.id = c.document_version_id
  WHERE dv.uploaded_at <= '<restore point>'
  GROUP BY c.document_version_id
  HAVING min(c.created_at) > '<restore point>'
  ORDER BY chunks_written_at;
  ```

  Each row is a version that existed at the restore point and whose current chunks were all written after it: a rescan, a re-ingest, or a first ingestion that finished after the restore point. Run `SELECT document_version_id, count(*) FROM chunks WHERE document_version_id IN (<listed ids>) GROUP BY document_version_id;` on the target and record the per-version difference. The `chunks` count difference passes when these per-version differences, together with recorded deletions and uploads after the restore point, account for it. The same rows explain why the target holds more chunks than the "as of restore point" `chunks` count from step 4.1.3, which leaves out every replaced chunk;
- tables with timestamps match the "as of restore point" counts recorded in 4.1.3, or differ only by rows explained in the record;
- tables that only grow (`security_events`, `query_log`) are within 10% of their restore-point counts (proposed tolerance);
- `users`, `programs`, and `documents` are not zero unless production is also zero.

Pass, for path B: counts equal the count record of the dump actually restored, captured immediately before that dump's `pg_dump` and stored next to it (step 4.1.5). For a scheduled test that is the dump just taken; the step 4.1.3 baseline was taken earlier and can differ because of writes made in between. For an incident restore it is the earlier dump taken before the damage; production has had legitimate writes since, so neither the step 4.1.3 baseline nor any count taken now applies. Any difference from the count record is explained in the record by writes made between that count query and the start of `pg_dump`. A dump without a count record cannot pass this check: record that, and apply the restore-point rules above with the dump's start time as the restore point. `sessions` is empty on the target by design; the baseline query does not count it.

### 5.3 Security-event hash chain

No verifier for the hash chain exists in the repository. Until one is written, run these two read-only queries and record the results.

Link check (each event names the previous event's hash):

```sql
SELECT count(*) AS broken_links
FROM (
  SELECT sequence, previous_hash,
         lag(event_hash) OVER (ORDER BY sequence) AS prior_hash,
         min(sequence) OVER () AS first_sequence
  FROM security_events
) chain
WHERE sequence <> first_sequence
  AND previous_hash IS DISTINCT FROM prior_hash;
```

Pass: `broken_links = 0`.

Hash recompute (repeats the formula used by the `append_security_event` function in [`p0-p1-security-controls.sql`](./p0-p1-security-controls.sql)):

```sql
SET TimeZone = 'UTC';
SELECT count(*) AS hash_mismatches
FROM security_events se
WHERE se.event_hash <> encode(digest(concat_ws('|',
  COALESCE(se.previous_hash, ''), se.id::text, se.occurred_at::text,
  se.action, se.outcome,
  COALESCE(se.actor_user_id::text, ''), COALESCE(se.actor_email, ''),
  COALESCE(se.actor_role, ''), COALESCE(se.program_id::text, ''),
  COALESCE(se.resource_type, ''), COALESCE(se.resource_id, ''),
  COALESCE(se.request_id, ''), COALESCE(se.source_ip, ''),
  se.details::text), 'sha256'), 'hex');
```

Pass: `hash_mismatches = 0`. The hash covers `occurred_at` as text, so the result depends on the session time zone matching the one used when events were written. Events written before 2026-10-07 were written on the previous host and copied with their hashes (deployment.md, "Data copy"). `[CONFIRM: run once on production and confirm it returns 0 with TimeZone set to UTC; if not, find the time zone the application's connections used]`

Also confirm that the target's last event sequence matches the restore point: no event later than the restore point should exist on the target.

### 5.4 Application smoke test

Against the target, with the isolation settings from section 3. The API server serves the built frontend only when `NODE_ENV=production`, which section 3 forbids, so the test runs the Vite dev server in front of the API, as in local development. Run both from a repository checkout on a machine whose firewall does not expose port 3001: the API server listens on all interfaces (`artifacts/api-server/src/index.ts`) and will serve restored production data. The Vite dev server listens on localhost, because `artifacts/rag-app/vite.config.ts` sets no `server.host`.

Connection to the target. For a scheduled test, the API server reaches the test service through the SSH tunnel from section 4.2, step 5, which must stay open while the test runs; `TARGET_DATABASE_URL` holds that connection string. The test service has no public endpoint, and this test does not need one. For an incident restore, the target is the database `truenote_restore` on the `pgvector` server (section 4.4, step 3), reached the way section 4.4, step 5 reaches production; set `TARGET_DATABASE_URL` to that connection string with `truenote_restore` as the database. In the API server's shell, set `DATABASE_URL` from it (bash: `export DATABASE_URL="$TARGET_DATABASE_URL"`; PowerShell: `$env:DATABASE_URL = $env:TARGET_DATABASE_URL`).

1. In one shell, with `DATABASE_URL` set to the target, `RAG_STORAGE_DRIVER=memory`, `LOCAL_LOGIN_MODE=enabled`, and no `OIDC_*` or `S3_*` variable set (section 3), start the API server on port 3001:

   ```
   API_PORT=3001 pnpm --filter @workspace/api-server run dev
   ```

   PowerShell:

   ```
   $env:API_PORT = '3001'; pnpm --filter @workspace/api-server run dev
   ```

   Startup must log `[api-server] listening on http://0.0.0.0:3001`. Asking questions needs `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, and `COHERE_API_KEY` in this shell; set them one by one with the shell-table pattern, not with `railway run`.
2. In a second shell, start the frontend on port 5173, pointed at that API:

   ```
   API_PORT=3001 PORT=5173 pnpm --filter @workspace/rag-app run dev
   ```

   PowerShell:

   ```
   $env:API_PORT = '3001'; $env:PORT = '5173'; pnpm --filter @workspace/rag-app run dev
   ```

   `artifacts/rag-app/vite.config.ts` reads `API_PORT` to proxy `/api` to `http://localhost:3001` and `PORT` for its own port. Set both explicitly: each defaults to a different port when unset (API 5000, frontend 5173). The frontend needs no `DATABASE_URL`.
3. Use two origins:
   - API origin, `http://localhost:3001`: `GET http://localhost:3001/health` returns `{"ok":true}`. The Vite proxy forwards only `/api`, so `/health` on the frontend origin does not reach the API.
   - Browser origin, `http://localhost:5173`: every browser step below. Outside production the session cookie is not marked Secure, so plain HTTP works, and the API accepts sign-in and other mutations from the origin the Vite proxy forwards.
4. In the browser, sign in as a super user. The admin Documents, Users, and Security pages load.
5. Sign in as a CSR test account in a test program and ask a question whose answer is in that program's documents. The answer has at least one citation, and opening it shows the cited excerpt. `[CONFIRM: a synthetic test program, its documents, and a CSR test account exist in production; while production holds demo data only, the demo CSR account from DEMO_LOGIN_ACCOUNTS (deployment.md) can serve]`
6. Ask a question that only another program's documents can answer. The answer is a refusal.
7. Optional, costs provider tokens: `pnpm --filter @workspace/scripts run eval -- --limit 5` with `DATABASE_URL` set to the target. No new failures compared with the last production eval run.

`GET /api/admin/observability/security-audit` on the test instance reports `deliveryConfigured: false`; that is expected with the SIEM webhook unset.

After cutover, repeat the health check and steps 4 to 6 against production at `https://web-production-62818.up.railway.app` (or `https://truenote.org` once DNS points at Railway, deployment.md), with the worker running. If a SIEM receiver is configured by then, check that `GET /api/admin/observability/security-audit` shows the backlog draining; today the SIEM variables are not set on Railway (deployment.md), so it reports `deliveryConfigured: false` there too.

## 6. Object storage recovery

The bucket has no backup or versioning (section 1). If files are lost:

1. List affected versions: `SELECT dv.id, d.title, d.program_id, dv.source_url FROM document_versions dv JOIN documents d ON d.id = dv.document_id;` then check each key in the Railway bucket view, which `scripts/src/sweep-orphans.ts` names for this comparison, or with any S3 client given the bucket credentials and the endpoint `https://t3.storageapi.dev`.
2. Existing answers keep working, because they read parsed text and chunks from the database.
3. Restore missing files from the last bucket export `[CONFIRM: export location; none exists today]`, or ask program owners for the originals and upload them as new versions.
4. If the bucket itself was deleted, restore it within 52 hours from the project's Activity feed: select the change that removed it and click Restore ([Railway: storage buckets](https://docs.railway.com/guides/storage-buckets), accessed 2026-10-07).

## 7. Secrets recovery

1. For each variable, re-issue the value at its provider, then set it on each service that has it (deployment.md, "Variables"), passing the value on standard input, not on the command line:

   ```
   railway variable set <KEY> --stdin --skip-deploys -s worker
   railway variable set <KEY> --stdin -s web
   ```

   `--skip-deploys` batches changes without a redeploy; a `set` without it redeploys that service (deployment.md, [Railway CLI: variable](https://docs.railway.com/cli/variable), accessed 2026-10-07). Make the last change on each service without `--skip-deploys`, or deploy that service afterwards as in deployment.md, so both services run the new value `[CONFIRM: that the deploy a later set triggers includes earlier --skip-deploys changes]`. While `web` and `worker` are stopped for a restore, use `--skip-deploys` on every change (section 4.4, step 2).
2. Bucket credentials: `railway bucket credentials --reset -b truenote-storage` invalidates the existing credentials and creates new ones; `railway bucket credentials -b truenote-storage` prints them ([Railway CLI: bucket](https://docs.railway.com/cli/bucket), accessed 2026-10-07). Set `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` on both services as in step 1. Uploads, rescans, and purges fail between the reset and the redeploy. Do not paste the printed values into chat or tickets.
3. Database credentials: `[CONFIRM: the procedure to change the pgvector password so that DATABASE_URL_PRIVATE and the public connection string change; deployment.md documents none]`. Closing the `pgvector` public TCP proxy, an open decision in deployment.md ("After cutover"), stops a leaked public connection string from reaching the database `[CONFIRM: the Railway control that removes the proxy]`.
4. Run the smoke test in section 5.4 against production.

## 8. Test schedule (proposed)

- Take the weekly dump from section 2 until volume backups are on.
- Run a path B restore test (sections 4.1 to 4.3, 4.6, and 5) every 3 months, and after any change to backup settings, the `pgvector` image, or the schema-change process.
- Once the owner turns on volume backups, decide whether to rehearse path A. A rehearsal replaces production's volume, so it needs a maintenance window, the owner's go, `web` and `worker` stopped throughout, and the previous volume kept for rollback `[CONFIRM: owner decision to rehearse path A or to accept it untested]`. Until then path A is untested.
- Run the object-storage and secrets checks (sections 6 and 7, without changing production values) every 6 months, together with an incident-response tabletop exercise.

## 9. Restore test evidence record

Add one row per restore test or real restore. Keep raw query output in the restricted evidence location `[CONFIRM: location]`; put only the summary here.

| Date (UTC) | Operator | Reason (test / incident id) | Path (A / B) and target (temporary Railway service / scratch database / production after path A) | Restore point (UTC) | Measured RPO | Measured RTO | Checks passed (5.1 / 5.2 / 5.3 link / 5.3 recompute / 5.4) | Issues and follow-up |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
