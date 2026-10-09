# Project-Specific Pitfalls

> Living list. Grows via `/recall save <text>` when something bites you. Read before non-trivial work.

## 2026-10-09: Railway SSH needs an existing SSH client on the process PATH

In the Codex desktop shell, `railway ssh` authenticated but failed with `Failed to execute ssh command: program not found`. Windows OpenSSH was absent; Git's client existed at `C:\Program Files\Git\usr\bin\ssh.exe`. Prepending that directory to the current process PATH made the same read-only catalog command succeed. Check existing clients before treating this as missing Railway access or installing anything. No persistent PATH or account change is needed. Cost: one failed catalog attempt.

## 2026-05-19: Vite's dev proxy forwards only `/api/*`

In local dev, `artifacts/rag-app/vite.config.ts` reads `API_PORT` at startup and proxies `/api/*` to `localhost:$API_PORT`; the frontend does not need the api-server port at build time. `/health` is not under `/api`, so a local smoke test hits the api-server directly: `curl localhost:$API_PORT/health`, not the Vite port.

## 2026-05-19 — pg-boss v10 silently drops `send()` to unregistered queues

If you `boss.send('some-queue', payload)` without first calling `boss.createQueue('some-queue', opts)`, pg-boss v10 returns `null` (no error, no warning, no row in `pgboss.job`). The worker side `boss.work('some-queue', …)` waits forever. The send appears to succeed (no exception), the upload flow flips to `parsing`, and nothing ever runs. Classic silent-partial-success — the bug class our meta-pattern flags.

Fix in code: `artifacts/api-server/src/lib/jobs/boss.ts` exports `ensureQueue(boss, name, policy)`, which calls `boss.createQueue(name, { name, ...policy })`. Every send and work path calls it first: `lib/ingestion/queue.ts` (`enqueueIngestion` in the api-server, `startIngestionWorker` in the worker process `scripts/src/worker.ts`) and `lib/eval/queue.ts`. The wrapper swallows "already exists", duplicate and unique-constraint errors, because the api-server and the worker can race on first boot and some pg-boss versions surface the unique error even though the SQL is idempotent.

Detection rule for the next change: if you add a new pg-boss queue, you MUST call `ensureQueue` on it from every process that sends OR works it. If you forget, the symptom is "uploads stuck in `parsing` forever, no worker log lines, no error anywhere" — and you'll spend an hour staring at the worker before realizing the job never landed.

Confirmation method when in doubt: `SELECT name, state FROM pgboss.job ORDER BY created_on DESC LIMIT 10;` against the production database (Railway `pgvector`). If your send appeared to succeed but no row shows up, the queue isn't registered.

## 2026-05-19 — Firefox sends `application/octet-stream` for `.md` uploads

Firefox (and some Chrome configs) don't have a built-in MIME mapping for `.md`. The browser sends `application/octet-stream` in the multipart upload, the server-side `ACCEPTED_MIMES` check fails, and the user sees a generic "file type not accepted" rejection on a perfectly valid markdown file.

Fix in code: `artifacts/api-server/src/routes/documents.ts` defines `normalizeMimeType(mimetype, originalName)`, which sniffs the filename extension when the browser-provided MIME is empty or `application/octet-stream`. The upload route calls it before the `ACCEPTED_MIMES.has(…)` check, and the canonical normalized value is what gets persisted on `document_versions.mime_type`.

Detection rule for the next change: when adding a new accepted file type, extend `normalizeMimeType`'s extension table FIRST, then add the canonical MIME to `ACCEPTED_MIMES`. Never trust `file.mimetype` raw — it's whatever the browser felt like sending. Test from both Firefox and Chrome before declaring done.

Meta-pattern (also see pg-boss above): browser-provided values are user input. Treat them like any other untrusted input — normalize at the boundary, validate the normalized form.

## 2026-05-19: `citext` broke production; emails are lowercased in the app

Phase 2A's `users` table originally used `citext` for case-insensitive email comparison. The extension existed where the DDL was first tried, but the production deploy-time migration did not run `CREATE EXTENSION`, so `CREATE TABLE users (... email citext NOT NULL ...)` failed with `type "citext" does not exist`. An extension present in one database and absent in production works until deploy, then fails.

Fix applied (commit `c908ddf` on main): swap `citext` for plain `text` and normalize emails at the application layer; every write and lookup calls `.toLowerCase()` first. See `lib/db/src/schema.ts` (email column), `bootstrapSuperUser` in `artifacts/api-server/src/lib/auth/bootstrap.ts` (insert path), and the login route in `artifacts/api-server/src/routes/auth.ts`. Net behavior is identical to citext for our access patterns.

**Detection rule for the next change:** the only extensions confirmed on Railway `pgvector` are `vector`, `pg_trgm` and `pgcrypto` (`deployment.md`). A new extension needs `CREATE EXTENSION IF NOT EXISTS` in its `lib/db/sql/` file and a check on `pgvector` that it installed before any code depends on it; otherwise plan an app-layer fallback.

