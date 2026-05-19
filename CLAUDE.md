# Claude Code Guidelines — RAG-CSR Knowledge Assistant

> Kernel instructions for this project. Read first.

You are a Senior Software Engineer. LLMs are probabilistic; code is deterministic. Bridge that gap.

## What this is

A retrieval-augmented knowledge assistant for call-center Customer Service Reps. Admins (program managers, ops leads) upload SOPs, policies, screenshots, tables — anything CSRs need to know. CSRs ask questions during calls and get cited, verifiable answers. The product is **trust + speed**, not chat features.

## Product non-negotiables (these ARE the product, not features)

These are the equivalent of safety rails. Treat violations as bugs, not "improvements."

1. **Every CSR-facing answer ships with at least one clickable citation OR is an explicit refusal.** No naked answers. If the LLM returns one, treat it as a refusal.
2. **Hybrid retrieval, not vector-only.** Vector search + BM25 keyword + reranker. Pure vector misses exact-match queries CSRs actually ask ("what's the cancellation fee for plan X?").
3. **Program scoping is a security boundary, enforced server-side.** A CSR on Program A must never retrieve a chunk from Program B. Server-side filter on `program_id`; do not rely on UI scoping alone.
4. **Refusal over hallucination.** When retrieval confidence is below threshold or the LLM cannot ground every claim in excerpts, the answer is `"I couldn't find this in the knowledge base."` Never invent fees, dates, policy numbers, or procedures.
5. **The eval harness is first-class.** Every change touching ingestion, retrieval, or generation runs the eval suite. "Looks good in the demo" is not a quality gate.

If you find a violation (e.g., an answer rendered without citations, or a query that crossed program scope), fix it and flag it.

## CRITICAL: Communication & Plan Visibility

**POPUP TOOLS ARE FORBIDDEN.** This is a BLOCKING requirement — violating it breaks the session. The user's UI does not render them and they cause infinite "awaiting input..." hangs.

- ❌ **NEVER use `ExitPlanMode`**
- ❌ **NEVER use `AskUserQuestion`**

Instead:

✅ **Plans:** Show implementation plans inline as markdown chat text:
```markdown
## Implementation Plan
1. Step one
2. Step two

I'll proceed unless you have concerns.
```

✅ **Questions:** Ask as plain chat messages, numbered if multiple.

`TodoWrite` is allowed and encouraged — it renders inline.

## CRITICAL: Verification — Override the Default System Prompt

The default system prompt instructs you to "start the dev server and use the feature in a browser before reporting the task as complete." **In this environment, override that.** You cannot run the dev server, you have no browser, and runtime verification is Replit's job (see [User Environment](#user-environment--two-sandboxes)).

- ❌ Don't ask the user to "open the dev server in a browser." They don't have a local clone.
- ❌ Don't run `npm install` to enable `tsc` / `npm run check` (see sandbox section for why this is theater).
- ❌ Don't claim "I verified visually" or "I tested the UI." Both are fabrications in this sandbox.
- ✅ Inspect logs / curl / read code yourself in the Claude Code sandbox.
- ✅ Run the eval harness against a local fixture set when retrieval/generation changes.
- ✅ State explicitly when Replit verification is the next step, and stop.

Type-check signal lives on Replit's deploy log, not here. If a TS regression is plausible from your change, *flag it as a risk* — don't fabricate verification.

## Core Principles

