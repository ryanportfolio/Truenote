# Deployment

Production moved from Replit to Railway on 2026-10-07. The Railway stack runs with a copy of the Replit production data taken that day, and the owner switched `truenote.org` and `www.truenote.org` DNS to Railway at about 19:50 EDT the same day (see "Cutover").

The Railway CLI stores `railway link` per directory, so a fresh worktree is not linked; every `railway` command here passes `-p 2aa5cb01-5438-4fbd-aade-626d4e252977 -e b35c4090-cbcd-4deb-9434-e9b63a309bd9` (written `-p <project> -e <env>` below where it would repeat).

## Production

| Item | Value |
|---|---|
| Project | `truenote`, `2aa5cb01-5438-4fbd-aade-626d4e252977` |
| Environment | `production`, `b35c4090-cbcd-4deb-9434-e9b63a309bd9` (the only environment; there is no dev database) |
| `web` | `72fa55df-61f3-421c-a411-4f9e6bbbd49f`. api-server serving `/api` and the built SPA, `TRUENOTE_PROCESS=web`, `PORT=8080`, one replica. Healthcheck `/health` (120 s), restart `ON_FAILURE` ×3, draining 15 s |
| `worker` | `5dc3e0f3-86f9-4f4e-95b2-4729ad13fdae`. pg-boss ingestion and evaluation worker, `TRUENOTE_PROCESS=worker`, restart `ALWAYS`, no public port |
| Database | service `pgvector` (`0d1e7840-7d5e-4a20-a97e-d04f06a88649`), image `pgvector/pgvector:pg18`, volume `pgvector-volume` at `/var/lib/postgresql`. Extensions `vector`, `pg_trgm`, `pgcrypto`. The template also opens a public TCP proxy on 5432; the app uses `DATABASE_URL_PRIVATE` |
| Object storage | bucket `truenote-storage` (`cefc54e5-6980-46d3-b3e6-bb31942c4eda`, physical `truenote-storage-w0ha8kzq`, region `iad`), endpoint `https://t3.storageapi.dev`, virtual-host style. Keys keep the Replit layout `uploads/<sha256>-<name>` |
| Hosts | `web-production-62818.up.railway.app`; custom domains `truenote.org` and `www.truenote.org`, DNS pointed at Railway since 2026-10-07. The app answers `www` with a 308 to `APP_BASE_URL` |
| Build | `Dockerfile.railway` (service setting `dockerfilePath`, plus `RAILWAY_DOCKERFILE_PATH`), uploaded with `railway up`; `.railwayignore` and `.dockerignore` whitelist the build inputs |
| Backups | none yet (open decision); the `pgvector` volume is the only copy of data written on Railway |

Run one replica of `web` and scale vertically: the forgot-password and login IP limiters (`artifacts/api-server/src/lib/auth/rate-limit.ts`) live in process memory. The ask and workload limits are in Postgres and hold across replicas.

### Variables