**Cross-cutting rule for any new code touching `users.email`:** lowercase before write, lowercase before compare. Two `Alice@foo.com` users would otherwise pass uniqueness and break login. Same applies to any future user-management routes (Phase 2C.2) — bake the normalization into the route helpers, don't trust callers.

## 2026-07-11 — `read-excel-file` bare import fails the build; use the `/browser` subpath

Adding `.xlsx` support to the bulk user import, the natural `await import("read-excel-file")` compiled cleanly in review but **broke the production build** with `TS2307: Cannot find module 'read-excel-file' or its corresponding type declarations`. The package publishes only subpath entries (`read-excel-file/browser`, `read-excel-file/node`) with no usable root `.` export under this repo's `moduleResolution`, so the bare specifier resolves to nothing.

Fix (commit `cfc2ea8` on main), in `artifacts/rag-app/src/pages/AdminUsers.tsx`:
- Import the client entry explicitly: `await import("read-excel-file/browser")` (the `/node` build pulls in `fs` and won't bundle for Vite).
- The browser build types its rows as `Sheet<number>[]`, which doesn't structurally satisfy `parseUserXlsx`'s `ReadonlyArray<ReadonlyArray<unknown>>`, so the call site needs a `as unknown as ReadonlyArray<ReadonlyArray<unknown>>` double-cast. Harmless — `parseUserXlsx` stringifies every cell at runtime, so the cast only relaxes compile-time.

**Detection rule / meta-lesson:** after adding an app-runtime dep, install it locally and run `pnpm -r run check`. A subpath-only package fails there with TS2307, and the Railway image build (`pnpm install --frozen-lockfile`, then the api-server check and the rag-app `tsc --noEmit && vite build`) fails the same way. Before writing the import, check the package's `package.json` `exports`: if it has no root `.` entry (subpath-only, common for dual browser/node libs), import the explicit `/browser` (client) subpath in the Vite app rather than the bare name, and expect the subpath's row/cell types may need a cast to your own parser signature.

**Follow-up (same day) — and the type gate isn't a *runtime* gate.** Once it built, the upload still failed at runtime: `row.map is not a function`. `read-excel-file` **v9's default export returns `Sheet[]`** — an array of `{ sheet: string; data: Row[][] }` objects, NOT the flat `Row[][]` grid older versions returned. The parser was handed the whole `[{sheet,data}, …]` array and choked mapping over sheet objects. Fix: reduce to the first sheet's `.data` (`parseUserXlsx` now accepts the reader's raw `unknown` output and normalizes both the v9 `Sheet[]` and a legacy `Row[][]` shape). The double-cast the build needed actively *hid* this — casting `Sheet[]` to `ReadonlyArray<ReadonlyArray<unknown>>` silenced the very mismatch that crashed at runtime. Lesson: `tsc` passing on a **cast** proves nothing about runtime shape; when a dep's return type needs a cast to fit your code, verify the actual returned value's shape (read the `.d.ts` return type — here `Promise<Sheet<ParsedNumber>[]>` — not just "does it compile"). Surfacing the caught error's `.message` in the UI is what made this diagnosable at all.

### 2026-07-15: pnpm 10 dependency audit endpoint retired

`pnpm audit` can fail with HTTP 410 even when dependency state is unchanged because pnpm 10 calls npm's retired legacy audit endpoint. Keep the project's install and test toolchain pinned, but run the CI audit with a pinned pnpm 11 binary and `--pm-on-fail=ignore` so the audit-only major can read the pnpm 10 project (`.github/workflows/security.yml`, step "High-severity production dependency audit"). A successful typecheck and test run does not make this failure safe to ignore; the replacement audit must pass before merge.

### 2026-07-17: PR checks reflect only pushed commits, and CodeQL cannot see custom controls

GitHub PR checks and review suggestions remain attached to the last pushed commit; a locally passing fix does not change the PR until the branch is pushed. Gitleaks scans the complete PR commit range, so replacing a synthetic credential-shaped fixture at the tip does not remove the historical finding; retain only the exact historical fingerprint in `.gitleaksignore` after verifying the bytes are synthetic. CodeQL's Express queries do not recognize Truenote's custom Postgres-backed workload limiter or application-wide Origin/Fetch-Metadata CSRF middleware, so verify the exact middleware implementation, route order, and negative tests before recording a narrow false-positive disposition. The PR change-record gate permits an explicitly pending decision with a specifically explained unassigned reviewer, while the verifier's default strict mode still requires real approval and a distinct reviewer.

### 2026-10-07: pnpm on Windows drops `libc:` lines from the lockfile

`corepack pnpm --filter @workspace/api-server add ...` on Windows rewrote `pnpm-lock.yaml` without the 17 `libc: [glibc]` / `libc: [musl]` lines under `packages:` (argon2, rollup and esbuild Linux binaries). Linux builds then cannot tell the glibc and musl variants apart. Restore them from `origin/main`'s lock before committing; they belong only in the `packages:` section, never under `snapshots:` (a first restore pass that matched both sections had to be undone). Check: `git diff pnpm-lock.yaml` shows no removed lines for a pure add, and `corepack pnpm install --frozen-lockfile` passes. Cost: two fix passes.

