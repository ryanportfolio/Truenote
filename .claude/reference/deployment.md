# Deployment

Production moved from Replit to Railway on 2026-10-07. The Railway stack runs with a copy of the Replit production data taken that day, and the owner switched `truenote.org` and `www.truenote.org` DNS to Railway at about 19:50 EDT the same day (see "Cutover").

Stage (owner statement, 2026-10-07): pre-pilot. The owner built Truenote and is pitching it to their employer as the RAG system for the owner's program; it has not yet passed the employer's security review. There is no customer contract, production holds demo data only, and no CSRs use it. Treat "customer" in the security docs as that employer once it adopts Truenote.

The Railway CLI stores `railway link` per directory, so a fresh worktree is not linked; every `railway` command here passes `-p 2aa5cb01-5438-4fbd-aade-626d4e252977 -e b35c4090-cbcd-4deb-9434-e9b63a309bd9` (written `-p <project> -e <env>` below where it would repeat).

## Production

| Item | Value |
|---|---|
| Project | `truenote`, `2aa5cb01-5438-4fbd-aade-626d4e252977` |
| Environment | `production`, `b35c4090-cbcd-4deb-9434-e9b63a309bd9` (the only environment; there is no dev database) |
| `web` | `72fa55df-61f3-421c-a411-4f9e6bbbd49f`. api-server serving `/api` and the built SPA, `TRUENOTE_PROCESS=web`, `PORT=8080`, one replica. Healthcheck `/health` (120 s), restart `ON_FAILURE` ×3, draining 15 s |
| `worker` | `5dc3e0f3-86f9-4f4e-95b2-4729ad13fdae`. pg-boss ingestion and evaluation worker, `TRUENOTE_PROCESS=worker`, restart `ALWAYS`, no public port |
| Database | service `pgvector` (`0d1e7840-7d5e-4a20-a97e-d04f06a88649`), image `pgvector/pgvector:pg18`, volume `pgvector-volume` at `/var/lib/postgresql`. Extensions `vector`, `pg_trgm`, `pgcrypto`. The template opened a public TCP proxy on 5432; the owner closed it on 2026-10-08 at 01:08 UTC (`railway tcp-proxy delete`), because the server runs with `ssl` off. `pgvector`'s `DATABASE_URL`, `PGHOST`, and `PGPORT` referenced the proxy and now lead nowhere. The app uses `DATABASE_URL_PRIVATE`; from outside Railway, use `railway ssh -s pgvector` or an SSH tunnel (backup-restore-runbook.md, section 4.4, step 5) |
| Object storage | bucket `truenote-storage` (`cefc54e5-6980-46d3-b3e6-bb31942c4eda`, physical `truenote-storage-w0ha8kzq`, region `iad`), endpoint `https://t3.storageapi.dev`, virtual-host style. Keys keep the Replit layout `uploads/<sha256>-<name>` |
| Hosts | `web-production-62818.up.railway.app`; custom domains `truenote.org` and `www.truenote.org`, DNS pointed at Railway since 2026-10-07. The app answers `www` with a 308 to `APP_BASE_URL` |
| Build | `Dockerfile.railway` (service setting `dockerfilePath`, plus `RAILWAY_DOCKERFILE_PATH`), uploaded with `railway up` by `scripts/railway-deploy.mjs` ("Deploying"); `.railwayignore` and `.dockerignore` whitelist the build inputs |
| Backups | Off-site copy running since 2026-10-10: service `backup` (`a7b96647-e8dd-4e3a-8290-fca4aab6bf22`), cron `17 6 * * 0` (Sunday 06:17 UTC), restart policy `NEVER`, no domain or TCP proxy. Variables: `RAILWAY_DOCKERFILE_PATH=Dockerfile.backup`, `BACKUP_DATABASE_URL` for `truenote_backup` (`${{pgvector.TRUENOTE_BACKUP_DB_PASSWORD}}` at `${{pgvector.PGHOST_PRIVATE}}`), `BACKUP_AGE_RECIPIENT`, `BACKUP_GIT_URL=https://github.com/ryanportfolio/Truenote.git`, `OFFSITE_S3_*` (the write key), and `S3_*` as references to `web`'s (`${{web.S3_ACCESS_KEY_ID}}` and so on), so a bucket credential reset also needs `railway redeploy -s backup -y`. `scripts/railway-deploy.mjs` deploys only `web` and `worker`, so the service was created with `railway add --service backup`, its settings set over the GraphQL API (`serviceInstanceUpdate`), and main `7c317327` uploaded once from a clean LF worktree with `.release-commit` (deployment `817f4f17-f9e9-478c-9136-31bc3fcd0719`, image `sha256:efe2e8c1…`, release register row) after the owner's go. That deployment ran once before the cron was set: run `20261010T120903Z`, 30,533,080 bytes, 31 bucket files, 8 of 39 referenced files missing (the 8 Replit-only demo objects, "Data copy from Replit"); `node scripts/backup/check-offsite.mjs` printed `PASS` with decryption. Design chosen by the owner on 2026-10-10 (B2 destination, weekly cadence): Railway volume backups on `pgvector-volume` (daily, weekly, monthly; off until go-live, owner decision 2026-10-10; turn on with `node scripts/railway-volume-backups.mjs --enable`), and the `backup` cron service (`Dockerfile.backup`, `scripts/backup/run-backup.sh`), a weekly `age`-encrypted copy of the database, the bucket and the code in a separate Backblaze B2 account. Procedures and keys: `docs/security/backup-restore-runbook.md` (sections 1, 4.7, 7, 8); targets: `docs/security/contingency-plan.md`. B2 set up on 2026-10-10: account region `us-east-005` (fixed at sign-up), S3 endpoint `https://s3.us-east-005.backblazeb2.com`, bucket `truenote-offsite-f630db2c` (private, SSE-B2, Object Lock governance 35 days; lifecycle `weekly/` 35 days, `monthly/` and `manifests/` 365 days, then deleted 1 day after hiding; unfinished uploads cancelled after 1 day). Bucket-limited keys `truenote-backup-write` (`listFiles`, `writeFiles`) and `truenote-backup-read` (`listFiles`, `readFiles`), stored on the owner's machine in `~/.claude/secrets/truenote-offsite-write.json` and `truenote-offsite-read.json`. Checked over the S3 API on 2026-10-10: the write key can PUT and is refused GET and version DELETE (403), the read key can GET and is refused PUT (403), and a locked object could not be deleted even with the master key until the governance bypass was used. age key pair generated on the owner's machine on 2026-10-10 by the agent at the owner's request (age 1.3.1 from its GitHub release, `C:\Users\Home\.local\age-v1.3.1`): public key `age1tf8yu94alejwlehs57trggan4m8sgtltj6xjp6cxt087vu63fs2shr0mt7`, private key in `~/.claude/secrets/truenote-backup-identity.txt` until the owner passphrase-protects it. It is a test key: make a new pair at go-live (runbook, section 7, step 4) |

