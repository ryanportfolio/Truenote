# Truenote backup and restore runbook

**Status:** Proposed. One restore test has been run: path C on 2026-10-10, 7 min 12 s from decision to a cited answer (section 9). The recovery targets were approved by the owner on 2026-10-10 and live in [`contingency-plan.md`](./contingency-plan.md), section 3; recovery times stay provisional until a timed test meets them. Items marked `[CONFIRM: ...]` need an owner check before this runbook is relied on.
**Current state (2026-10-10):** the owner chose the backup design in section 1 on 2026-10-10 (an off-site copy in a separate Backblaze B2 account, weekly), which replaces the 2026-10-07 decisions to keep every copy inside the Railway project. The weekly encrypted off-site copy of the database, the bucket and the code (path C) runs since 2026-10-10: the `backup` service's first run, `20261010T120903Z`, passed `scripts/backup/check-offsite.mjs`, decryption included, and was restored in a test the same day (section 9). Railway volume backups on `pgvector` (daily, weekly and monthly) stay off until go-live (owner decision, 2026-10-10), so path A is **not yet usable**, and between weekly runs the newest database copy is up to 7 days old.
**Stage (owner statement, 2026-10-07):** pre-pilot. Truenote is being evaluated for adoption by the owner's employer and has not yet passed that company's security review. Production holds demo data only, and no CSRs use it.
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

This is the connection `scripts/railway-apply-sql.mjs` uses. Always pass `-h localhost -p 5432`: in this container `PGHOST` and `PGPORT` reference the public TCP proxy, closed on 2026-10-08, so they lead nowhere ([`.claude/reference/pitfalls.md`](../../.claude/reference/pitfalls.md), entry of 2026-10-07). `/var/lib/postgresql` is where the `pgvector-volume` volume is mounted (deployment.md), so files that `\copy` and `pg_dump` write to `truenote-dumps` stay on the volume. Copy each one to your machine, then delete it from the volume:

```
MSYS_NO_PATHCONV=1 railway volume files --volume pgvector-volume download /truenote-dumps/<file> ./<file>
MSYS_NO_PATHCONV=1 railway volume files --volume pgvector-volume delete /truenote-dumps/<file>
```

