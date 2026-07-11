# Environment, Installs & Schema Changes — full detail

> Relocated from CLAUDE.md kernel 2026-07-04 (context-weight optimization). Kernel keeps the rules; this file keeps the mechanics and templates.

## The two sandboxes

### 1. The dev session (where Claude runs) — local desktop OR Claude Code Cloud

**Local desktop** (the usual case since 2026-07-04): the user runs Claude Code on Windows with the clone at `C:\Users\Home\CoreWise\kbase`. Package manager is pnpm via corepack (`corepack pnpm install`, `pnpm -r run check`, `pnpm -r run test`). Local installs are for VERIFICATION ONLY — they never substitute for the Replit install path below, because Replit's environment is what actually serves the app.

**Claude Code cloud sandbox** (web sessions): ephemeral per session, NOT Replit. Persistence is not guaranteed — commit anything worth keeping. Do NOT run installs just to enable a one-shot check; Replit's deploy log is the authoritative type-check there.

Either way: no session can run the deployed app (no DATABASE_URL, no API keys locally).

### 2. The deployed app sandbox — Replit

The **production app** runs on **Replit** (Neon-backed Postgres with `vector` + `pg_trgm` extensions, Replit Secrets, Replit Agent for installs). Claude has NO direct access to Replit.

**Requires user action (flag explicitly with copy/paste-ready commands):**
- **App-runtime package installs** (`npm`/`pip` that the deployed site uses) — Replit Agent path below.
- **DB schema changes** — raw DDL only, see below.
- **Globally-installed Claude Code tooling** — user runs in their Claude Code desktop / CLI, NOT Replit Agent. Per-repo skills go in `.claude/skills/<name>/` and get committed directly.
- **Anything destructive or irreversible.**

## Install Path A — app-runtime dependencies (Replit Agent, manual)

`npm`/`pip` packages the deployed site imports at runtime. Claude Code **must not** run `npm install` / `pip install` for these.

When a new app-runtime package is needed:
1. **Stop.** Do not run any install command.
2. **Tell the user** which package(s) and why.
3. **Provide a copy/paste prompt** for the Replit Agent:

```
## Replit Agent Install Prompt (copy/paste this)

Please install the following package(s):

- <package-name>@<version>   # <reason>

This is a pnpm workspace. Install from the repo root, targeting the
workspace that needs it, so the root pnpm-lock.yaml updates:

    pnpm --filter <workspace-name> add <package-name>

(e.g. the RAG frontend is `@workspace/rag-app`.)
```

4. **Wait** for confirmation before continuing.

> ⚠️ Do NOT write `npm install <pkg>` in the prompt — this is a pnpm
> workspace. A bare `npm install` in a sub-package leaves the root
> `pnpm-lock.yaml` untouched, so the dep never installs for the build.
> Always `pnpm --filter <workspace> add <pkg>` from the root. (2026-07-11)

## Install Path B — Claude Code dev tooling (do it yourself when possible)

Anything that changes how **Claude Code** behaves — skills, hooks, MCP servers, slash commands, settings — does NOT go through the Replit Agent.

- **Per-repo skill, hook, or settings change?** Commit the file under `.claude/`. Loads automatically next session. (The `addskill` skill scaffolds this; re-enable it in `skillOverrides` if hidden.)
- **MCP server config the repo should use?** Add to `.claude/settings.json` and commit.
- **Globally-installed CLI tooling**: user runs in their Claude Code desktop / CLI. Provide the exact command.

## Database schema changes — raw DDL protocol

Claude Code cannot run migrations. For any schema change, give the Replit Agent **raw DDL only**.

**Hard rules:**
- ✅ Single, minimal SQL block — `ALTER TABLE`, `CREATE TABLE`, `CREATE INDEX`, etc. Prefer `IF NOT EXISTS` / `IF EXISTS` where applicable.
- ❌ NO `shared/schema.ts` edits (no updated table definitions, no `index()` declarations on `pgTable`).
- ❌ NO `drizzle-kit` commands (`drizzle-kit push`, `generate`, etc.).
- ❌ Do NOT label the SQL a "production migration" or instruct the user to run it against production.

Replit's publish flow diffs the dev database directly against production and applies the difference automatically when the user republishes.

**Prompt template (copy/paste):**

```
Ask the Replit agent to run this against the dev database:

ALTER TABLE <table>
ADD COLUMN IF NOT EXISTS <column> <type> NOT NULL DEFAULT <default>;
```

Then stop. No schema.ts edits, no index declarations, no migration commands.
