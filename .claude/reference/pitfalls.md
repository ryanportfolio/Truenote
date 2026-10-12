# Project-Specific Pitfalls

> Living list. Grows via `/recall save <text>` when something bites you. Read before non-trivial work.

## 2026-10-11: Node 24 processes are named `MainThread` in `/proc`

Node 24 renames its main thread, so the `Name:` line of `/proc/<pid>/status` (and `comm`) reads `MainThread` instead of `node`. Moving the scanner image's Node stage from 22 to 24 failed `scanner-image.yml`'s root-start check with `no node process found`, though the smoke tests passed. Identify processes by argv[0] from `/proc/<pid>/cmdline` (or by `/proc/<pid>/exe` where readable). Matching every `node` then caught Docker's `HEALTHCHECK` (`node -e ...`), which Docker runs as the container user, root in the `--user 0` test, so the check also needs the script name (`node:server.mjs`). Cost: two failed CI runs on #265.

## 2026-10-11: A deploy ships every commit since the live one, including SQL it needs

The deploy of `main` at `12fc7b1d` (live 2026-10-11 01:59 UTC) had been put to the owner as the changes merged since the asking session's own last deploy, not since the commit then live (`15141354`). It also shipped #226 and #209, whose code reads `users.locked_until` from `0015`-`0017`, which were not applied, and every login answered 500 until they were. Before asking for a deploy, take the live commit from the newest rows of `docs/release-register.csv` (or `railway deployment list`), run `git diff --stat <live> origin/main` and `git diff --name-only <live> origin/main -- lib/db/sql`, and list every SQL file the target needs that `schema_migrations` lacks.

## 2026-10-11: `railway volume add --mount-path /data` in Git Bash fails

Git Bash rewrote `/data` to a Windows path and the CLI answered `Mount path must start with a /`. Prefix `MSYS_NO_PATHCONV=1` for any Railway command taking a container path (`--mount-path`, variable values such as `SCANNER_DATABASE_DIR=/data/clamav`).

## 2026-10-10: A PR without the change record fails CI

PR #215 was opened with a free-form body; the "Verify pull-request change record" step of "Typecheck, build, tests" failed with `missing field: ...` for every field of `.github/pull_request_template.md`, and the PR had to be edited. Fill the template (Change ID `TN-CHG-<year>-<PR number>`, `Author: @ryanportfolio`, single-owner wording for 6.5.4 and the reviewer as in recent merged PRs) and check it before `gh pr create`: `corepack pnpm --filter @workspace/scripts run verify:change-record -- --body <file> --allow-pending`. Without `--allow-pending` it also demands `approved` and a named reviewer, which CI does not.

## 2026-10-10: `railway ssh -- sh -c '<script>'` runs only the first word

`railway ssh` joins the words after `--` with spaces into one remote command line, so the remote shell re-splits the quoted script: `sh -c 'psql -h localhost ...'` ran `psql` with no arguments, which used the container's stale `PGHOST` and tried to log in to an unrelated server. Pass a script as base64 (`"echo <b64> | base64 -d | sh"`, as `scripts/railway-set-app-db-password.mjs` does) or pass the command's own words with no `sh -c`, quoting any SQL twice: `railway ssh ... -- psql -h localhost -p 5432 -U postgres -d railway -X -At -c "'select 1'"`. In Git Bash also set `MSYS_NO_PATHCONV=1`, or remote paths such as `/var/lib/postgresql` arrive as `C:/Program Files/Git/var/lib/postgresql`.

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

### 2026-10-10: Two CI gates fail on content, not code