In PowerShell, drop `MSYS_NO_PATHCONV=1` (section "Shells"). The `--volume` option goes before the subcommand ([Railway CLI: volume](https://docs.railway.com/cli/volume), accessed 2026-10-07). That page does not say whether a remote path is relative to the volume or to its mount point. It is relative to the volume, whose root is the mount point: on 2026-10-08 `railway volume files --volume pgvector-volume list / --json` listed `/data` and `/lost+found`, the folders the container sees under `/var/lib/postgresql`, so `/truenote-dumps/` is the folder created above. It also says `files delete` refuses to run when an AI agent invokes it, so a person runs it. Files left on the volume hold production data, including password hashes, and once volume backups are on they are copied into every later backup.

## 1. What holds data and what backs it up

Provider statements below were read on 2026-10-07. Re-read the cited page before each restore test; providers change these features.

| Data | Where it lives | What backs it up | Gaps |
|---|---|---|---|
| All application rows: programs, users, sessions, documents, document versions, parsed text, chunks and embeddings, query log, security events, security monitor cursor and worker heartbeat, settings, the schema ledger `schema_migrations`, and the job queue (`pgboss` schema) | Service `pgvector`, image `pgvector/pgvector:pg18`, volume `pgvector-volume` mounted at `/var/lib/postgresql` (deployment.md) | **Weekly off-site copy since 2026-10-10** (path C; the first run, `20261010T120903Z`, passed the off-site check and was restored in a test the same day, section 9). No Railway volume backup: the Railway API lists no backup schedule and no backup for `pgvector-volume` (2026-10-10). Two copies were chosen by the owner on 2026-10-10 (destination and weekly cadence): Railway volume backups, daily, weekly and monthly (path A), and the weekly off-site copy described in the next paragraph (path C). Volume backups stay off while production holds demo data only, and are turned on at go-live, the first real customer data (owner decision, 2026-10-10), with one command: `node scripts/railway-volume-backups.mjs --enable` sets the three schedules and takes one manual backup; without a flag it prints the schedules and backups; `--backup-now` takes one manual backup; `--disable` removes the schedules and leaves existing backups to expire. Railway CLI 5.26 has no backup commands, so the script uses Railway's API (`volumeInstanceBackupScheduleUpdate`, `volumeInstanceBackupCreate`) with the token of `railway login`. Status mode was run on 2026-10-10; the other modes have not run yet. Until then the weekly off-site copy is the only scheduled database copy, so the newest one can be up to 7 days old; an operator dump (section 4.1, step 5) gives a newer one. **Off-site copy:** the `backup` cron service (`Dockerfile.backup`, `scripts/backup/run-backup.sh`) connects as the read-only role `truenote_backup` (`lib/db/sql/0014_backup_role.sql`), takes a dump with the flags of section 4.1, step 5, plus its count record, every object in `truenote-storage` and a bundle of the code repository, encrypts all of it as one object with `age` to the owner's public key, and uploads it to a bucket in a Backblaze B2 account that is separate from Railway, with a manifest written only after the run succeeded. The job holds only the public key and a B2 key that can write but not read or delete; Object Lock keeps each uploaded version from being deleted for 35 days; the write key can still upload a newer version under the same name, which a plain read then returns, so the weekly check fails when a key gets a second version with different content or is hidden before its lifecycle age, and the restore script can read the versions current at an earlier time (section 4.7, step 5). The private key is held by the owner outside Railway and B2, passphrase-protected. Railway volume backups, **once turned on**, run on schedules: "Daily - Backed up every 24 hours, kept for 6 days", "Weekly - Backed up every 7 days, kept for 27 days", "Monthly - Backed up every 30 days, kept for 89 days"; one volume can have several schedules, and "Manual backups are limited to 50% of the volume's total size". A restore stages "a new volume mounted to the same location as the original volume"; "The previous volume will be retained but has been unmounted from the service"; the restore completes when you click Deploy. "Backups can only be restored into the same project + environment." "Wiping a volume deletes all backups." Backups are billed like volumes, only for "the data exclusive to them". ([Railway: backups](https://docs.railway.com/reference/backups), accessed 2026-10-07.) The page describes no point-in-time restore. | No volume backup until the owner turns schedules on; until then the weekly off-site copy is the only scheduled copy. Volume backups are lost with the volume or the Railway project; the off-site copy is not, but it is at most weekly, so after a project loss up to 7 days of data are gone (contingency plan, section 3). A volume backup restores only onto the `pgvector` service itself, so it cannot be checked on a separate target before it replaces production data (section 3, rule 1). Railway documents point-in-time recovery for Postgres through WAL archiving that its own Postgres image performs ([Railway: point-in-time recovery](https://docs.railway.com/volumes/point-in-time-recovery), accessed 2026-10-07); `pgvector` runs `pgvector/pgvector:pg18`, which that page does not mention. Railway's CLI reference states that "PITR and HA require an official Railway PostgreSQL image": `ghcr.io/railwayapp-templates/postgres-ssl` or `ghcr.io/railwayapp-templates/postgres-ha/postgres-patroni` ([Railway CLI: postgres](https://docs.railway.com/cli/postgres), accessed 2026-10-07). Point-in-time recovery is therefore not available for `pgvector` while it runs `pgvector/pgvector:pg18`. A Railway guide words the retention as "kept for 1 month" and "kept for 3 months" and says restoring "removes any newer backups" ([Railway: back up and restore Postgres](https://docs.railway.com/guides/postgres-backups-restores), accessed 2026-10-07), while the reference page says newer backups stay on the previous volume. The reference page is current: Railway changed it on 2026-09-04 to "correct retention, restore, PITR backup type, bucket window, and log retention values", replacing "kept for 1 month", "kept for 3 months", and "Restoring a backup will remove any newer backups" with the text quoted above ([railwayapp/docs commit a9ec0a7, #1330](https://github.com/railwayapp/docs/commit/a9ec0a7500)). The guide was last changed on 2026-07-30 and still carries the old wording ([its history](https://github.com/railwayapp/docs/commits/main/content/guides/postgres-backups-restores.md), read 2026-10-08). A volume backup of the running `pgvector` server should restore like a server that lost power: Postgres replays its write-ahead log at startup. Railway does not state this, so it rests on these facts: Railway backups are "incremental and Copy-on-Write" snapshots (Railway: backups); Railway built volume snapshots on ZFS ("We explored both LVM/devicemapper and ZFS to enable this capability, and eventually settled on ZFS", [Railway blog, launch week 01](https://blog.railway.com/p/launch-week-01-regions), 2023); the `pgvector` volume is the block device `/dev/zd7328`, the name Linux gives a ZFS volume, with an ext4 file system on it (`/proc/mounts` in the container, 2026-10-08); and the data directory `/var/lib/postgresql/data/pgdata`, including `pg_wal`, sits on that one volume (`SHOW data_directory`, `df`, 2026-10-08). PostgreSQL says a frozen snapshot of the volume "will work even while the database server is running" and that the server "will think the previous server instance crashed and will replay the WAL log", provided data files and WAL are captured by one simultaneous snapshot ([PostgreSQL 18: file system level backup](https://www.postgresql.org/docs/18/backup-file.html), accessed 2026-10-08). Not verified: no Truenote backup has been restored, Railway does not document that a backup snapshot is atomic, and the owner accepted path A untested (section 8). Railway's Postgres guide recommends volume backups, point-in-time recovery, and logical dumps together for production. |
| Uploaded source files (PDF, DOCX, images, text) | Bucket `truenote-storage`, S3-compatible, endpoint `https://t3.storageapi.dev`, keys `uploads/<sha256>-<name>` (deployment.md). Each document version's key is in `document_versions.source_url`. | **Weekly off-site copy since 2026-10-10:** every object goes into the weekly off-site copy (row above), after the dump, so each file the dump references is in the same copy. Railway: "Railway doesn't currently offer automatic backups or snapshots for buckets"; "Object versioning", "Object locks", and "Bucket lifecycle configuration" are listed as not yet supported. A deleted bucket "stays restorable for 52 hours, after which every object in it is destroyed." Buckets "run on Tigris's metal servers". ([Railway: storage buckets](https://docs.railway.com/guides/storage-buckets), accessed 2026-10-07.) The off-site copy is the only backup of the bucket. | A deleted or overwritten object can be recovered only as it was in the latest weekly copy, up to 7 days old; a file added and lost within the same week cannot be recovered, and a database restore does not bring files back. The Railway CLI offers no bucket backup or versioning either: `railway bucket --help` (CLI 5.26) lists only `list`, `create`, `delete`, `info`, `credentials`, and `rename`. The 2026-10-07 decision to copy the bucket into a second bucket in the same project, which would be lost together with the project, is replaced by the off-site copy (owner, 2026-10-10). Truenote reads the original file only during ingestion and rescan. Answers, citations, and previews use the parsed text and chunks in the database. Losing a file blocks rescans of that version; it does not break existing answers. Eight objects the database references were not copied to Railway on 2026-10-07, so rescans of those versions already fail (deployment.md, "Data copy"). |
| Secrets (provider keys, bucket credentials, sign-in and email settings) | Railway service variables on `web` and `worker` (deployment.md, "Variables"); the owner keeps the source values outside git (deployment.md) | Not backed up by Truenote. Each value can be re-issued at its provider; bucket credentials can be reset (section 7). | The owner keeps the source file encrypted and backed up (owner statement, 2026-10-07).. Keep a list of variable names and where each is issued, not the values. Names used by the code are listed in the incident response plan, section 5.2. |
| Application code and database DDL | GitHub repository. Baseline DDL: the files under `docs/security/`, already in the database copied on 2026-10-07. Later changes: numbered files in `lib/db/sql/`, recorded in `schema_migrations` when applied (deployment.md, "Schema changes"). | Git history on GitHub, local clones, and a `git bundle` of every branch in each off-site copy (once the `backup` service runs). Railway keeps earlier deployments (deployment.md, "Deploying"). | A database restore does not roll back code, and a code rollback does not restore the database. |

## 2. Recovery targets

The owner approved recovery targets per scenario on 2026-10-10; they are kept in one place, [`contingency-plan.md`](./contingency-plan.md), section 3. In short: database volume failure, 24 hours of data and 8 hours to recover (path A, or path C as fallback); bucket loss, single-file loss and loss of the Railway account or project, up to 7 days of data (the off-site copy is weekly) and 1, 2 and 3 business days to recover; secrets, 4 hours. Every recovery time is provisional until a timed test meets it. Until the copies in section 1 run, the RPO of every scenario is the time since the last operator dump.

Operator dumps (section 4.1, step 5) are still taken immediately before each risky change: applying a `lib/db/sql/` file, a bulk user import, a re-ingest, a document purge, or a deploy that changes ingestion or data handling. Once volume backups are on, a manual Railway backup (`node scripts/railway-volume-backups.mjs --backup-now`) taken immediately before the change serves instead, because it restores the volume as it was a moment before. Take every operator dump with section 4.1, step 5, so each gets its count record, and keep each dump's count record and SHA-256 next to the dump.

Measure RPO as the gap between the chosen restore point and the last good write that the restore discarded. Measure RTO from the recorded decision time to the first passing smoke test against the recovered service.

## 3. Safety rules for any restore

1. **Restore to a non-production target first.** Railway has one environment for Truenote, `production`, and no development database (deployment.md), so a non-production target is one of these:
   - for scheduled tests from the off-site copy (path C), a separate temporary Railway project in another region, created for each test and deleted when its receipt is written (section 4.7). It has its own private network and no variable, reference or credential of production; it reads only the off-site copy, with the read-only key. This is the proposed target for scheduled tests (2026-10-10);
   - a temporary Railway service in the `truenote` project, created from the `pgvector/pgvector:pg18` image for each scheduled test and deleted when its evidence is recorded (sections 4.2 and 4.6). It runs its own Postgres server with its own password and no volume, separate from the `pgvector` service and `pgvector-volume`. It sits in the `production` environment, the only one, and so on production's private network (accepted by the owner, 2026-10-07);
   - for an incident restore from a dump (path B), a separate scratch database inside the `pgvector` server (section 4.4). It is not production until it is renamed into place, but it shares the production server's disk, memory, and credentials (accepted by the owner, 2026-10-07). `pgvector-volume` has room: on 2026-10-07 `df -h /var/lib/postgresql` showed 46G free and the database was 12 MB.

   A volume-backup restore (path A) has no non-production target: Railway restores only into the same project and environment and mounts the restored volume on the `pgvector` service ([Railway: backups](https://docs.railway.com/reference/backups), accessed 2026-10-07). For path A the rule becomes: take a dump first (section 4.1, step 5), keep `web` and `worker` stopped, run section 5 against the restored production database before either starts, and keep the previous volume for rollback (section 4.5). Record in the evidence table which form of this rule applied.
2. **Isolate the test app instance.** When running Truenote against a restored target:
   - from a repository checkout, start only the API server (`pnpm --filter @workspace/api-server run dev`) and, for the smoke test, the Vite frontend dev server (section 5.4). Do **not** start the worker (`pnpm --filter @workspace/scripts run worker`, the process the Railway `worker` service runs, `scripts/src/worker.ts`): it processes queued ingestion and evaluation jobs, sends files to LandingAI and OpenAI, and writes to object storage;
   - set `RAG_STORAGE_DRIVER=memory` and leave every `S3_*` variable unset. `getObjectStorage()` (`artifacts/api-server/src/lib/storage/object-storage.ts`) selects the in-memory store only for `memory`; any other value, unset included, selects the S3 adapter, which with production's `S3_*` values can read and delete objects in `truenote-storage`;
   - leave `SECURITY_ALERT_EMAIL` unset, so a restored worker's security monitor writes alerts to its own log instead of emailing the owner about test activity (`docs/security/monitoring.md`). The restored `security_monitor_state` row carries production's cursor, so the monitor starts after the last event production processed;
   - leave `RESEND_API_KEY`, `BOOTSTRAP_SUPER_USER_*`, and `DEMO_LOGIN_ACCOUNTS` unset, and do not set `NODE_ENV=production`. Do not run the test instance from the Railway image, which sets `NODE_ENV=production` (`Dockerfile.railway`), and do not start it with `railway run`, which runs a local command with the variables of the linked Railway environment and so brings in production's `DATABASE_URL`, `S3_*`, `RESEND_*`, and `DEMO_LOGIN_ACCOUNTS` (deployment.md, "Variables");
   - leave every `OIDC_*` variable unset and set `LOCAL_LOGIN_MODE=enabled`. `getOidcConfig()` (`artifacts/api-server/src/lib/auth/oidc.ts`) turns company SSO on when `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, and an `OIDC_STATE_SECRET` of at least 32 characters are set, and when `LOCAL_LOGIN_MODE` is unset it then defaults the password login to `break_glass`. In `break_glass` mode `POST /api/auth/login` (`artifacts/api-server/src/routes/auth.ts`) checks the password and then refuses every account except a `super_user` with HTTP 403 `Use company SSO to sign in.`; a super user's sign-in is recorded as `auth.break_glass.login`. In `disabled` mode it refuses every account and the sign-in page hides the password field. OIDC is not set on Railway today (deployment.md), but a shell that inherits OIDC values, for example through `railway run` after OIDC is configured, would block the CSR password sign-in that section 5.4 needs. SSO from the test instance does not work either: `GET /api/auth/oidc/start` sends the browser to the identity provider with the production `OIDC_REDIRECT_URI`, so the provider returns it to the production deployment, whose callback rejects it because the state cookie was set on the test origin. Without the five SSO values SSO is off and every active account can use its password; `LOCAL_LOGIN_MODE=enabled` keeps the password field on the sign-in page even when the shell inherited `LOCAL_LOGIN_MODE=disabled`. Before starting the test servers, in each shell:

     ```
     unset OIDC_ISSUER_URL OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_REDIRECT_URI OIDC_STATE_SECRET OIDC_REQUIRED_ACR OIDC_REQUIRE_MFA OIDC_ALLOWED_DOMAINS && export LOCAL_LOGIN_MODE=enabled
     ```

     PowerShell:

     ```
     Remove-Item Env:OIDC_* -ErrorAction SilentlyContinue; $env:LOCAL_LOGIN_MODE = 'enabled'
     ```

     To test SSO itself, register a separate test client at the identity provider whose redirect URI is the test origin's callback (`http://localhost:5173/api/auth/oidc/callback`, which the Vite proxy forwards to the API), set the five `OIDC_*` values to that client, and still set `LOCAL_LOGIN_MODE=enabled` so the CSR password sign-in keeps working. Outside `NODE_ENV=production` the code accepts `http` issuer and redirect URLs. No identity provider is connected today: OIDC is not set on Railway (deployment.md), and Truenote has no customer whose provider it would use (owner statement, 2026-10-07). Check this when SSO is first configured. Never reuse the production client: its redirect URI points at production;
   - never run `sweep-orphans` or the document purge against a restored target. `scripts/src/sweep-orphans.ts` deletes nothing today: it lists the keys the connected database references. It stays on this list because a version that deletes unreferenced keys, which its comments plan, would delete files production still needs when pointed at a restore. The purge deletes the document's files from the bucket.
3. **Keep connection strings and variable values out of shell history, chat, tickets, and this repository.** Paste them into an environment variable for the session only.
4. **Record times in UTC** as you go. The evidence table needs them.
5. **Keep sensitive files encrypted, and only as long as the work needs them.** Exports and dumps copied to your machine hold production data, including password hashes. Never put them in this repository, chat, tickets, or email. Encrypt each one with 7-Zip (installed at `C:\Program Files\7-Zip\7z.exe`), in PowerShell, from the folder that holds the file:

   ```
   & "C:\Program Files\7-Zip\7z.exe" a -t7z -mhe=on -p "<name>.7z" <file>
   ```

   `-p` with no value asks for the password at the prompt, so it stays out of shell history; `-mhe=on` also encrypts the file names. Delete the plain file. Delete the archive when the restore test ends, or for an incident once the incident's retrospective is done (incident response plan, section 8) (section 4.6). The one exception is a dump kept as a backup (section 4.1, step 5). There is no standing archive of test or incident files (owner decision, 2026-10-07): the record of a restore test is its row in section 9, and the record of an incident is its incident record (incident response plan, section 10).

## 4. Restore procedure

Paths:

- **Path A, volume backup** (not yet usable: backups are off). Restores the `pgvector` volume from a Railway backup.
- **Path B, operator dump** (available today). Restores a `pg_dump` taken by the operator: into a temporary Railway service for a scheduled test (section 4.2), or into a scratch database on the `pgvector` server for an incident (section 4.4).
- **Path C, off-site copy** (running weekly since 2026-10-10; first restore test 2026-10-10, section 9). Restores one weekly encrypted copy from Backblaze B2: into a separate temporary Railway project for a scheduled test or a rebuild after account or project loss (section 4.7), or, for an incident on a working project, into a scratch database on the `pgvector` server as in path B (the decrypted `db.dump` is a path B dump with its own count record).

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

   `program_id` is the user's program assignment (the only one; NULL only for `super_user`), and `max_classification` is the user's clearance for document classification. The file holds password hashes. Copy all three files to your machine and delete them from the volume (section "Shells"), keep them encrypted (section 3, rule 5), and delete them once the incident's retrospective is done (incident response plan, section 8) (section 4.6).

   When the cutover in section 4.4 stops writes, run all three exports in this step again and use the later files for reconciliation, so changes made while the target was being verified are not lost.
5. Take a logical dump of production for every path B restore, including scheduled tests; before every path A restore, as a last-resort rollback copy; and on the cadence in section 2. The command differs from the 2026-10-07 data copy (deployment.md, "Data copy") in two ways, both because the application connects as the least-privilege role `truenote_app` (`lib/db/sql/0007_app_runtime_role.sql`), which cannot create the `pgboss` schema or grant itself access: the dump keeps privileges (no `--no-acl`), and it keeps the `pgboss` schema with its queue and version rows but without job rows. It is `pg_dump` 18 inside `pgvector`, custom format, `--no-owner`, without the `_system` schema and without the rows of `sessions`, `password_reset_tokens`, `pgboss.job` (including its per-queue partitions) and `pgboss.archive`. Excluding `_system` changes nothing when that schema does not exist.

   The dump and its count record are written to `pgvector-volume`, the production volume. For a scheduled test they are the one write the test makes to it; both files are deleted from the volume after section 4.2 has restored the dump, and no later than section 4.6, step 3. Before writing them, check that the volume has room. Inside the container, `df -h /var/lib/postgresql` shows the free space on the volume; in the production psql session, `SELECT pg_size_pretty(pg_database_size(current_database()));` shows the database size. Continue only when the free space is larger than the database size; a custom-format dump of the database is smaller than the database itself. `df` reports the volume's size limit: on 2026-10-07 `df -h /var/lib/postgresql` in the container showed `Size 46G`, `Used 70M`, `Avail 46G` for the volume that `railway volume list --json` lists with `"sizeMB": 50000`. `railway metrics -s pgvector --volume` also shows volume metrics (Railway CLI 5.26 `railway metrics --help`).

   First, in the production psql session, immediately before the dump, write the dump's count record: the baseline query from step 3, run again with its output sent to a file next to the dump. Enter `\o truenote-prod-<UTC date>-counts.txt`, paste the step 3 query, then enter `\o` to send output back to the screen. Every dump gets a count record: the weekly dumps, the dumps before risky changes (section 2), and the dumps taken for a test or before a restore. A restore from a dump is checked against that dump's own count record (section 5.2). The step 3 baseline does not serve: writes made between step 3 and the dump change production counts, and an incident restore uses a dump taken long before. `pg_dump` exports one consistent snapshot taken when it starts, so only writes made between the count query and that start can still cause a difference. Then leave `psql` (`\q`) and, still inside the container:

   ```
   pg_dump -h localhost -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --exclude-schema=_system --exclude-table-data-and-children=pgboss.job --exclude-table-data=pgboss.archive --exclude-table-data=public.sessions --exclude-table-data=public.password_reset_tokens --file=/var/lib/postgresql/truenote-dumps/truenote-prod-<UTC date>.dump
   sha256sum /var/lib/postgresql/truenote-dumps/truenote-prod-<UTC date>.dump
   ```

   Copy the dump and its count record to your machine (section "Shells") and record the dump's SHA-256. An operator dump taken before a risky change is kept until the change is checked and the next off-site copy has run, then deleted from the volume and your machine. While you keep it, keep it encrypted (section 3, rule 5), never only on your machine's removable media. A dump taken only for a scheduled test is not kept: delete it from the volume and from your machine when the test ends (section 4.6). For a scheduled test, delete them only after section 4.2 has restored the dump: that restore reads the file on the volume. An incident restore uses an earlier dump taken before the damage; section 4.4 uploads that one back to the volume, and section 5.2 compares the restore with that dump's count record.

   What the dump leaves out: sessions and reset tokens, so everyone signs in again after a restore from it; and the `pgboss` jobs. The restore brings back the `pgboss` tables, its schema version and its queue definitions with no jobs in them, so `web` and `worker` start against it without creating anything (the application role could not). Ingestion or evaluation jobs queued at dump time are lost; a version that was waiting on one needs a new upload. Such a version is left inactive in one of these states: queued and not yet started (`lifecycle_state = 'submitted'`, `parse_status = 'pending'`, set by the upload route in `artifacts/api-server/src/routes/documents.ts`), or started (`parse_status = 'parsing'` with `lifecycle_state = 'scanning'` while the scan runs, then `'parsing'` after it, set by the worker in `artifacts/api-server/src/lib/ingestion/run.ts`). Rescan accepts only `quarantined` or `failed` versions (`POST /api/documents/<versionId>/rescan`), so none of these can be rescanned. List them after a restore with `SELECT id, lifecycle_state, parse_status FROM document_versions WHERE lifecycle_state IN ('submitted', 'scanning', 'parsing');`. On 2026-10-08 production held none.

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

   `--image` creates the service from an image and `--variables` sets `"{key}={value}"` pairs on it (Railway CLI 5.26 `railway add --help`). Shell history keeps the variable name, not the value; the value is on the `railway` process's command line while it runs. The server's user and database are both `postgres`, the image defaults when `POSTGRES_USER` and `POSTGRES_DB` are unset. `pgvector/pgvector` is built `FROM postgres:$PG_MAJOR-$DEBIAN_CODENAME` ([pgvector Dockerfile](https://github.com/pgvector/pgvector/blob/master/Dockerfile), accessed 2026-10-07), so the official image's defaults apply: without `POSTGRES_USER` "the default user of `postgres` will be used", and without `POSTGRES_DB` "the value of `POSTGRES_USER` will be used" ([Docker Hub: postgres](https://hub.docker.com/_/postgres), accessed 2026-10-07). `railway add` also links the new service to the current directory ([Railway CLI: add](https://docs.railway.com/cli/add), accessed 2026-10-07). Every Railway command in this runbook that targets a service passes `-s`, so none of them falls through to the test service.

   The service has no volume. Its data lives on the container's ephemeral storage and is gone when the service is deleted; a restart or redeploy also loses it, and the restore must then be repeated. Ephemeral storage per service is 1 GB on the Trial and Free plans and 100 GB on Hobby and Pro (Railway: pricing plans). The workspace is on the Pro plan: on 2026-10-07 the Railway API returned `plan: "PRO"` for the workspace that owns `truenote`, with a container disk limit of `100 GB` (`workspace.subscriptionPlanLimit.containers.diskDescription`). The production database was 12 MB on 2026-10-07 (`SELECT pg_size_pretty(pg_database_size(current_database()))` in the production psql session), so it fits; check the size again before each test. The image declares `VOLUME /var/lib/postgresql` ([docker-library/postgres: 18/bookworm/Dockerfile](https://github.com/docker-library/postgres/blob/master/18/bookworm/Dockerfile), accessed 2026-10-07), and Railway's volume pages do not say whether that instruction creates a volume `[CONFIRM: on the first test, that Railway attaches no volume to a service created from this image]`; section 4.6 checks for one before deleting the service.

   Right after creating it, check that the service has no TCP proxy, so it is never reachable from the internet during the test:

   ```
   railway tcp-proxy list -s truenote-restore-test --json
   ```

   It must list no proxy. If it lists one, delete it with `railway tcp-proxy delete <proxy id> -s truenote-restore-test --yes` and run the list again before going on.
3. Wait until the server is up: `railway deployment list -s truenote-restore-test --json` shows `SUCCESS`, and `railway logs -s truenote-restore-test` shows `database system is ready to accept connections` `[CONFIRM: that the first deployment starts with POSTGRES_PASSWORD set; if the log says the superuser password is not specified, run railway redeploy -s truenote-restore-test -y]`. Read the service's private DNS name with `railway private-network status -s truenote-restore-test`. The commands below assume `truenote-restore-test.railway.internal`, Railway's `SERVICE_NAME.railway.internal` form ([Railway: private networking](https://docs.railway.com/networking/private-networking), accessed 2026-10-07).
4. Restore from inside the production `pgvector` container, over Railway's private network. The dump does not leave Railway for this: the restore reads the file that step 4.1.5 wrote to `pgvector-volume`. Print the password once to paste at the prompts (bash: `printf '%s\n' "$POSTGRES_PASSWORD"`; PowerShell: `$env:POSTGRES_PASSWORD`), open a shell in the container (section "Shells"), and run:

   ```
   pg_isready -h truenote-restore-test.railway.internal -p 5432
   psql -h truenote-restore-test.railway.internal -p 5432 -U postgres -d postgres -X -W -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto; DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'truenote_app') THEN CREATE ROLE truenote_app NOLOGIN; END IF; END \$\$;"
   pg_restore -h truenote-restore-test.railway.internal -p 5432 -U postgres -d postgres -W --no-owner --single-transaction --exit-on-error /var/lib/postgresql/truenote-dumps/truenote-prod-<UTC date>.dump
   ```

   `pg_isready` must report `accepting connections` before the other two run. The extensions are the ones the schema uses (deployment.md: `vector`, `pg_trgm`, `pgcrypto`). Roles belong to the server, not the dump, so the test server gets a `truenote_app` role without a login before the restore; without it the dump's grants to that role fail and `--exit-on-error` stops the restore. `-W` makes `psql` and `pg_restore` ask for the password, so a `PGPASSWORD` in the production container's environment, if one is set, is not used for the test server. `-h` names the test service on every command: `localhost` in this container is production. Run the SQL checks in section 5 in the same container with `psql -h truenote-restore-test.railway.internal -p 5432 -U postgres -d postgres -X -W`.
5. Give the section 5.4 test instance a connection through an SSH tunnel from your machine to the test service. Railway SSH forwards local ports to "the container's loopback and your project's private network", and dials the connection from inside the container ([Railway CLI: ssh](https://docs.railway.com/cli/ssh), accessed 2026-10-07). Write an OpenSSH config block for the service, then open the tunnel in a separate shell and leave it running through section 5.4:

   ```
   railway ssh config --service truenote-restore-test --alias truenote-restore-test -i <private key>
   ```

   ```
   ssh -N -L 127.0.0.1:5433:127.0.0.1:5432 truenote-restore-test
   ```

   `<private key>` is the private key that `railway ssh` uses: it prints `Using SSH key from file <path>.pub`, and the private key is that path without `.pub`. Without `-i` the block has no `IdentityFile` line (CLI 5.26 `railway ssh config --dry-run`), so `ssh` falls back to its default key names. The same page says a service without a domain uses its service instance ID as the SSH user. The tunnel works for a service without a domain: on 2026-10-08 a block written this way for `pgvector`, which has none, carried a tunnel to its port 5432, and a PostgreSQL `SSLRequest` sent through it was answered `N` (no TLS) by the server. The target's connection string uses user `postgres`, the password above, host `127.0.0.1`, port `5433`, and database `postgres`. Set it as `TARGET_DATABASE_URL` with the pattern in the shell table.

   Do not open a TCP proxy on the test service instead. A proxy is a public endpoint, and Railway's TCP proxy page does not say whether the traffic is encrypted ([Railway: TCP proxy](https://docs.railway.com/networking/tcp-proxy), accessed 2026-10-07), and the image does not serve TLS: PostgreSQL's `ssl` setting defaults to `off` ([PostgreSQL 18: connections and authentication](https://www.postgresql.org/docs/18/runtime-config-connection.html), accessed 2026-10-07), the image's `docker-entrypoint.sh` does not turn it on ([docker-library/postgres: 18/bookworm](https://github.com/docker-library/postgres/tree/master/18/bookworm), accessed 2026-10-07), and `SHOW ssl;` on the production `pgvector` server returned `off` on 2026-10-07. A proxy would carry every query and every restored row unencrypted across the internet. The password itself is not sent: remote logins use SCRAM-SHA-256 (on production, `pg_hba_file_rules` lists `host all all all scram-sha-256`, read 2026-10-07). If the tunnel fails, stop and record the failure; open a proxy only with the owner's go, create it with `railway tcp-proxy create --port 5432 -s truenote-restore-test`, connect to the domain and port that `railway tcp-proxy list -s truenote-restore-test` prints, and delete it at the end of section 5.4. Never point a test at production's `pgvector` proxy.

Scheduled tests do not use a scratch database inside the production `pgvector` server, the target of Railway's restore drill ([Railway: back up and restore Postgres](https://docs.railway.com/guides/postgres-backups-restores), accessed 2026-10-07): it would put a second copy of the data on production's disk and load production's server at every test. Section 4.4 uses that target only for incidents.

Path B tests Truenote's own dump, not a Railway backup. It restores the state at dump time, not a chosen point in the past, so it cannot show that a backup is recoverable. Record which path you used. Path A is untested, and the owner decided on 2026-10-07 not to rehearse it (section 8).

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

   `railway down` removes the latest successful deployment; the service is not deleted and can be deployed again with `railway up` ([Railway CLI: down](https://docs.railway.com/cli/down), accessed 2026-10-07). The page does not say whether an older deployment takes over. Railway keeps one deployment per service by default: "if you trigger a new deploy, the previous version will be stopped and removed after the new version deploys" ([Railway: deployment teardown](https://docs.railway.com/deployments/deployment-teardown), accessed 2026-10-07). On 2026-10-07 `railway deployment list --json` showed one `SUCCESS` deployment each for `web` and `worker`, and every older one `REMOVED` or `FAILED`, so no older deployment is running that could take over. Check it on every use: `railway deployment list -s web --json` and `railway deployment list -s worker --json` show no active deployment, `https://web-production-62818.up.railway.app/health` (deployment.md, "Hosts") no longer answers, and in the production psql session no application connection remains:

   ```sql
   SELECT pid, application_name, client_addr, backend_start
   FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid();
   ```

   Then repeat the exports in step 4.1.4. Both services stay stopped until step 6. Until then nothing may start them: no `railway up` or `railway redeploy` on `web` or `worker`, no `railway variable set` on them without `--skip-deploys` (it triggers a deploy, [Railway CLI: variable](https://docs.railway.com/cli/variable), accessed 2026-10-07), and no `railway variable delete` on them (it always redeploys, deployment.md). A start would put production in front of users, and let the worker process restored jobs, before step 5 has reconciled authorization fields, removed restored sessions and reset tokens, and re-applied document revocations.
3. Restore production to the **same restore point** that passed section 5.

   **Path A, volume backup (not yet usable: backups are off).** First record the volume mounted on `pgvector` now: in `railway volume list --json`, the entry whose `serviceName` is `pgvector`; write down its `id` and `name` in the record. This is the rollback volume for section 4.5. It is `pgvector-volume` only until the first path A restore; after one, the mounted volume is the restored one, named for its backup's date stamp. In the Railway dashboard, open the `pgvector` service, Backups tab, find the backup by its date stamp, and click Restore. Railway stages a new volume, named for the backup's date stamp and mounted at the same location; click Deploy to complete it. The previous volume stays in the project, unmounted, and keeps any backups newer than the one restored ([Railway: backups](https://docs.railway.com/reference/backups), accessed 2026-10-07). Deploy applies every change staged in the project at that moment, and "Any services that are affected will be redeployed" ([Railway: staged changes](https://docs.railway.com/deployments/staged-changes), accessed 2026-10-07). Before clicking Deploy, open Details and check that the only staged change is the `pgvector` volume swap; discard any change that touches `web` or `worker` with the x next to it. Not verified: the owner accepted path A untested (section 8), so no rehearsal has shown that Deploy then redeploys only `pgvector`; check `web` and `worker` with `railway deployment list` right after Deploy. The exports from step 4.1.4 were on the previous volume; that is why they were copied off first. Then match the database password to the current one. A volume backup carries the `postgres` role's password as it was when the backup was taken, while `POSTGRES_PASSWORD` and the connection strings built from it keep the current value; after a rotation (section 7, step 3) the restored server would refuse `web` and `worker` and accept the old password again. In a shell in the `pgvector` container, where `POSTGRES_PASSWORD` holds the current value, set it and check a password login over the private network (`localhost` connections are trusted, so they do not test the password):

   ```
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -v ON_ERROR_STOP=1 -v role="$POSTGRES_USER" -v pw="$POSTGRES_PASSWORD" <<'SQL'
   ALTER ROLE :"role" PASSWORD :'pw';
   SQL
   PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$PGHOST_PRIVATE" -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -c "SELECT 1"
   ```

   The second command must return `1`. The volume also holds the application role's password as it was at the backup, while `web` and `worker` read the current one from the `pgvector` variable `TRUENOTE_APP_DB_PASSWORD` (deployment.md, "Database roles"). From a repository checkout on your machine, give the role a new password that matches the variable:

   ```
   node scripts/railway-set-app-db-password.mjs --apply
   ```

   It stores a new password in the variable with `--skip-deploys`, so neither `pgvector` nor the stopped services start, sets the role to the matching verifier, and must print `role truenote_app: verifier stored`. Do the same for the backup role, which the volume also carries with its old password: `node scripts/railway-set-app-db-password.mjs --role backup --apply`, then redeploy the `backup` service (section 7, step 4); it must print `role truenote_backup: verifier stored`. If it refuses because the role is missing, the backup predates `0014_backup_role.sql`; apply that file in step 4 first. If it refuses because the role is missing, the backup predates `0007_app_runtime_role.sql`; run it again after step 4 has applied that file. Both services pick the password up when step 6 starts them. Then run every check in section 5 against production, with `web` and `worker` still stopped; if any fails, go to section 4.5.

   **Path B, operator dump (available today).** Use a dump taken before the damage. If it is no longer on the volume, upload it:

   ```
   MSYS_NO_PATHCONV=1 railway volume files --volume pgvector-volume upload ./truenote-prod-<UTC date>.dump /truenote-dumps/truenote-prod-<UTC date>.dump
   ```

   In PowerShell, drop `MSYS_NO_PATHCONV=1` (section "Shells").

   In a shell in the `pgvector` container (section "Shells"), restore it into a new database next to production:

   ```
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -c "CREATE DATABASE truenote_restore"
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d truenote_restore -X -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
   pg_restore -h localhost -p 5432 -U "$POSTGRES_USER" -d truenote_restore --no-owner --single-transaction --exit-on-error /var/lib/postgresql/truenote-dumps/truenote-prod-<UTC date>.dump
   ```

   The dump carries table, schema and function privileges, but not the database's own: a new database lets every role connect and create temporary tables. Give `truenote_restore` the production database's settings from `lib/db/sql/0007_app_runtime_role.sql`:

   ```
   psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -v ON_ERROR_STOP=1 -c "REVOKE TEMPORARY ON DATABASE truenote_restore FROM PUBLIC" -c "GRANT CONNECT ON DATABASE truenote_restore TO truenote_app"
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

   The application reaches `$POSTGRES_DB` by name: since 2026-10-09 its `DATABASE_URL` is the `truenote_app` connection string, which ends in `/${{pgvector.PGDATABASE}}` (deployment.md, "Database roles"), and before that it was `DATABASE_URL_PRIVATE`. Roles belong to the server, so `truenote_app` and its password also work on the swapped-in database, and the restored dump carries its grants. The `pgvector` template builds `DATABASE_URL_PRIVATE` as `postgres://${{PGUSER}}:${{PGPASSWORD}}@${{PGHOST_PRIVATE}}:${{PGPORT_PRIVATE}}/${{PGDATABASE}}` with `PGDATABASE = ${{POSTGRES_DB}}` (Railway API, `template(code: "3jJFCA")`, read 2026-10-07). On 2026-10-07 the rendered `DATABASE_URL` of `web` and of `worker` each equaled `pgvector`'s `DATABASE_URL_PRIVATE`, and its database name equaled `POSTGRES_DB` (`railway variable list --json` for the three services, compared by a script that printed only the comparison results). `truenote_before_restore` is the rollback copy (section 4.5).
4. Bring the restored schema forward to the deployed code, with `web` and `worker` still stopped. A database restore does not restore code, so the restored database has the schema of the restore point while step 6 starts the currently deployed commit. That code needs the tables and columns in `lib/db/src/schema.ts` plus the objects the DDL files created. A Railway restore point is never older than the 2026-10-07 baseline, which already holds every file under `docs/security/` (deployment.md, "Schema changes"), so only `lib/db/sql/` files can be missing. Check at every restore:
   - In the production psql session, list the recorded files: `SELECT filename, sha256 FROM schema_migrations ORDER BY filename;`. Compare with the files in `lib/db/sql/` at the deployed commit. A file in the folder and not in the result needs applying. If the table itself is missing, `0001_schema_migrations.sql` comes first.
   - Run the section 5.1 query and [`../compliance/pci/production-control-verification.sql`](../compliance/pci/production-control-verification.sql) against production and compare the output with the last production run from before the incident.
   - Apply each missing file in number order, from the repository root of a checkout at the deployed commit:

     ```
     node scripts/railway-apply-sql.mjs lib/db/sql/NNNN_<name>.sql
     node scripts/railway-apply-sql.mjs lib/db/sql/NNNN_<name>.sql --apply
     ```

     The first command prints the file's status (`no-table`, `not-applied`, or the recorded SHA-256) and its local SHA-256. The second runs the file with `psql --single-transaction` inside `pgvector` over `railway ssh` and records it in `schema_migrations` in the same transaction; it refuses a file already recorded (`scripts/railway-apply-sql.mjs`, deployment.md). It talks only to `pgvector`, so `web` and `worker` stay stopped. Read each file before running it.
   - Check that the restored database has the job queue: in the production psql session, `SELECT to_regclass('pgboss.version');` must not return an empty value. Dumps taken before 2026-10-09 left out the `pgboss` schema, and `web` and `worker` connect as `truenote_app`, which cannot create it. If it is missing, apply the files above first (0007 creates an empty `pgboss` schema and its grants), then install pg-boss and its queues as `postgres` through the SSH tunnel to `pgvector` (step 5 below describes it, port 5434), from the repository root of the checkout at the deployed commit: `DATABASE_URL=postgresql://postgres@127.0.0.1:5434/<POSTGRES_DB> pnpm --filter @workspace/scripts run pgboss:install` (`scripts/src/pgboss-install.ts`; it starts no job handlers). It must print the schema version and the queues `__pgboss__send-it`, `ingest-document-version` and `run-evaluation`.
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
   - Using the exported `security_events`, re-apply every document revocation and retirement made after the restore point. The `document.lifecycle.*` events carry the document version, the previous and new lifecycle state, and the actor in their `details`. `web` is stopped, so use a local instance: from a repository checkout, start the API server and the Vite frontend as in section 5.4, with every section 3 isolation setting but `DATABASE_URL` set to production (`$PROD_DATABASE_URL`, PowerShell `$env:PROD_DATABASE_URL`). From your machine, reach production through an SSH tunnel to `pgvector`, the same way as section 4.2, step 5: `railway ssh config --service pgvector --alias truenote-pgvector -i <private key>`, then `ssh -N -L 127.0.0.1:5434:127.0.0.1:5432 truenote-pgvector`, and connect to `127.0.0.1:5434` with the user, password, and database of `DATABASE_URL_PRIVATE`. This tunnel was checked on 2026-10-08 (section 4.2, step 5). There is no public route: the owner closed the `pgvector` public TCP proxy on 2026-10-08 (deployment.md). `pgvector`'s `DATABASE_URL` was built on that proxy (the template defines it as `postgres://${{PGUSER}}:${{PGPASSWORD}}@${{PGHOST}}:${{PGPORT}}/${{PGDATABASE}}` with `PGHOST = ${{RAILWAY_TCP_PROXY_DOMAIN}}` and `PGPORT = ${{RAILWAY_TCP_PROXY_PORT}}`; Railway API, `template(code: "3jJFCA")`, read 2026-10-07), so it no longer leads anywhere. Do not reopen the proxy for this: the server does not serve TLS (section 4.2, step 5), so a proxy carries every query and row unencrypted; only the password stays protected, by SCRAM-SHA-256. Sign in as a super user and revoke or retire each version from the admin Documents page. Revocation (`POST /api/documents/<versionId>/revoke`) and retirement (`DELETE /api/documents/<id>`) change only database rows and write their audit events; neither touches the bucket. Sign out when done, which deletes the session this created, and stop both servers.
   - Documents purged after the restore point come back as rows, but their files were deleted from the bucket. Revoke or retire them again the same way.
   - Documents uploaded after the restore point are gone from the database but their files are still in the bucket. After step 6, ask program owners to re-upload them. Do not run `sweep-orphans` until this is done.
6. Start `web` and `worker` only after steps 4 and 5 are complete, with the owner's go: deploy the currently deployed commit with the two `railway up` commands in deployment.md ("Deploying"), from a checkout at that commit. Do not count on dashboard Redeploy: Railway offers it for "A successful, failed, or crashed deployment" and does not list removed ones ([Railway: deployment actions](https://docs.railway.com/deployments/deployment-actions), accessed 2026-10-07). Wait for `SUCCESS` in `railway deployment list -s <service> --json`, then check that `/health` returns `{"ok":true}`, `railway logs -s web` shows `[api-server] listening on http://0.0.0.0:8080`, and `railway logs -s worker` shows `[worker] ready` (deployment.md). Then run the section 5.4 smoke test against production.
7. Record the end time. RTO is end time minus decision time.

### 4.5 Roll back a cutover

If production fails the checks or the smoke test after cutover:

1. Stop `web` and `worker` again (`railway down -s web -y`, `railway down -s worker -y`) and keep them stopped through this section, under the rules in section 4.4, step 2.
2. Path A: mount the previous volume again. Railway keeps it in the project, unmounted, under the name it had, while the restored volume is named for the backup's date stamp ([Railway: backups](https://docs.railway.com/reference/backups), accessed 2026-10-07). Use the rollback volume `id` recorded in section 4.4, step 3, not a name from memory: after an earlier restore it is not `pgvector-volume`. A service holds one volume at a time ([Railway: volumes reference](https://docs.railway.com/volumes/reference), accessed 2026-10-07), so detach the restored volume first. `railway volume list --json` shows the restored volume's `id` as the entry whose `serviceName` is `pgvector`. Then:

   ```
   railway volume detach --volume <restored volume id> --yes
   railway volume -s 0d1e7840-7d5e-4a20-a97e-d04f06a88649 attach --volume <rollback volume id> --yes
   railway redeploy -s pgvector -y
   ```

   `-s` goes before `attach`: CLI 5.26 rejects `--service` after it (`error: unexpected argument '--service' found`), although the [Railway CLI: volume](https://docs.railway.com/cli/volume) page shows it there. `-s` takes the service ID, not its name: `attach` compares it with each service's ID without resolving names, so `-s pgvector` fails with `The service linked/provided doesn't exist` (CLI 5.26 source, `src/commands/volume.rs`). `0d1e7840-7d5e-4a20-a97e-d04f06a88649` is the `pgvector` service ID (deployment.md). Both commands call Railway's `volumeInstanceUpdate` API directly (CLI 5.26 source, `src/gql/mutations/strings/VolumeAttach.graphql` and `VolumeDetach.graphql`); they do not go through staged changes. Volumes "are mounted to your service's container when it is started" ([Railway: volumes](https://docs.railway.com/volumes), accessed 2026-10-07), hence the redeploy. Not verified: the owner accepted path A untested (section 8), so it is unknown whether `attach` redeploys `pgvector` by itself; the `railway redeploy` above covers either case. Then match the database passwords to the current ones, as after a path A restore (section 4.4, step 3): the previous volume carries the `postgres` and `truenote_app` passwords it had before the restore, so run the `ALTER ROLE` block, `node scripts/railway-set-app-db-password.mjs --role backup --apply` (then redeploy `backup`), and `node scripts/railway-set-app-db-password.mjs --apply`.
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

   Delete a listed proxy with `railway tcp-proxy delete <proxy id> -s truenote-restore-test --yes` and a listed domain with `railway domain delete <domain> -s truenote-restore-test --yes`. `railway volume list` covers the whole project. Production's volumes are the one whose `serviceName` is `pgvector` and any previous volumes a path A restore left unmounted (`pgvector-volume` until the first path A restore); never delete any of them here. Only a volume whose `serviceName` is `truenote-restore-test` is deleted, with `railway volume delete --volume <volume id> --yes`. Then remove the SSH config block and delete the service:

   ```
   railway ssh config remove --service truenote-restore-test
   railway service delete --service truenote-restore-test --yes
   ```

   `railway service delete` asks for `--2fa-code <code>` when the account has two-factor authentication and the run is non-interactive (Railway CLI 5.26 `railway service delete --help`). `[CONFIRM: whether deleting a service also deletes its proxy, domains, and volumes; the checks above do not rely on it]` Check that it is gone: `railway service list --json` no longer lists `truenote-restore-test`, and `railway volume list --json` lists no volume whose `serviceName` is `truenote-restore-test`. Then remove the password from the session (bash: `unset POSTGRES_PASSWORD`; PowerShell: `Remove-Item Env:POSTGRES_PASSWORD -ErrorAction SilentlyContinue`) and run the `railway link` command at the top of this runbook again, so the directory is no longer linked to the deleted service. Relinking without `-s` clears the linked service: in a script or any run whose output is not a terminal it links none, and in a terminal it asks `Select a service (optional) <esc to skip>`, where Esc links none (CLI 5.26 source, `src/commands/link.rs`). On 2026-10-07, in a scratch directory linked with `-s pgvector`, a non-interactive `railway link -p ... -e ...` left `railway status` showing `Service: None`. After a path B incident restore, drop `truenote_before_restore` (and `truenote_failed_restore`, if it exists) once the incident's retrospective is done (incident response plan, section 8): `psql -h localhost -p 5432 -U "$POSTGRES_USER" -d postgres -X -c "DROP DATABASE truenote_before_restore"`. Both hold pre-restore production data, including password hashes and the damage. After a path A restore, the previous volume holds the same, plus every backup newer than the one restored; delete it only after the incident is closed and no newer backup is needed. Keep it for 30 days after the incident is closed, then delete it (owner decision, 2026-10-07).
3. Delete the dump, its count record, and the export files from the volume, and every local copy, encrypted or not, once the test has ended, or for an incident once the incident's retrospective is done (incident response plan, section 8). The only dumps kept are backups (section 4.1, step 5).

### 4.7 Restore test or rebuild from the off-site copy (path C)

Written 2026-10-10 and first run the same day (receipt [`evidence/restore-test-2026-10-10.json`](./evidence/restore-test-2026-10-10.json), section 9); that run settled the region, start command and deletion steps, and the remaining `[CONFIRM]` items stay open. The same steps rebuild Truenote after the loss of the Railway account or project (contingency plan, section 5): then the new project becomes production, its `web` gets the real variables and a domain, and `worker` is deployed as well. A rebuild also needs persistent storage: attach a volume to the database service at `/var/lib/postgresql` before step 5 (`railway volume add --service restore-db --mount-path /var/lib/postgresql`), and before any traffic, redeploy that service once and check that the restored counts are unchanged. A test target keeps no volume, so its data is gone on any restart; that is intended.

The test project shares nothing with production: its own private network, its own bucket, no variable or reference of production, and no production credential. It reads only the off-site copy, with the read-only key. Nothing in it sends email or runs ingestion.

You need: the Railway CLI, logged in; the read-only B2 key (endpoint, region, bucket, key id, secret); the passphrase-protected age identity file and its passphrase (section 7, step 4); a repository checkout at freshly fetched `origin/main`; separate AI provider keys with a low spending limit, never the production keys.

1. Record the decision time (UTC). On your machine, run `node scripts/backup/check-offsite.mjs`. It names the newest run id; that run's `started_at` is the restore point. For a test it must print `PASS`. In an incident a failure does not stop the rebuild, because the restore script checks the copy against its manifest and every part on its own: when the newest run is only older than 8 days (an outage that long, for example), restore it; when the checker reports keys changed after upload, restore the newest run from before the earliest change it reports, and in step 5 add an as-of time before that change; when the newest copy does not match its manifest, has a malformed age header, or does not decrypt, restore the run before it. Record each failure the checker printed in the receipt.
2. In an empty scratch directory, create the project and note its id: `railway init --name truenote-restore-test`. `railway init` links that directory to the new project. Run every Railway command in this section from that directory, and from the repository checkout only after linking it too (`railway link -p <test project id>`; relink to production afterwards with the command at the top of this runbook). Commands that accept `-p` (`ssh`, `logs`, `variable`, `up`, `deployment list`) also get `-p <test project id>`; `railway bucket` commands accept no project flag and use the directory's link (section at the top). Never use the production project or environment ids in this section, and run `railway status` before each step that writes: it must show `truenote-restore-test`. Set each service you create in steps 3 and 6 to a US West region, away from production's `us-east4`: the CLI has no region setting, so use Railway's GraphQL API, `serviceInstanceUpdate(serviceId, environmentId, input: { multiRegionConfig: { "us-west2": { numReplicas: 1 } } })` before the first deploy; the `region` input field had no effect, and the deployment's metadata shows the region (2026-10-10 test). Create the test bucket with `railway bucket create <name> --region sjc`.
3. Create the test bucket (`railway bucket create`) and read its credentials (`railway bucket credentials`). Create the database service from the repository checkout with `Dockerfile.backup`: service variables `RAILWAY_DOCKERFILE_PATH=Dockerfile.backup`, a generated `POSTGRES_PASSWORD` (section 4.2, step 1), the read-only key as `OFFSITE_S3_ENDPOINT`, `OFFSITE_S3_REGION`, `OFFSITE_S3_BUCKET`, `OFFSITE_S3_ACCESS_KEY_ID`, `OFFSITE_S3_SECRET_ACCESS_KEY`, and the test bucket as `TEST_S3_ENDPOINT`, `TEST_S3_REGION`, `TEST_S3_BUCKET`, `TEST_S3_ACCESS_KEY_ID`, `TEST_S3_SECRET_ACCESS_KEY`, each set with `railway variable set <KEY> --stdin --skip-deploys` (section 7, step 1). Set its start command to `docker-entrypoint.sh postgres`, so it runs the Postgres server instead of a backup: `serviceInstanceUpdate` with `startCommand: "docker-entrypoint.sh postgres"` over the same API (2026-10-10 test). Then `railway up --detach -s restore-db`. Check that it has no TCP proxy and no domain (`railway tcp-proxy list -s restore-db --json`, `railway domain list -s restore-db --json`, both empty) and that its log shows `database system is ready to accept connections`.
4. Open a shell in it (`railway ssh -s restore-db`). Paste the identity file: run `cat > /tmp/truenote-identity.age`, paste the file's armored text, press Enter, then Ctrl+D. The file is still passphrase-protected; the restore script deletes it when it ends.
5. In the same shell: `sh /opt/truenote-backup/restore-offsite.sh <run id>`, or `sh /opt/truenote-backup/restore-offsite.sh <run id> <as-of time, for example 2026-10-18T07:00:00Z>` when step 1 found changed keys; the script then reads the object versions that were current at that time. Enter the passphrase when `age` asks. The script checks the object against its manifest, decrypts, checks every part against the inner manifest, restores the database, copies the files into the test bucket and checks them, verifies the code bundle, and prints the backup's count record next to the restored counts, with UTC times for each step. Any mismatch stops it.
6. Run section 5.1, 5.2 (against the printed count record) and 5.3 in that shell with `psql -U postgres -d postgres -X`. The restore script recreated `truenote_app` and `truenote_backup` with their login attributes and no password, because roles are not in the dump while `schema_migrations` already lists `0007` and `0014`. To let the test `web` connect, set `\password truenote_app` there with a generated hex password. For a rebuild, also set `\password truenote_backup`, store both values in the new project's variables, and point the new `backup` service at them.
7. Create `web` in the test project from the repository checkout (`railway up --detach -s web`, with `RAILWAY_DOCKERFILE_PATH=Dockerfile.railway`). Variables: `DATABASE_URL` for `truenote_app` at `restore-db.railway.internal:5432/postgres`; `RAG_STORAGE_DRIVER=s3` and `S3_*` set to the test bucket; `APP_BASE_URL=http://localhost:8081`; `LOCAL_LOGIN_MODE=enabled`; `TRUENOTE_PROCESS=web`; `PORT=8080`; the separate AI provider keys. Leave unset: every `RESEND_*`, `OIDC_*`, `SECURITY_ALERT_EMAIL` and `BOOTSTRAP_SUPER_USER_*` variable. Do not create `worker`. Do not add a domain: the restored copy holds real accounts and password hashes and has no monitoring, so it must not be reachable from the internet. Check `railway domain list -s web --json` and `railway tcp-proxy list -s web --json` are empty.
8. Reach it through an SSH tunnel from your machine (section 4.2, step 5): `railway ssh config --service web --alias truenote-restore-web -i <private key>`, then `ssh -N -L 127.0.0.1:8081:127.0.0.1:8080 truenote-restore-web`. Run section 5.4, steps 3 to 6, against `http://localhost:8081` On 2026-10-10 the server issued the session cookie with `Secure` and accepted it from an HTTP client over the tunnel; `[CONFIRM: that a browser sends it on http://localhost; the 2026-10-10 test ran steps 4 and 5 against the API only]`. The first cited answer is the end time.
9. Record: RTO = end time minus decision time; RPO = decision time minus the restore point; the checks passed; the test project's region; the image digest; problems found. Write the receipt `docs/security/evidence/restore-test-<UTC date>.json` and a row in section 9.
10. Delete the test project: close the tunnel, remove the SSH config block (`railway ssh config remove --service web`), delete the project with `railway delete --project <test project id> --yes`, and check that `railway deployment list` shows each service `REMOVED`. Railway removes the services at once but schedules the project's own deletion two days later (`railway list --json` shows its `deletedAt`; 2026-10-10 test), so the project and its bucket stay listed until then. The project held restored data, including password hashes. Delete the separate AI provider keys, or keep them only if their spending limit stays low.

The encrypted identity and its passphrase pass through Railway's SSH relay during step 4 and 5. A compromise of Railway during that window could expose the key. `[CONFIRM: owner accepts this for tests]`; after a real rebuild on a new host, make a new key pair (section 7, step 4).

## 5. Verification checks

### 5.1 Schema present

```sql
SELECT t AS missing_table
FROM unnest(ARRAY[
  'programs', 'users', 'sessions', 'documents', 'document_versions', 'chunks',
  'query_log', 'content_sources', 'security_events', 'security_rate_limits',
  'service_heartbeats', 'security_monitor_state', 'schema_migrations'
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

Pass: `hash_mismatches = 0`. The hash covers `occurred_at` as text, so the result depends on the session time zone matching the one used when events were written. Events written before 2026-10-07 were written on the previous host and copied with their hashes (deployment.md, "Data copy"). With `TimeZone` set to `UTC`, both queries return 0 on production: on 2026-10-08 the link check returned `broken_links = 0` and the recompute `hash_mismatches = 0` over all 199 events (sequences 1 to 199, 2026-07-15 to 2026-10-08), including every event copied from the previous host, in a read-only session.

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
5. Sign in as a CSR test account in a test program and ask a question whose answer is in that program's documents. The answer has at least one citation, and opening it shows the cited excerpt. On 2026-10-08 production held one program, `Demo Program`, with 21 documents and one active CSR account, and `web` had `DEMO_LOGIN_ACCOUNTS` set, so the demo CSR account (deployment.md) serves for this step.
6. Ask a question that only another program's documents can answer. The answer is a refusal. Not applicable while production has one program: the owner stated on 2026-10-10 that no second program is planned for the foreseeable future, so restore tests skip this step and record it as not applicable. Program scoping stays covered by the retrieval and negative-control tests that CI runs (`artifacts/api-server/src/lib/retrieval/__tests__/program-scope.test.ts`, `artifacts/api-server/src/lib/security/__tests__/negative-controls.test.ts`). Run this step again if a second program is ever added.
7. Optional, costs provider tokens: `pnpm --filter @workspace/scripts run eval -- --limit 5` with `DATABASE_URL` set to the target. No new failures compared with the last production eval run.

`GET /api/admin/observability/security-audit` on the test instance reports `storageReady: true`. Without a `worker`, `workerBeatAt` keeps the restored production timestamp and `/health/ready` answers 503 with `worker: stale`; that is expected in the test project.

After cutover, repeat the health check and steps 4 to 6 against production at `https://web-production-62818.up.railway.app` and at `https://truenote.org`, which points at Railway since 2026-10-07 (deployment.md), with the worker running. Check that `GET /api/admin/observability/security-audit` shows `pendingEvents` falling to 0 and `/health/ready` returns 200.

## 6. Object storage recovery

The bucket has no versioning; its only backup is the weekly off-site copy (section 1). If files are lost:

1. List affected versions: `SELECT dv.id, d.title, d.program_id, dv.source_url FROM document_versions dv JOIN documents d ON d.id = dv.document_id;` then check each key in the Railway bucket view, which `scripts/src/sweep-orphans.ts` names for this comparison, or with any S3 client given the bucket credentials and the endpoint `https://t3.storageapi.dev`.
2. Existing answers keep working, because they read parsed text and chunks from the database.
3. Restore missing files from the latest off-site copy that holds them: run section 4.7, steps 1 to 5, in a restore-test project; the restore script copies every file of that copy into the test bucket under its original key. Download the missing ones from the test bucket with its credentials (`railway bucket credentials` in the test project) and any S3 client, then delete the test project (section 4.7, step 10). The manifest's `referenced_files_missing` shows how many files the database referenced that the copy lacked. Upload each one again as a new version of its document, or ask program owners for the originals.
4. If the bucket itself was deleted, restore it within 52 hours from the project's Activity feed: select the change that removed it and click Restore ([Railway: storage buckets](https://docs.railway.com/guides/storage-buckets), accessed 2026-10-07).

## 7. Secrets recovery

1. For each variable, re-issue the value at its provider, then set it on each service that has it (deployment.md, "Variables"), passing the value on standard input, not on the command line:

   ```
   railway variable set <KEY> --stdin --skip-deploys -s worker
   railway variable set <KEY> --stdin -s web
   ```

   `--skip-deploys` batches changes without a redeploy; a `set` without it redeploys that service (deployment.md, [Railway CLI: variable](https://docs.railway.com/cli/variable), accessed 2026-10-07). Make the last change on each service without `--skip-deploys`, or deploy that service afterwards as in deployment.md, so both services run the new value. A `set` with `--skip-deploys` saves the value at once and skips only the deploy: CLI 5.26 sends it as `skipDeploys: true` on Railway's `variableCollectionUpsert` API call (CLI source, `src/commands/variable.rs` and `src/gql/mutations/strings/VariableCollectionUpsert.graphql`), which Railway's API schema describes as "Skip deploys for affected services". The change is saved, not staged, so the next deploy of that service, from a later `set` or from `railway up`, starts with it. While `web` and `worker` are stopped for a restore, use `--skip-deploys` on every change (section 4.4, step 2).
2. Bucket credentials: `railway bucket credentials --reset -b truenote-storage` invalidates the existing credentials and creates new ones; `railway bucket credentials -b truenote-storage` prints them ([Railway CLI: bucket](https://docs.railway.com/cli/bucket), accessed 2026-10-07). Set `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` on both services as in step 1. Then redeploy `backup` (`railway redeploy -s backup -y`): its `S3_*` variables reference `web`'s, and Railway resolves them when a service deploys, so its scheduled runs keep the old credentials until then (deployment.md, Backups row). Check the next run's log for `[backup] run ... ok`. Uploads, rescans, and purges fail between the reset and the redeploy. Do not paste the printed values into chat or tickets.
3. Database credentials. In the `pgvector` template, `PGPASSWORD` is `${{POSTGRES_PASSWORD}}`, and `DATABASE_URL` and `DATABASE_URL_PRIVATE` are built from `${{PGPASSWORD}}` (Railway API, `template(code: "3jJFCA")`, read 2026-10-07); `web` and `worker` took `DATABASE_URL=${{pgvector.DATABASE_URL_PRIVATE}}` until 2026-10-09 and now connect as `truenote_app` (deployment.md, "Database roles"; step 5 below). Changing the variable alone does not change the password: `POSTGRES_PASSWORD` sets it "by the `initdb` script during initial container startup" ([Docker Hub: postgres](https://hub.docker.com/_/postgres), accessed 2026-10-07), and the volume already holds an initialized database. Change both, in this order:
   1. On your machine, generate the new password into a session variable, as in section 4.2, step 1, with `NEW_DB_PASSWORD` in place of `POSTGRES_PASSWORD` (bash: `NEW_DB_PASSWORD=$(openssl rand -hex 32) && export NEW_DB_PASSWORD`). Use only a generated hex value: the template puts `${{PGPASSWORD}}` into `DATABASE_URL` and `DATABASE_URL_PRIVATE` without URL encoding, so a password with `#`, `/`, `?`, or `%` breaks both connection strings and the application cannot connect after the redeploy. Print it once to paste at the next prompts (bash: `printf '%s\n' "$NEW_DB_PASSWORD"`; PowerShell: `$env:NEW_DB_PASSWORD`).
   2. In the production psql session, run `\password postgres` and enter the new password at the prompts. psql encrypts it and sends it as an `ALTER ROLE` command, so it does not appear in cleartext in the command history or the server log ([PostgreSQL 18: psql](https://www.postgresql.org/docs/18/app-psql.html), accessed 2026-10-07). Connections already open keep working; new connections with the old password fail from here on.
   3. On your machine, pipe the same value into the variable. `--stdin` refuses to read from a terminal ("No input provided via stdin", CLI 5.26 source, `src/commands/variable.rs`), so the value must come through a pipe:

      ```
      printf '%s' "$NEW_DB_PASSWORD" | railway variable set POSTGRES_PASSWORD --stdin -s pgvector
      ```

      PowerShell:

      ```
      $env:NEW_DB_PASSWORD | railway variable set POSTGRES_PASSWORD --stdin -s pgvector
      ```

      The CLI strips the trailing line break that PowerShell adds. The reference variables follow `POSTGRES_PASSWORD`.
   4. If `web` or `worker` still connects through `DATABASE_URL_PRIVATE` (before 2026-10-09, or after rolling back the role switch), redeploy it so it connects with the new password (deployment.md, "Deploying"); services that connect as `truenote_app` are unaffected by steps 1 to 3. Either way, check `/health` and the logs as in section 4.4, step 6. Then remove the variable from the session (bash: `unset NEW_DB_PASSWORD`; PowerShell: `Remove-Item Env:NEW_DB_PASSWORD -ErrorAction SilentlyContinue`).
   5. Once `web` and `worker` connect as the application role `truenote_app` (deployment.md, "Database roles"), their `DATABASE_URL` no longer uses `POSTGRES_PASSWORD`, so steps 1 to 4 leave the application's password unchanged. When that password may be exposed too (any compromise of `web`, `worker`, their variables, or the `pgvector` variables), rotate it as well, from a repository checkout on your machine:

      ```
      node scripts/railway-set-app-db-password.mjs --apply
      ```

      It stores a new password in the `pgvector` variable `TRUENOTE_APP_DB_PASSWORD` without redeploying anything, sets the role to the matching verifier, and must print `role truenote_app: verifier stored`. The old password stops working for new connections at once. Then redeploy `web` and `worker` (deployment.md, "Deploying") and check `/health` and the logs as in section 4.4, step 6.

   `[CONFIRM: which services step 3 redeploys by itself, and that the reference variables of web and worker pick up the change; rehearse once outside an incident]`

   The owner closed the `pgvector` public TCP proxy on 2026-10-08 (deployment.md). Check that it is still closed (`railway tcp-proxy list -s pgvector --json` lists no proxy); if one was opened since, close it before anything else. `railway tcp-proxy delete <proxy> -s pgvector --yes` deletes it; `<proxy>` is the proxy id, domain, endpoint, proxy port, or application port, and `railway tcp-proxy list -s pgvector --json` shows the id (Railway CLI 5.26 `railway tcp-proxy delete --help`; [Railway CLI: tcp-proxy](https://docs.railway.com/cli/tcp-proxy), accessed 2026-10-07). Networking changes "are not yet staged and are applied immediately" ([Railway: staged changes](https://docs.railway.com/deployments/staged-changes), accessed 2026-10-07). The app does not use the proxy (deployment.md); `railway ssh -s pgvector` keeps working.
4. Off-site backup keys. None of them is stored in this repository or in chat.
   - **age key pair.** Made once by the owner, on a machine they trust: `age-keygen -o truenote-backup.key` prints the public key (`age1...`); `age -p -a -o truenote-backup-identity.age truenote-backup.key` makes the passphrase-protected identity file, after which the plain `truenote-backup.key` is deleted. Keep the identity file and its passphrase in the password manager and a printed copy of both in a separate safe place; never in Railway or B2. The public key is the `backup` service variable `BACKUP_AGE_RECIPIENT`. To rotate, make a new pair and set the new public key; keep the old identity until the last copy encrypted to it has expired (12 months for monthly copies). A lost private key makes every copy encrypted to it unreadable: make a new pair at once and check that the next weekly run uses it.
   - **B2 keys.** A write-only key (capabilities `listFiles` and `writeFiles`, limited to the backup bucket) is set on the `backup` service as `OFFSITE_S3_ACCESS_KEY_ID` and `OFFSITE_S3_SECRET_ACCESS_KEY`. A read-only key (`listFiles` and `readFiles`) stays with the owner for restores and the weekly check (`~/.claude/secrets/truenote-offsite-read.json` on the owner's machine, read by `scripts/backup/check-offsite.mjs`). To rotate either, create a new key in the B2 account, set it, and delete the old one. A compromised Railway account exposes only the write-only key: it cannot read or delete locked versions. It can upload a newer version under an existing name; the weekly check reports that, and the locked original stays restorable (section 4.7, step 5).
   - **`truenote_backup` password.** `node scripts/railway-set-app-db-password.mjs --role backup --apply` sets a new one in the `pgvector` variable `TRUENOTE_BACKUP_DB_PASSWORD`; then redeploy the `backup` service (`railway redeploy -s backup -y`): Railway resolves a service's reference variables when it deploys, so a scheduled run of the old deployment keeps the old password. Check the next run's log for `[backup] run ... ok`.
5. Run the smoke test in section 5.4 against production.

## 8. Test schedule

- Until volume backups are on, take a weekly operator dump (section 4.1, step 5).
- **Every week**, from the owner's machine with the read-only key: `node scripts/backup/check-offsite.mjs`, as a scheduled task that notifies the owner when it fails. It fails when the newest off-site run is older than 8 days, when an object does not match its manifest, when the object has no well-formed age header with exactly one X25519 recipient, when a manifest or copy changed after upload (a second stored version with different content, or a hide marker set before the lifecycle rule would hide the key; a retried upload of the same bytes and the lifecycle's own hides are ignored), when the manifest records no code bundle, or when the count of referenced files missing from the copy rises. The header check cannot prove which key a copy is encrypted to; with `AGE_BIN` and `OFFSITE_CHECK_IDENTITY` set to the age binary and an identity file without a passphrase, it also decrypts the newest copy and checks its parts, and otherwise prints that it did not decrypt. It is the only alert for missed or broken runs (owner decision, 2026-10-10: no separate monitoring service). It runs while the Claude app is open; a missed week runs at the next start.
- **Every 3 months**, and after any change to backup settings, the `pgvector` image or the schema-change process: a path C restore test into a separate project (section 4.7). Path B tests (sections 4.1 to 4.3, 4.6) remain available when the off-site copy cannot be used.
- **Once a year**: the full contingency test in [`contingency-plan.md`](./contingency-plan.md), section 6 (a timed rebuild from the off-site copy in another region, with an incident-response tabletop).
- Path A is not rehearsed. A rehearsal would replace production's volume, so it would need a maintenance window, the owner's go, `web` and `worker` stopped throughout, and the previous volume kept for rollback. The owner decided on 2026-10-07 to accept path A untested: no rehearsal is planned, and the first use of path A will be during an incident. Once backups are on, check every 3 months that `node scripts/railway-volume-backups.mjs` lists the three schedules and recent backups.
- Run the object-storage and secrets checks (sections 6 and 7, without changing production values) every 6 months, together with an incident-response tabletop exercise.

## 9. Restore test evidence record

Add one row per restore test or real restore. The row is the record; raw query output is not kept (section 3, rule 5). A path C test also leaves a receipt in `docs/security/evidence/` (section 4.7, step 9).

| Date (UTC) | Operator | Reason (test / incident id) | Path (A / B / C) and target (separate test project / temporary Railway service / scratch database / production after path A) | Restore point (UTC) | Measured RPO | Measured RTO | Checks passed (5.1 / 5.2 / 5.3 link / 5.3 recompute / 5.4) | Issues and follow-up |
|---|---|---|---|---|---|---|---|---|
| 2026-10-10 | Claude Code agent, owner's go | Scheduled test (first path C run) | C, separate test project `truenote-restore-test` in `us-west2`; services removed afterwards, project deletion scheduled by Railway for 2026-10-12 (to confirm) | 2026-10-10 12:09:03 (off-site run `20261010T120903Z`) | About 3 h 20 min (target 7 days) | 7 min 12 s, decision to first cited answer | 5.1 yes / 5.2 yes (equal to the count record) / 5.3 link yes / 5.3 recompute yes / 5.4 steps 3 and 5 yes by API, step 4 partial (no super user), step 6 not run (one program) | Production AI keys used (owner decision); plain test identity sent over `railway ssh`; browser check not run; receipt [`evidence/restore-test-2026-10-10.json`](./evidence/restore-test-2026-10-10.json) |