### 2026-10-07: Inside the Railway `pgvector` container, `PGPORT` points at the TCP proxy

The pgvector template sets `PGPORT` (and `PGHOST`) to its public TCP proxy. `psql`/`pg_dump` apply `PGPORT` to any URL without an explicit port, so connecting from that container to another database (the Replit Neon source) went to port 40423 and timed out. Put `:5432` in external URLs, and pass `-h localhost -p 5432` for the local database. Cost: one retry. The proxy was closed on 2026-10-08, but the running container still holds those values, and since then that address answers as an unrelated Postgres server (checked 2026-10-09): a bare `psql` there attempts a login on someone else's database. The same rule applies until `pgvector` is redeployed.

### 2026-10-07: Browsers keep certificate errors from before issuance after a DNS switch

After `truenote.org` moved to Railway, Railway needed a few minutes to issue the Let's Encrypt certificates. Browsers that loaded the site in that window kept failing after issuance from cached state: Chrome with `NET::ERR_CERT_COMMON_NAME_INVALID`, Firefox with `MOZILLA_PKIX_ERROR_INSUFFICIENT_CERTIFICATE_TRANSPARENCY`, while a fresh headless Chrome profile loaded both hosts. Chrome clears with `chrome://net-internals/#sockets`, "Flush socket pools"; Firefox with a restart or a private window. The CoreWise domain move hit the same. Check a new certificate from a fresh profile or `curl` before treating a browser error as a server fault.

### 2026-10-07: `railway environment edit --service-config` changes nothing (CLI 5.26)

`railway environment edit --service-config web deploy.healthcheckPath /health` (by service name or ID, one flag or several) answered `{"committed":false,"message":"No changes to apply"}`. Set service-instance settings through GraphQL instead: `serviceInstanceUpdate(serviceId, environmentId, input: { dockerfilePath, healthcheckPath, healthcheckTimeout, restartPolicyType, restartPolicyMaxRetries })` at `https://backboard.railway.com/graphql/v2` with the CLI's token from `~/.railway/config.json`. The `Builder` enum has no `DOCKERFILE` value; setting `dockerfilePath` switches the builder on its own. Cost: three failed attempts.

### 2026-10-07: The SPA build needs `docs/security/` in the Railway upload

`artifacts/rag-app/vite.config.ts` embeds `docs/security/truenote-security-capabilities.html` and the PCI page into the build. With `docs/` missing from the `.railwayignore` whitelist, the image build failed with the misleading `ENOENT: no such file or directory, scandir '/app/artifacts/rag-app/dist/assets'` from the precompress plugin, which runs after the real failure. Keep `!docs/` and `!docs/**` in both `.railwayignore` and `.dockerignore`. Cost: one failed build.

### 2026-10-07: Bracketed text in a quoted excerpt fails answer validation

`validateGeneratedAnswer` treated every `[...]` token in an answer as an inline citation id. When the model quoted source text that contained square brackets, the bracketed words became an unknown citation, every answer route failed with `unknown_citation_ids`, and the question was refused after about 15 seconds. Two sources of brackets were seen on Railway: a placeholder written into a document (`[your first name]` in the demo call script, now `(your first name)`), and OpenRouter's account guardrail (person-name detection, a beta setting outside this repo), which rewrote "Thank you for calling Larkspur Cloud" as `[PERSON_NAME]` before generation. Diagnose from `error_log.details.context.validation`: `unknownCitationIds` names the offending token. Fixed 2026-10-07: only citation-shaped brackets count as citations (see `retrieval.md`, Generation contract); plain bracketed text in documents is safe again. Cost: one wrong first fix (the document placeholder alone did not clear the refusal).

### 2026-10-09: A Railway redeploy rebuilds the image and can hit Docker Hub's pull limit

A `railway variable set` without `--skip-deploys` and `railway redeploy` both rebuild the latest deployment's uploaded snapshot from `Dockerfile.railway`, so they pull `node:22-bookworm-slim` from Docker Hub again. On 2026-10-09 three `worker` redeploys failed in the build (`429 Too Many Requests` on `registry-1.docker.io`): Railway's shared builders pull anonymously, and Docker Hub limits anonymous pulls per IP. Two of the three logs stopped at `scheduling build on Metal builder` with no error line. The previous deployment kept running each time; the next build, about an hour later, went through. Fix: wait and retry. When a variable change must not ship unwatched, set it with `--skip-deploys` and deploy deliberately, or set it back with `--skip-deploys` after a failed build. A mirror for the base image was reviewed and declined by the owner (closed PR #207); it remains the fallback if 429s block builds for a day or more.

### 2026-10-09: `SET ROLE` in a superuser `psql` session can escape a role test

Privilege tests that `SET LOCAL ROLE truenote_app` inside the `pgvector` container still run with `postgres` as the session user, so a `SET ROLE postgres` in the test list succeeds and every later statement runs as the superuser (it disabled the append-only trigger inside a rolled-back test transaction). Never include `SET ROLE` among the statements under test; check membership with `pg_has_role('truenote_app', 'postgres', 'MEMBER')` instead, and keep such tests in a transaction that ends in `ROLLBACK`.
