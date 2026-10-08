# Environment and installs

> What each session type can run, and how dependencies reach production. Deploys, schema changes and DNS live in `deployment.md`.

## Session types

### Local desktop (the usual case)

The user runs Claude Code from a local Windows checkout. pnpm comes from corepack (`corepack pnpm install`, `pnpm -r run check`, `pnpm -r run test`). The Railway CLI is installed and logged in, so deploys, logs, variables and database work over `railway ssh` happen from here, each production change with the owner's go.

The app does not run locally: no `DATABASE_URL`, no provider API keys. Runtime checks happen on the deployed Railway service.

### Claude Code cloud sandbox (web sessions)

Ephemeral per session; commit anything worth keeping. No Railway CLI and no credentials. Do not install dependencies only to run a one-shot check. Read code, state that a Railway deploy check is the next step, and stop.

## Production

Railway project `truenote`, environment `production`. Services, IDs, variables and procedures: `deployment.md`.

`truenote.org` and `www.truenote.org` point at Railway since the DNS switch on 2026-10-07. The old Replit deployment stays up only as the DNS rollback; nothing in this repo deploys to it.

## Installing app-runtime dependencies

1. From the repo root: `corepack pnpm --filter <workspace> add <pkg>` (e.g. `@workspace/api-server`). Never a bare `npm install` in a package directory; it leaves the root `pnpm-lock.yaml` untouched.
2. pnpm on Windows drops the `libc: [glibc]` / `libc: [musl]` lines from `packages:` entries. Restore them before committing (`pitfalls.md`, 2026-10-07); `git diff pnpm-lock.yaml` should show additions only for a pure add.
3. `corepack pnpm install --frozen-lockfile` must pass, then `pnpm -r run check`.
4. Commit `package.json` and `pnpm-lock.yaml` together. `Dockerfile.railway` installs with `--frozen-lockfile`, so the dependency ships with the next deploy.

Before importing a new package, check its `package.json` `exports`; subpath-only packages need the explicit subpath (`pitfalls.md`, `read-excel-file`). A passing typecheck on a cast does not prove the runtime shape.

## Claude Code dev tooling

Skills, hooks, MCP servers and settings are committed under `.claude/` (Codex counterparts under `.agents/`, see `CLAUDE.md`). Globally installed CLI tools: give the user the exact command for their own terminal.