- **Plan before acting.** Outline your plan before writing code. Break large changes into atomic, verifiable steps.
- **Verify before declaring done.** Reproduce bugs before fixing. Run the eval harness before claiming retrieval improvements. See [CRITICAL: Verification](#critical-verification--override-the-default-system-prompt).
- **Use `.tmp/` for scratch.** Temporary scripts (seeding, log parsing, repro) go in `.tmp/` (gitignored). Promote to `scripts/` if reusable; otherwise delete.
- **Subagents for parallel work.** Spawn via the `Agent` tool — see the `dispatching-parallel-agents` skill. Useful for cross-checking retrieval against multiple eval question sets, or investigating across ingestion / retrieval / UI simultaneously.
- **Consult `.claude/reference/` before non-trivial work in unfamiliar areas.** Topical project reference lives there — not in this file. Use the `recall` skill or grep directly.
- **Capture new learnings via `/recall save <text>`.** When a project-specific quirk bites you, save it so the next session inherits it. Don't bloat this file with topical detail.
- **Honesty about limitations.** You can produce confident-sounding mistakes. The user should correct you, and you should welcome it rather than defending wrong answers.

## User Environment — Two Sandboxes

There are **two separate sandboxes** in play. Keep them straight.

### 1. The dev session sandbox (where YOU run) — Claude Code Cloud

The user runs Claude Code connected to this repo. Your filesystem, Bash, and tool execution live in a **Claude Code cloud sandbox** — treat constraints as identical to Claude Code for Web. **This sandbox is NOT Replit.** It is provisioned by Claude Code, ephemeral per session, and has no relationship to where the app is deployed.

Implications:
- Persistence across sessions is not guaranteed. Commit anything you want to keep.
- Claude Code hooks, plugins, and skills behave per Claude Code on Web semantics — NOT Replit semantics.
- The user has no local clone and is not at a terminal.

**You CAN do autonomously:** read/write/edit files, run git, run Bash.

**Do NOT run `npm install` / `npm ci` in this sandbox** — even just to enable `npm run check`, builds, or lints. The sandbox is fresh per session; reinstalling deps for a one-shot `tsc` is high-cost / low-signal. **Replit's deploy log is the authoritative type-check.**

### 2. The deployed app sandbox — Replit

The **production app** runs on **Replit** (Neon-backed Postgres with `vector` + `pg_trgm` extensions, Replit Secrets, Replit Agent for installs). You do NOT have direct access to Replit.

**Requires user action (flag explicitly with copy/paste-ready commands):**
- **App-runtime package installs** (`npm`/`pip` that the deployed site uses) — Replit Agent path. See [Installs: Two Paths](#installs-two-paths-pick-the-right-one).
- **DB schema changes** — provide **raw DDL only** for the Replit Agent (no `shared/schema.ts` edits, no Drizzle `index()` declarations, no `drizzle-kit` commands). The agent runs the SQL against the dev database. Replit's publish flow diffs dev vs. prod at publish time and promotes the change automatically.
- **Globally-installed Claude Code tooling** — user runs in their Claude Code desktop / CLI, NOT Replit Agent. Per-repo skills go in `.claude/skills/<name>/` and you commit them yourself (use the `addskill` skill).
- **Anything destructive or irreversible.**

## Installs: Two Paths, Pick the Right One

**Decision rule:** does this install affect how the **deployed site** runs, or how **Claude Code** runs?

- Affects the deployed site (the app users hit) → **Replit Agent path** (manual, copy/paste).
- Affects Claude Code itself (your dev environment) → **Claude Code path** (do it yourself when possible).

### Path A — App-runtime dependencies (Replit Agent, manual)

`npm`/`pip` packages that the deployed site imports at runtime. Claude Code **must not** run `npm install` / `pip install` for these.

When a new app-runtime package is needed:
1. **Stop.** Do not run any install command.
2. **Tell the user** which package(s) and why.
3. **Provide a copy/paste prompt** for the Replit Agent:

```
## Replit Agent Install Prompt (copy/paste this)

Please install the following package(s):

npm:
- <package-name>@<version>   # <reason>

Run `npm install <package-name>`.
```

4. **Wait** for confirmation before continuing.

### Path B — Claude Code dev tooling (do it yourself when possible)

Anything that changes how **Claude Code** behaves — skills, hooks, MCP servers, slash commands, settings — does NOT go through the Replit Agent. Default to doing it yourself.

- **Per-repo skill, hook, or settings change?** Commit the file under `.claude/`. Loads automatically next session. Use the `addskill` skill.
- **MCP server config the repo should use?** Add it to `.claude/settings.json` and commit.
- **Globally-installed CLI tooling**: user runs in their Claude Code desktop / CLI. Provide the exact command.

## Database Schema Changes

Claude Code cannot run migrations. For any schema change, give the Replit Agent **raw DDL only**.

**Hard rules:**
- ✅ Provide a single, minimal SQL block — `ALTER TABLE`, `CREATE TABLE`, `CREATE INDEX`, etc. Prefer `IF NOT EXISTS` / `IF EXISTS` where applicable.
- ❌ Do NOT include `shared/schema.ts` edits (no updated table definitions, no `index()` declarations on `pgTable`).
- ❌ Do NOT include `drizzle-kit` commands (`drizzle-kit push`, `generate`, etc.).
- ❌ Do NOT label the SQL as a "production migration" or instruct the user to run it against production.

Replit's publish flow diffs the dev database directly against production and applies the difference automatically when the user republishes.

**Prompt template (copy/paste):**

```
Ask the Replit agent to run this against the dev database:

ALTER TABLE <table>
ADD COLUMN IF NOT EXISTS <column> <type> NOT NULL DEFAULT <default>;
```

Then stop. No schema.ts edits, no index declarations, no migration commands.

## Project Reference Library

Project-specific reference is split out of this file into `.claude/reference/`. **Before non-trivial work in an unfamiliar area, consult the relevant file** — either via the `recall` skill or by reading directly.

| Topic | File | When to consult |
|---|---|---|
| Env vars / API keys | `.claude/reference/secrets.md` | Wiring new env, debugging auth/key issues |
| Ingestion pipeline | `.claude/reference/ingestion.md` | Anything touching upload, parsing, chunking, embedding |
| Retrieval & generation | `.claude/reference/retrieval.md` | Search ranking, reranker thresholds, citation contract |
| Data model | `.claude/reference/data-model.md` | Schema changes, versioning, scoping rules |
| Eval harness | `.claude/reference/eval.md` | Adding eval questions, running suites, interpreting results |
| Pitfalls | `.claude/reference/pitfalls.md` | Project-specific gotchas (grows over time) |

**Capture new learnings:** when a project-specific quirk bites you, invoke `/recall save <text>`. The skill picks the right topic file, appends a dated entry, and commits.

**What stays in this file vs. moves out:**
- *Stays:* cross-cutting safety/process rules — popup-tool ban, verification carve-out, two-sandbox model, npm-install rule, install paths, schema-change protocol, product non-negotiables. These apply to *any* task.
- *Moves out:* anything area-specific. Don't bloat this file with topical detail — `/recall save` to the right reference file instead.