`Typecheck, build, tests` runs two document gates before the tests. (1) `verify:change-record` parses the pull-request body: every heading and `- Field:` line of `.github/pull_request_template.md` must be present and filled, so a free-form PR body fails with `missing field: ...`. Exception: a PR opened by `dependabot[bot]` that changes only `package.json` files, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, Dockerfiles or workflow files passes without the record (automated dependency update); the step lists the changed files with `git diff --name-only HEAD^1 HEAD`. Copy the template sections into the body (a merged PR such as #205 shows filled values) and check locally with `verifyChangeRecord` from `scripts/src/change-record.ts`. Editing the body reruns the check. (2) `verify:pci-evidence` pins the LF SHA-256 of `docs/compliance/pci/threat-model.md` in the newest dated `verification-record-*.md`. Any threat-model edit makes it stale: add a new dated record (copy the previous one, pin `git show HEAD:<path> | sha256sum` with `MSYS_NO_PATHCONV=1`), point `CURRENT_VERIFICATION_RECORD` in `scripts/src/verify-pci-evidence.ts` at it, and link it from `docs/compliance/pci/README.md`. Run locally on Windows, the gate always reports both pinned hashes stale because of CRLF checkouts; only CI's result counts. Cost on #221: two failed CI runs.

### 2026-10-10: Stopping processes by a command-line pattern kills other sessions' work

Several sessions work in sibling worktrees at once and run the same tools, so their process command lines look alike. On 2026-10-10 a `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*codex-fullreview*' } | Stop-Process` meant to end one session's Codex review also killed another session's review (its run directory had the same `codex-fullreview-` prefix) and the calling shell itself, whose own command line contained the pattern. `TaskStop` on a background Bash task can leave its children running (`codex.exe`, `ssh.exe`), which is what invited the pattern kill. Fix: stop only processes you started, by PID. Record the PID at launch (for example `echo $! > <run dir>/pid` after starting in the background), or match on the full, unique run-directory path plus your own worktree path, and list the matches before stopping anything.

## 2026-10-11: Dependabot `ignore` versions did not match Docker tags

`.github/dependabot.yml` ignored `node` with `versions: ["25.x", "27.x", "29.x"]`, yet Dependabot opened #266 (`24-bookworm-slim` to `25-bookworm-slim`) and #267 (scanner, `24-trixie-slim` to `25-trixie-slim`). The version list did not match tags with a suffix. The rule now ignores `update-types: ["version-update:semver-major"]` for `node`, so Node majors are planned changes; digest updates within the major still arrive.

### 2026-10-11: "Debugger attached." in the `worker` logs did not come from the repo

Worker deployment `6ce3ded0` (the #260 deploy) logged `Debugger listening on ws://127.0.0.1:9229/...` and, 130 ms later, `Debugger attached.` twice: 8 s after the container started (16:22Z) and 6 s after the crash-restart caused by the pgvector switch (18:28Z). No other worker, web, scanner, backup or pgvector deployment since 2026-10-08 shows the lines. Nothing in the repo or the Railway variables turns the inspector on: no `--inspect`, `NODE_OPTIONS` or `node:inspector`, the start command is the Dockerfile `CMD`, and only dev dependencies reference the inspector. No SSH session reached the worker before 18:30Z (Railway project events), and no Claude or Codex session on this PC sent `SIGUSR1` or touched port 9229. The pattern matches a `SIGUSR1`-activated inspector that a local client attaches to at once, which is how OpenTelemetry eBPF Instrumentation (behind Railway's automatic tracing) injects its agent into Node. Tracing is off on every service and no event records a toggle, so the source is unconfirmed. Exposure: the inspector binds loopback only, the worker has no public domain, and anything able to signal the process already runs as `node` inside the container. Checked 2026-10-12: `127.0.0.1:9229` refuses connections in `web` and `worker`. If it recurs, record the deployment ID and timestamps and ask Railway support. Railway log and event timestamps are server time; this PC's clock ran 4 min 33 s slow that day, so convert before matching them against session transcripts.

### 2026-10-11: `cut -d= -f1` on `/proc/<pid>/environ` prints multi-line values

Listing a container's variable names with `tr "\0" "\n" < /proc/<pid>/environ | cut -d= -f1` printed every line of `EVIDENCE_SYNTHETIC_ACCOUNTS` after its first, because a JSON value spans lines and `cut` passes lines without `=` through whole. That put synthetic account passwords and canary tokens into a session transcript. List names with `grep -zo '^[^=]*' /proc/<pid>/environ | tr '\0' '\n'`, or with `railway variables --json` piped to a filter that prints only the keys.