Set per service (values never in git or chat; the owner's source file is `Desktop\Secrets.txt`):

- Both: `DATABASE_URL=${{pgvector.DATABASE_URL_PRIVATE}}`, `RAG_STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (from `railway bucket credentials`), `APP_BASE_URL=https://truenote.org`, `CORS_ALLOWED_ORIGINS=https://web-production-62818.up.railway.app`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `COHERE_API_KEY`, `VISION_AGENT_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `MIN_PASSWORD_LENGTH`, `DEMO_LOGIN_ACCOUNTS`, `RAILWAY_DOCKERFILE_PATH`, `TRUENOTE_PROCESS`.
- `web` only: `PORT=8080`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`.

`CORS_ALLOWED_ORIGINS` is what lets the Railway URL pass the CSRF origin check while `APP_BASE_URL` already names the final domain. Not set on Railway: `SESSION_SECRET` and `MISTRAL_API_KEY` (no code reads them), `BOOTSTRAP_SUPER_USER_*` (the copied database has its super user), OIDC, malware scanner and SIEM variables (unset on Replit too).

`railway variable set KEY --stdin --skip-deploys -p <project> -e <env> -s <service>` batches changes without a redeploy; `railway variable delete` always redeploys.

### Agent account

The owner authorized an agent account for operating and testing the site (2026-10-07): `claude-agent@truenote.org`, role `super_user`, user id `af8a8c7a-6369-4813-8c6e-fec0ccbf3cb6`, with the owner's data clearance. It was created directly inside the worker with the app's `hashPassword` and recorded as security event `admin.user.create`, so that no password had to pass through chat or an API response. The admin create-user route (`POST /api/admin/users`) works without email: it returns a one-time `tempPassword` in the response. The credentials live only on the owner's machine in `~/.claude/secrets/truenote-agent.json`; never print or commit them. Use the account through the app's own API (`POST /api/auth/login`, then the session cookie with `Origin` and, for program-scoped calls, `X-Program-Id: 00000000-0000-0000-0000-0000000000aa`), and log out when done. The demo set in `docs/demo-kb/` was uploaded this way. Deactivate the account from the admin users page if it is no longer wanted.

## Deploying

Merging to `main` deploys nothing. Each production deploy waits for the owner's go. From a worktree checked out at freshly fetched `origin/main`:

```text
railway up --detach -p 2aa5cb01-5438-4fbd-aade-626d4e252977 -e b35c4090-cbcd-4deb-9434-e9b63a309bd9 -s web -m "<what ships>"
railway up --detach -p 2aa5cb01-5438-4fbd-aade-626d4e252977 -e b35c4090-cbcd-4deb-9434-e9b63a309bd9 -s worker -m "<what ships>"
```

Deploy both services from the same commit; they share code. Poll `railway deployment list -p <project> -e <env> -s <service> --json` until `SUCCESS`, then check: `/health` returns `{"ok":true}`, `/` and the changed pages return 200, `railway logs -p <project> -e <env> -s web` shows `[api-server] listening on http://0.0.0.0:8080`, and `railway logs -p <project> -e <env> -s worker` shows `[worker] ready`. For retrieval or answer changes, run one cited question (`.tmp`-style script: demo CSR login, `POST /api/ask`, expect `refused=false` with at least one source).

The image runs TypeScript through `tsx`: `scripts/railway-start.sh` execs `artifacts/api-server/src/index.ts` or `scripts/src/worker.ts`. The build runs `pnpm install --frozen-lockfile`, the typecheck of every workspace (`pnpm -r run check`) and the rag-app build; a type error fails the image. `tsx` is a dev dependency, so the image keeps dev dependencies.

Rollback: Railway keeps earlier deployments. `railway redeploy` only redeploys the latest one; to go back, use the dashboard (Deployments, Redeploy on the good one) or the GraphQL mutation `deploymentRedeploy(id)`.

## Schema changes

Production is the schema's source of truth. `lib/db/src/schema.ts` covers only the tables the app queries through Drizzle; the copied database also holds tables, constraints and the `append_security_event` function defined in `docs/security/*.sql`. Never run `drizzle-kit`.

A change is one file `lib/db/sql/NNNN_<name>.sql` (next free number), committed with the matching `schema.ts` edit when the table is bound in Drizzle. After merge, run the status line; after the owner's go, run it with `--apply`:

```text
node scripts/railway-apply-sql.mjs lib/db/sql/NNNN_<name>.sql           # status only
node scripts/railway-apply-sql.mjs lib/db/sql/NNNN_<name>.sql --apply   # one transaction + schema_migrations row
```

The script runs `psql --single-transaction` inside `pgvector` over `railway ssh` and refuses a file already recorded in `schema_migrations`. It sends the whole command in one `railway ssh` call and refuses anything over 6,500 base64 characters (Windows caps the command line near 8,000); after its wrapper and the SQL's own base64 encoding, that leaves about 2.7 KB of SQL per file, so split a larger change into several numbered files. Then deploy the code that needs the change, and inspect the resulting definition (`\d+ <table>`, `pg_get_constraintdef`, `pg_get_functiondef`).

Applied: `0001_schema_migrations.sql` (2026-10-07, sha256 `f33bb30e…`). Baseline before it: the Replit production schema as restored on 2026-10-07.

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
- Decide on backups (logical dumps to the bucket or volume snapshots) and on closing the `pgvector` public TCP proxy.
- Email: the `RESEND_API_KEY` in the owner's secrets is not a Resend key (`API key is invalid` on 2026-10-07), and `truenote.org` has no Resend DKIM records, so password-reset email fails on both hosts until a valid key and a verified sending domain exist.