Run one replica of `web` and scale vertically: the forgot-password and login IP limiters (`artifacts/api-server/src/lib/auth/rate-limit.ts`) live in process memory. The ask and workload limits are in Postgres and hold across replicas.

### Variables

Set per service (values never in git or chat; the owner's source file is `Desktop\Secrets.txt`):

- Both: `DATABASE_URL` as the `truenote_app` connection string ("Database roles" below), `RAG_STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (from `railway bucket credentials`), `APP_BASE_URL=https://truenote.org`, `CORS_ALLOWED_ORIGINS=https://web-production-62818.up.railway.app`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `COHERE_API_KEY`, `VISION_AGENT_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `MIN_PASSWORD_LENGTH`, `DEMO_LOGIN_ACCOUNTS`, `RAILWAY_DOCKERFILE_PATH`, `TRUENOTE_PROCESS`, `SECURITY_ALERT_EMAIL` (since 2026-10-10; recipients of security alert emails, `docs/security/monitoring.md`).
- `web` only: `PORT=8080`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`.

`CORS_ALLOWED_ORIGINS` is what lets the Railway URL pass the CSRF origin check while `APP_BASE_URL` already names the final domain. Not set on Railway: `SESSION_SECRET` and `MISTRAL_API_KEY` (no code reads them), `BOOTSTRAP_SUPER_USER_*` (the copied database has its super user), OIDC and malware scanner variables (unset on Replit too).

`railway variable set KEY --stdin --skip-deploys -p <project> -e <env> -s <service>` batches changes without a redeploy; `railway variable delete` always redeploys.

The monitoring change went live on 2026-10-10: `0011` applied at 05:01 UTC, `SECURITY_ALERT_EMAIL` set on both services with `--skip-deploys`, then `worker` (`7b7be223`) and `web` (`e317aa3d`) deployed from `ed228fca` (#216). Checks and alert tests: `docs/security/monitoring.md`.

Pending with the evidence harness (`docs/security/evidence-harness.md`): `EVIDENCE_GITHUB_TOKEN` on `worker`. Until it is set, the five GitHub checks record `error`. Evidence alerts go to `SECURITY_ALERT_EMAIL` unless `EVIDENCE_ALERT_EMAIL` is set.

### Database roles

Two roles, defined by `lib/db/sql/0007_app_runtime_role.sql`:

- `postgres` (`POSTGRES_USER`): superuser, owns every table, function and schema. Used only for `scripts/railway-apply-sql.mjs`, `railway ssh -s pgvector` maintenance, dumps and restores, and catalog evidence queries.
- `truenote_app`: the application's login role for `web` and `worker`. Owns nothing, no DDL, no temporary tables, no TRUNCATE. Row access (SELECT, INSERT, UPDATE, DELETE) to the application tables listed in 0007 and to every `pgboss` table; SELECT only on `security_events`, whose rows it writes through `append_security_event` (SECURITY DEFINER); nothing on `schema_migrations`, `security_control_metadata` or `siem_delivery_outbox`. `security_events` also refuses UPDATE, DELETE and TRUNCATE from any role, the owner included (`0008_security_events_append_only.sql`).

Since 2026-10-09 both services connect as `truenote_app`: `worker` from deployment `f2d9c0a9` (22:18 UTC) and `web` from `08c5b8d7` (22:24 UTC), both commit `1256d3d1`. Checks, privilege sweep and negative tests are retained in `docs/security/evidence/railway-app-role-2026-10-09.json`.

The connection string for `web` and `worker` is `DATABASE_URL=postgresql://truenote_app:${{pgvector.TRUENOTE_APP_DB_PASSWORD}}@${{pgvector.PGHOST_PRIVATE}}:${{pgvector.PGPORT_PRIVATE}}/${{pgvector.PGDATABASE}}`. The password lives only in the `pgvector` variable `TRUENOTE_APP_DB_PASSWORD`. `node scripts/railway-set-app-db-password.mjs` prints the role's attributes and whether that variable exists; with `--apply` (owner's go) it sets a new random password in the variable without redeploying `pgvector`, sets the role to the matching SCRAM verifier, and checks it, printing neither. Running services keep their open connections and need a redeploy of both to use a new password. Rollback of the switch: set `DATABASE_URL` on both services back to `${{pgvector.DATABASE_URL_PRIVATE}}` and redeploy; the role and grants do nothing while unused.

Commands run inside `worker` over `railway ssh` (the eval harness, `eval.md`) use the worker's `DATABASE_URL` and so run as `truenote_app`. Work that needs more runs as `postgres` from `pgvector`, as `scripts/src/seed-showcase.ts` already does for its backdating step.

Rules for later changes:

- A new table or sequence created by a migration in `public` or `pgboss` gets `truenote_app` row grants automatically (default privileges set by 0007). A migration adding a table the application must not read or write revokes them in the same file, as 0007 does for the ledger and the SIEM outbox.
- pg-boss creates tables only when it installs or migrates its schema and when `createQueue` meets a new queue name. `truenote_app` can do neither, so `start()` or `createQueue()` fails with `permission denied` on a missing schema, a pg-boss upgrade or a new queue. Before deploying such a change (owner's go), run `scripts/src/pgboss-install.ts` as `postgres` through an SSH tunnel to `pgvector` (backup-restore-runbook.md, section 4.4, step 5, port 5434): `DATABASE_URL=postgresql://postgres@127.0.0.1:5434/railway pnpm --filter @workspace/scripts run pgboss:install`. It installs or migrates the schema and creates every queue the code defines (a new queue must be added to the script), starts no job handlers, and refuses a non-superuser connection. The tunnel ends on the container's loopback, which `pg_hba.conf` trusts, so no password is needed. Stored queue options come from this run; the application's later `createQueue` call does not change them.
- A new SECURITY DEFINER function the application calls gets `REVOKE EXECUTE ... FROM PUBLIC` and `GRANT EXECUTE ... TO truenote_app`.

### Agent account

The owner authorized an agent account for operating and testing the site (2026-10-07): `claude-agent@truenote.org`, role `super_user`, user id `af8a8c7a-6369-4813-8c6e-fec0ccbf3cb6`, with the owner's data clearance. It was created directly inside the worker with the app's `hashPassword` and recorded as security event `admin.user.create`, so that no password had to pass through chat or an API response. The admin create-user route (`POST /api/admin/users`) works without email: it returns a one-time `tempPassword` in the response. The credentials live only on the owner's machine in `~/.claude/secrets/truenote-agent.json`; never print or commit them. Use the account through the app's own API (`POST /api/auth/login`, then the session cookie with `Origin` and, for program-scoped calls, `X-Program-Id: 00000000-0000-0000-0000-0000000000aa`), and log out when done. The demo set in `docs/demo-kb/` was uploaded this way. Deactivate the account from the admin users page if it is no longer wanted.

## Deploying

Merging to `main` deploys nothing. Each production deploy waits for the owner's go and runs `scripts/railway-deploy.mjs` on reviewed `main`.

Default path (owner decision 2026-10-10): the "Deploy production" GitHub Actions workflow (`.github/workflows/deploy-production.yml`). Run it on `main` from the Actions tab or with `gh workflow run deploy-production.yml --repo ryanportfolio/Truenote --ref main -f message="<what ships>" -f service=both`. The job targets the protected `production` environment, so it waits until the owner approves it in GitHub; only then does it receive the `RAILWAY_TOKEN` environment secret (a Railway project token for the `production` environment). It installs `@railway/cli@5.26.0` and runs the script with `--apply`. GitHub keeps the run in the environment's deployment history, and the job summary and the `release-register-rows` artifact (90 days) hold the register rows; add them to `docs/release-register.csv` through a pull request.

Fallback from the owner's workstation, from a clean worktree at freshly fetched `origin/main`:

```text
node scripts/railway-deploy.mjs                                  # dry run: prints commit and CI run, deploys nothing
node scripts/railway-deploy.mjs --apply -m "<what ships>"        # after the owner's go
```

The script refuses unless the checkout has no tracked or untracked changes, `HEAD` equals `origin/main` after a fresh fetch, and the latest "Security and quality" push run on `main` for that commit concluded `success`. It never uploads the working tree: it checks the same commit out with LF line endings into a temporary worktree (no ignored files such as `.env` or `*.tsbuildinfo`), writes the commit to `.release-commit` there (`railway up` uploads no `.git`; the evidence harness reads this file for every receipt, `artifacts/api-server/src/lib/evidence/receipts.ts`; it is gitignored and whitelisted in `.railwayignore` and `.dockerignore`), runs `railway up --detach` from there for `web`, waits for `SUCCESS`, then does the same for `worker` (`--service web|worker` for one only). The deployment message starts with the short commit, the CI run id and a random per-run nonce (`<sha12> ci <run id> run <nonce>: <what ships>`), and the script finds each deployment by that exact message. It appends one row per service to `docs/release-register.csv`: time, full commit, CI run id, service, Railway deployment id, final status, image digest and the full deployment message (with its nonce, so a row without a deployment id can still be matched in Railway), failed attempts included, one row per service as it finishes. The register row leaves the checkout dirty, so the next deploy is refused until the row is merged through a pull request. Raw `railway up` from a local folder is no longer the deploy path: it cannot show that the running code matches reviewed `main`.

Deploy both services from the same commit; they share code. The script stops on the first service that does not reach `SUCCESS` (status `FAILED`, `CRASHED`, `UPLOAD_FAILED`, `NOT_FOUND`, `TIMEOUT_*` after 25 minutes, or `POLL_FAILED`/`POLL_FAILED_*` when `railway deployment list` kept failing; the upload was accepted, so check Railway for the deployment message). Each service's row is written as soon as that service finishes; Ctrl+C or a stopped job writes the service in progress as `INTERRUPTED` and removes the temporary checkout. After `SUCCESS`, check: `/health` returns `{"ok":true}`, `/` and the changed pages return 200, `railway logs -p <project> -e <env> -s web` shows `[api-server] listening on http://0.0.0.0:8080`, and `railway logs -p <project> -e <env> -s worker` shows `[worker] ready`. Once 0011 is applied, `/health/ready` must also return 200 within a minute of the worker's start (it reports `worker: stale` or `missing` otherwise; `docs/security/monitoring.md`). For retrieval or answer changes, run one cited question (`.tmp`-style script: demo CSR login, `POST /api/ask`, expect `refused=false` with at least one source).

The image runs TypeScript through `tsx`: `scripts/railway-start.sh` execs `artifacts/api-server/src/index.ts` or `scripts/src/worker.ts`. The build runs `pnpm install --frozen-lockfile`, the typecheck of every workspace (`pnpm -r run check`) and the rag-app build; a type error fails the image. `tsx` is a dev dependency, so the image keeps dev dependencies.

Rollback: Railway keeps earlier deployments. `railway redeploy` only redeploys the latest one; to go back, use the dashboard (Deployments, Redeploy on the good one) or the GraphQL mutation `deploymentRedeploy(id)`. Add a `docs/release-register.csv` row by hand for the redeploy: the new deployment id, the commit of the deployment it copies, status `ROLLBACK`.

Recovery redeploy of a known commit. When no earlier deployment can be redeployed (for example after `railway down` in the backup restore runbook, section 4.4, step 6) and the commit to restart is not `origin/main`, the script refuses by design. Then, with the owner's go, upload that exact commit by hand from a temporary LF checkout, never from a working folder:

```text
git fetch origin
git -c core.autocrlf=false -c core.eol=lf worktree add --detach <temp dir> <commit>
cd <temp dir>
node -e "require('fs').writeFileSync('.release-commit', require('child_process').execSync('git rev-parse HEAD'))"
railway up --detach -p 2aa5cb01-5438-4fbd-aade-626d4e252977 -e b35c4090-cbcd-4deb-9434-e9b63a309bd9 -s web -m "<sha12> recovery: <reason>"
railway up --detach -p 2aa5cb01-5438-4fbd-aade-626d4e252977 -e b35c4090-cbcd-4deb-9434-e9b63a309bd9 -s worker -m "<sha12> recovery: <reason>"
```

`<commit>` must be one that ran in production before (a `docs/release-register.csv` row, or the `cliMessage` of an earlier deployment). Poll `railway deployment list -p <project> -e <env> -s <service> --json` until `SUCCESS`, remove the temporary worktree, and add one register row per service with status `RECOVERY`.

### Deploy path options (decided 2026-10-10: GitHub Actions deploy job)

The comparison behind the decision. The script alone binds each deploy to a reviewed, CI-passed commit, but runs on the owner's workstation with the owner's Railway login:

| | `scripts/railway-deploy.mjs` from the workstation | Railway GitHub autodeploy with "Wait for CI" | GitHub Actions deploy job |
|---|---|---|---|
| What is built | Temporary LF checkout of the commit, uploaded by the CLI | Railway pulls the commit from GitHub | The runner's checkout at `github.sha`, uploaded by the CLI |
| CI gate | Script checks the "Security and quality" push run | Railway waits for every GitHub Actions run on the commit; any failed workflow skips the deploy (the daily image scan failing on a fixable High finding would block deploys) | The same script check, run inside the job |
| Owner's go per deploy | Owner runs the script | Lost: every merge to `main` deploys | GitHub environment `production` with the owner as required reviewer |
| Credentials | Owner's Railway CLI login on the workstation | Railway GitHub App on the repository; no token in GitHub | A Railway project token as an environment secret, released only to the approved job |
| Record | `docs/release-register.csv` row through a pull request | Railway deployment shows the commit SHA; no register | GitHub environment deployment history, register rows in the job summary and artifact, then the register through a pull request |
| Known issues | Workstation compromise reaches production | Forum reports of "Wait for CI" skipping or never starting deploys after passing CI | Third-party actions in the repository run beside the token; pin by SHA and scope the secret to the environment |

The deploy job keeps the owner's explicit go, takes the workstation out of the normal path, and records each deploy in GitHub. The workstation path stays for when Actions is unavailable and for recovery.

## Schema changes

Production is the schema's source of truth. `lib/db/src/schema.ts` covers only the tables the app queries through Drizzle; the copied database also holds tables, constraints and the `append_security_event` function defined in `docs/security/*.sql`. Never run `drizzle-kit`.

A change is one file `lib/db/sql/NNNN_<name>.sql` (next free number), committed with the matching `schema.ts` edit when the table is bound in Drizzle. After merge, run the status line; after the owner's go, run it with `--apply`:

```text
node scripts/railway-apply-sql.mjs lib/db/sql/NNNN_<name>.sql           # status only
node scripts/railway-apply-sql.mjs lib/db/sql/NNNN_<name>.sql --apply   # one transaction + schema_migrations row
```

The script runs `psql --single-transaction` inside `pgvector` over `railway ssh` and refuses a file already recorded in `schema_migrations`. Each `railway ssh` call stays under 6,500 base64 characters (Windows caps the command line near 8,000). A file that fits goes in the same call as the apply; a larger one is first uploaded in pieces to `/tmp/truenote-sql-<sha256>.sql` in the container, then the apply call checks that file against the local hash and runs the lock, DDL and ledger insert in one transaction as before (first used for `0003`, 10.8 KB, in four pieces). A hand-run `psql -f` skips the checksum check, the advisory lock and the ledger row, so always use the script. The file must also contain no `BEGIN`/`COMMIT` of its own, since an embedded `COMMIT` ends the script's transaction before the ledger insert. Then deploy the code that needs the change, and inspect the resulting definition (`\d+ <table>`, `pg_get_constraintdef`, `pg_get_functiondef`).

Applied: `0001_schema_migrations.sql` (2026-10-07, sha256 `f33bb30e…`), `0002_eval_questions_is_protected.sql` (2026-10-08, `ff92f1c1…`), `0003_source_library.sql` (2026-10-08 12:17 UTC, `3b88f685…`, after a pre-change dump, sha256 `9fdbeb66…`; demo data only, both copies, on the owner's machine and on the volume, deleted on 2026-10-10 by owner decision), `0004_supervisor_role.sql` (2026-10-08 20:40 UTC, `a4c26c24…`), `0005_team_members.sql` (2026-10-08 20:40 UTC, `7d290e7d…`), `0006_kb_team_shortcuts.sql` (2026-10-08 20:40 UTC, `29e5904f…`), `0007_app_runtime_role.sql` (2026-10-09 19:35 UTC, `851668b5…`), `0008_security_events_append_only.sql` (2026-10-09 19:35 UTC, `e535e002…`), `0009_document_source_audit_triggers.sql` (2026-10-09 19:35 UTC, `0e930d99…`), `0010_clear_refusal_derived_titles.sql` (2026-10-09 22:08 UTC, `3b2f4368…`), `0011_monitoring_state.sql` (2026-10-10 05:01 UTC, `dbe0bcca…`), `0012_evidence_receipts.sql` (2026-10-10 05:07 UTC, `9089c8d6…`; pg-boss queue `evidence-run` created by `pgboss:install` the same morning), `0014_backup_role.sql` (2026-10-10 06:06 UTC, `130f5eef…`; role checked afterwards: login, no superuser, no inherit, connection limit 3, `default_transaction_read_only=on`, member of `pg_read_all_data` with inherit and without set, owns nothing; password set the same day with `node scripts/railway-set-app-db-password.mjs --role backup --apply`). Baseline before them: the Replit production schema as restored on 2026-10-07.

0007 creates the `truenote_app` role and its grants ("Database roles"); 0008 and 0009 install the `security_events` append-only and truncate guards and the document-version and content-source audit triggers. All three are additive and were applied in separate runs, so no pre-change dump was taken; a privilege sweep and rolled-back negative tests followed (receipt named in "Database roles"). 0010 is data only: it cleared 9 session titles derived from refused questions.

0004 adds `supervisor` to `user_role`; 0005 adds `team_members` with its guard and users cleanup triggers; 0006 adds `kb_team_shortcuts` for supervisor-recommended sources with its document and supervisor guards and users cleanup trigger. They ran in that order, in separate runs, because Postgres cannot use a new enum value in the transaction that adds it. All three are additive (one enum value, two new tables), so no pre-change dump was taken. The demo supervisor's two recommended sources were inserted by one-off SQL after `seed:showcase teams`, because the server refuses writes from demo accounts.

## Data copy from Replit (2026-10-07)

- Source: the Replit production database (Neon, Postgres 16.15, 11 MB). Confirmed as production by logging in to `truenote.org` as the demo CSR and seeing the new `sessions` row appear in it.
- Dump from inside `pgvector` (`pg_dump` 18.6, read-only transaction, custom format, `--no-owner --no-acl`), excluding the `_system` and `pgboss` schemas and the data of `sessions` and `password_reset_tokens`. `CREATE EXTENSION` for `vector`, `pg_trgm`, `pgcrypto` ran first; `pg_restore --single-transaction --exit-on-error` succeeded. The dump was deleted from the container afterwards.
- Checked: exact row counts equal in 18 of 19 public tables (`sessions` 3 → 0 by design); check, foreign-key, primary-key and unique constraint definitions hash-identical; `append_security_event` body identical; index count 58 = 58. Postgres 18 adds 106 `NOT NULL` rows to `pg_constraint` that 16 does not list.
- Every user signs in again. The pg-boss schema was recreated empty by the first boot.
- Stored files: not copied (owner decision, 2026-10-07). The database references 8 objects under `uploads/` (2 demo PDFs, 4 versions each) that stay in the Replit bucket. Answers and citations still work because they come from the database, but a rescan or re-ingest of those 8 versions fails on Railway. A new demo set (`docs/demo-kb/`) was uploaded through the app to replace them.

## Cutover

At the switch, the old demo documents and their missing originals were the only known gap (see "Data copy"); no other stored file existed.

The owner switched DNS on 2026-10-07 at about 19:50 EDT (23:50 UTC) in Replit's DNS screen for `truenote.org` (domain registered at Name.com through Replit; the screen offers A, TXT, CNAME and MX only, so no ALIAS and no apex CNAME). Records now published, checked on the 1.1.1.1, 8.8.8.8 and 9.9.9.9 resolvers:

| Type | Name | Value |
|---|---|---|
| TXT | `_railway-verify` | `railway-verify=8f4ffbd7f9ce50b2c4711841d1234d75efd015ef0fb0b21717d88b7106114002` |
| TXT | `_railway-verify.www` | `railway-verify=00c49e3f78e2f9c1d4c18b5b14b17d9ea32f1c3a6050b818b6c851c95a072e08` |
| A | `@` | `69.46.46.101` (replaced `34.111.179.208`, the Replit deployment) |
| A | `www` | `69.46.46.24` (new) |

Certificates issued: Let's Encrypt, at about 23:57 UTC (19:57 EDT) on 2026-10-07, a few minutes after the switch (Railway showed `VALIDATING_OWNERSHIP` until then). `truenote.org` from issuer YR2, `www.truenote.org` from issuer YE2; both valid until 2027-01-05, served over TLS 1.3, each with 2 SCTs.

Railway asked for CNAMEs to `wh7hdrd8.up.railway.app` (apex) and `8v3dq8ce.up.railway.app` (`www`); the A values are those hosts' addresses at the switch. Railway's edge IPs are not guaranteed stable, so check from time to time that the targets still resolve to these addresses; a registrar with ALIAS records removes that risk. Leave the existing `replit-verify` TXT in place until Replit is retired.

Checked after issuance on `https://truenote.org`: `/health`, `/`, `/about`, `/security`, `/security/pci` and an SPA route return 200; `/api/me` returns 401 without a session; `https://www.truenote.org/<path>` answers 308 to `https://truenote.org/<path>` with the query kept; `http://` on both hosts answers 301 to `https`; responses carry `Server: railway-hikari` and `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`; the demo CSR login returns 200 with a `Secure`, `HttpOnly`, `SameSite` cookie; two questions returned cited answers; a POST with a foreign `Origin` returns 403; a fresh headless Chrome profile loads both hosts. Browsers that visited before issuance can keep showing certificate errors from cached state (`pitfalls.md`, 2026-10-07).

Rollback: set the apex A record back to `34.111.179.208` and remove the `www` A record. Replit stays deployed and untouched until the owner retires it. Data written on Railway after the switch does not flow back to Replit; with demo data only, the owner accepted that.

## After cutover

- `CORS_ALLOWED_ORIGINS` (the Railway URL) stays set for now; remove it once nobody uses the Railway URL.
- Backups: decided on 2026-10-10 ("Production" table, row Backups). The `pgvector` public TCP proxy was closed on 2026-10-08 (owner decision); after the deletion `/health` answered 200 on both hosts, `pgvector` was not redeployed, and the worker's `pgboss` connections over the private network stayed up.
- Connection logging: on 2026-10-09 (owner decision) `ALTER SYSTEM SET log_connections = 'receipt,authentication,authorization'` plus `pg_reload_conf()` on `pgvector`; no restart. The value lives in `postgresql.auto.conf` on the volume. `railway logs -s pgvector` shows `connection received`, `connection authenticated` and `connection authorized` lines. The Railway variables `PGHOST` and `PGPORT` on `pgvector` now resolve empty and `DATABASE_URL` has no host, but the running container (not redeployed since 2026-10-08) still holds the deleted proxy host, which now answers as an unrelated Postgres server. A `pgvector` redeploy, which restarts the database, clears it; until then, and always, pass `-h localhost -p 5432` inside the container.
- Email: `RESEND_API_KEY` on `web` and `worker` was replaced on 2026-10-07 and went live with the 988bf12 deploy; Resend accepts it (`GET /domains` returns 200). `RESEND_FROM_EMAIL` is `no-reply@corewise.video`, a verified Resend domain. `truenote.org` is added in Resend but not verified (status `not_started`, no DKIM records), so mail cannot be sent from a `truenote.org` address yet. No password-reset email has been sent end to end since the change.
