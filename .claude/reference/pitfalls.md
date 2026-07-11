# Project-Specific Pitfalls

> Living list. Grows via `/recall save <text>` when something bites you. Read before non-trivial work.

## 2026-05-19 — Replit reserves port 5000 for the webview

The donor `.env.example` defaulted `API_PORT=5000` and `PORT=5173` (Express + Vite local-dev convention). On Replit, **port 5000 is reserved for the public webview** — the rag-app (Vite) must bind 5000 to be reachable, and the api-server has to move.

Working configuration verified end-to-end Phase 1 smoke (2026-05-19):

```
PORT=5000        # rag-app (Vite) — webview, externally exposed
API_PORT=3001    # api-server (Express) — internal only
```

Why it just works without code changes: `artifacts/rag-app/vite.config.ts` reads `API_PORT` at startup and configures the `/api` proxy target accordingly. The frontend doesn't need to know the api-server port at build time.

Side effects to remember:
- `curl /health` smoke tests have to hit `localhost:3001` (or whatever `API_PORT` is set to) from inside the repl — Vite's proxy only forwards `/api/*`, not `/health`.
- If a workflow refuses to start with EADDRINUSE on 5000, that's the webview slot, not a stale process. Use a different port for everything except the public frontend.

## 2026-05-19 — pg-boss v10 silently drops `send()` to unregistered queues

If you `boss.send('some-queue', payload)` without first calling `boss.createQueue('some-queue', opts)`, pg-boss v10 returns `null` (no error, no warning, no row in `pgboss.job`). The worker side `boss.work('some-queue', …)` waits forever. The send appears to succeed (no exception), the upload flow flips to `parsing`, and nothing ever runs. Classic silent-partial-success — the bug class our meta-pattern flags.

Fix in code: `artifacts/api-server/src/lib/ingestion/queue.ts` exports `ensureQueue(boss, name)` that calls `boss.createQueue(name, opts)` before send/work. Both the api-server (sender) and the ingestion-worker (receiver) call it on startup. The wrapper catches "already exists" errors since `createQueue` is idempotent at the SQL level but throws on duplicate.

Detection rule for the next change: if you add a new pg-boss queue, you MUST call `ensureQueue` on it from every process that sends OR works it. If you forget, the symptom is "uploads stuck in `parsing` forever, no worker log lines, no error anywhere" — and you'll spend an hour staring at the worker before realizing the job never landed.

Confirmation method when in doubt: `SELECT name, state FROM pgboss.job ORDER BY created_on DESC LIMIT 10;` against the Neon DB. If your send appeared to succeed but no row shows up, the queue isn't registered.

## 2026-05-19 — Firefox sends `application/octet-stream` for `.md` uploads

Firefox (and some Chrome configs) don't have a built-in MIME mapping for `.md`. The browser sends `application/octet-stream` in the multipart upload, the server-side `ACCEPTED_MIMES` check fails, and the user sees a generic "file type not accepted" rejection on a perfectly valid markdown file.

Fix in code: `artifacts/api-server/src/routes/documents.ts` defines `normalizeMimeType(mimetype, originalName)` (line 34) that sniffs the filename extension when the browser-provided MIME is empty or `application/octet-stream`. The route at line 117 calls it before the `ACCEPTED_MIMES.has(…)` check, and the canonical normalized value is what gets persisted on `documents.mime_type` (line 144).

Detection rule for the next change: when adding a new accepted file type, extend `normalizeMimeType`'s extension table FIRST, then add the canonical MIME to `ACCEPTED_MIMES`. Never trust `file.mimetype` raw — it's whatever the browser felt like sending. Test from both Firefox and Chrome before declaring done.

Meta-pattern (also see pg-boss above): browser-provided values are user input. Treat them like any other untrusted input — normalize at the boundary, validate the normalized form.

## 2026-05-19 — Replit's publish flow does NOT run `CREATE EXTENSION`

Phase 2A's `users` table originally used `citext` for case-insensitive email comparison. The dev DB (where the Replit Agent ran our DDL prompt) had `CREATE EXTENSION IF NOT EXISTS citext` so everything worked locally. When the user clicked Publish, Replit's auto-migration generator diffed dev→prod, produced `CREATE TABLE users (... email citext NOT NULL ...)`, and the migration failed with `type "citext" does not exist`.

Root cause: Replit's publish flow runs the DDL diff but does NOT run `CREATE EXTENSION` statements (likely because extension installs require superuser privileges that the migration role doesn't have in prod). Any extension dependency that's present in dev but absent in prod will silently work until publish time, then fail loudly with no inline recovery path.

Fix applied (commit `c908ddf` on main): swap `citext` for plain `text` and normalize emails at the application layer — every write and lookup calls `.toLowerCase()` first. See `lib/db/src/schema.ts` (email column), `artifacts/api-server/src/lib/auth/bootstrap.ts:29` (insert path), `artifacts/api-server/src/routes/auth.ts:94` (login path). Net behavior is identical to citext for our access patterns.

**Detection rule for the next change:** the only Postgres extensions safe to assume at publish time are those Replit installs by default. Currently confirmed-safe in our prod: `pgcrypto`, `vector`, `pg_trgm`. NOT safe: `citext`, anything else. If a future feature wants an extension, plan for app-layer fallback BEFORE writing the DDL — or test the publish flow explicitly before relying on it.

**Cross-cutting rule for any new code touching `users.email`:** lowercase before write, lowercase before compare. Two `Alice@foo.com` users would otherwise pass uniqueness and break login. Same applies to any future user-management routes (Phase 2C.2) — bake the normalization into the route helpers, don't trust callers.

## 2026-07-11 — `read-excel-file` bare import fails the build; use the `/browser` subpath

Adding `.xlsx` support to the bulk user import, the natural `await import("read-excel-file")` compiled cleanly in review but **broke the Replit build** with `TS2307: Cannot find module 'read-excel-file' or its corresponding type declarations`. The package publishes only subpath entries (`read-excel-file/browser`, `read-excel-file/node`) with no usable root `.` export under this repo's `moduleResolution`, so the bare specifier resolves to nothing.

Fix (Replit Agent, commit `cfc2ea8` on main), in `artifacts/rag-app/src/pages/AdminUsers.tsx`:
- Import the client entry explicitly: `await import("read-excel-file/browser")` (the `/node` build pulls in `fs` and won't bundle for Vite).
- The browser build types its rows as `Sheet<number>[]`, which doesn't structurally satisfy `parseUserXlsx`'s `ReadonlyArray<ReadonlyArray<unknown>>`, so the call site needs a `as unknown as ReadonlyArray<ReadonlyArray<unknown>>` double-cast. Harmless — `parseUserXlsx` stringifies every cell at runtime, so the cast only relaxes compile-time.

**Detection rule / meta-lesson:** an app-runtime dep added in a dev session **cannot** be import-resolution- or type-checked locally (no `node_modules` in the worktree; local installs are forbidden for app-runtime deps). The **first Replit build is the type gate** — say so explicitly when adding one. Before writing the import, check the package's `package.json` `exports`: if it has no root `.` entry (subpath-only, common for dual browser/node libs), import the explicit `/browser` (client) subpath in the Vite app rather than the bare name, and expect the subpath's row/cell types may need a cast to your own parser signature.
