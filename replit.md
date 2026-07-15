# replit.md — RAG-CSR Knowledge Assistant

> Preferences and project-specific notes for the Replit Agent. Read on
> every session start. Companion to `CLAUDE.md` (which is read by Claude
> Code in a separate cloud sandbox).

## What this is

A retrieval-augmented knowledge assistant for call-center CSRs. Admins
upload SOPs/policies/screenshots; CSRs ask questions and get cited,
verifiable answers. The product is **trust + speed**, not chat features.

Your tasks come from the user. The user works with Claude Code (a
separate AI in its own cloud sandbox) to write code; Claude Code
sometimes drafts copy/paste prompts the user relays here. When
something fails, report it back to the user — they decide whether to
feed it to Claude Code for a fix.

## Hard rules — load-bearing, learned the hard way

### 1. The dev database is the schema source of truth, not `schema.ts`

`lib/db/src/schema.ts` is **only** the TypeScript binding — Drizzle uses
it to generate typed queries. **Nothing about that file touches the DB.
Nothing about the DB cares what that file says.**

Replit's Publish flow diffs the **dev database's actual schema state**
against prod and generates a migration from that diff. So:

- Editing `schema.ts` without a matching `ALTER TABLE …` on the dev DB →
  invisible to Publish, app code talks to a DB that doesn't match its
  types
- Running SQL against the dev DB without updating `schema.ts` → Drizzle
  queries break at compile or runtime

**Both must change together, every time.** Standard flow:

1. Claude Code edits `schema.ts` for the TS types
2. Claude Code writes a "Replit Agent DDL prompt" block in the PR
3. The user pastes that DDL block here; you run it against the dev DB
4. User republishes — Publish sees the new dev DB state and produces a
   migration that matches

### 2. Publish does NOT run `CREATE EXTENSION`

Publish runs DDL diff against prod but does NOT run `CREATE EXTENSION`
statements (extension installs require superuser privileges the
migration role doesn't have). Any extension dependency present in dev
but absent in prod silently works until Publish time, then fails with
`type "<extname>" does not exist`.

**Safe-to-assume extensions in prod (confirmed):**
`pgcrypto`, `vector`, `pg_trgm`.

**NOT safe:** `citext`, anything else. We learned this with `citext` on
the `users.email` column — see `.claude/reference/pitfalls.md` for the
full incident. Fix when you need a missing-extension capability: design
an **app-layer fallback** (e.g., lowercase normalization at write +
read) instead of depending on the extension.

### 3. Do NOT run `drizzle-kit push` or any drizzle-kit migration command

The schema source of truth is the dev DB (see rule 1), not the Drizzle
schema file. `drizzle-kit push` would try to reverse that. If the dev
DB and `schema.ts` drift, the fix is to align the dev DB via raw SQL,
not to push the schema file at it.

### 4. Product non-negotiables (do not "improve" these)

- Every CSR-facing answer ships with at least one clickable citation
  OR is an explicit refusal. No naked answers.
- Program scoping is a **server-side** security boundary. A CSR on
  Program A must never see Program B data. The DB CHECK constraint on
  `users` (super_user → program_id IS NULL; other roles → non-null) is
  the spine of this. Don't disable or weaken it.
- Refusal over hallucination. When retrieval confidence is below
  threshold or the LLM can't ground every claim, the answer is "I
  couldn't find this in the knowledge base." Never invent fees, dates,
  policy numbers.

## Database schema — current state

The current schema shape and invariants are documented in
`.claude/reference/data-model.md`. Reviewed lifecycle, classification,
audit, and SIEM DDL lives under `docs/security/`. Compare those sources
with the development database before any repair or recreation work.

Tables (high level):
- `programs`, `documents`, `document_versions`, `chunks` — Phase 1 RAG
  pipeline
- `query_log`, `eval_questions` — Phase 1 observability + eval scaffolding
- `users`, `sessions` — Phase 2A auth (4-tier role hierarchy)
- `user_role` enum: `super_user` / `senior_manager` / `manager` / `csr`

Invariants worth knowing:
- `chunks.program_id` is denormalized for fast scoping (don't join at
  query time)
- A document has many versions; re-uploading creates a new
  `document_versions` row, doesn't overwrite
- Only chunks from `is_active=true` versions are searched
- `users.role` + `users.program_id` are jointly constrained by a CHECK
- `sessions.token_hash` is SHA-256 of the cookie value, not the value
  itself

## Tooling quirks

- **`checkDatabase()` can report "not provisioned" even when the DB is
  fully reachable.** This project uses Replit's built-in Postgres —
  `DATABASE_URL` is platform-injected, not set in Secrets. The tool
  reported "no DB" while `executeSql()` and the api-server were both
  connected fine. Trust the SQL result, not the tool. Don't conclude
  the DB is missing and try to recreate it.

## Common Replit Agent tasks — preferred patterns

### When the user pastes a DDL prompt from Claude Code

The prompt arrives as a fenced SQL block (usually preceded by "Ask the
Replit agent to run this against the dev database"). Run it against
the **dev** database. Don't run it against prod directly — Publish
promotes the change automatically when the user republishes.

If the SQL fails, **report the exact error back to the user verbatim**.
Don't try to "fix" the SQL yourself unless the fix is trivial and
obvious (typo, missing semicolon). Schema changes have correctness
implications that need code-side review — the user will relay your
error to Claude Code for an adjusted prompt.

### When the user asks you to install a package

The request will name the package(s) + workspace. Run pnpm from the
indicated directory (usually `artifacts/api-server` or
`artifacts/rag-app`). Commit `package.json` + `pnpm-lock.yaml` after
the install and push to the designated feature branch so Claude Code's
next session sees the deps.

### When the user comes directly to you for a code change

Sometimes the user is in a hurry and asks you to edit code in
`artifacts/` or `lib/` directly, skipping the usual Claude-Code → PR
flow. You can — but treat it as a higher-risk path:

- **Keep scope minimal.** Edit only what the urgent fix requires. Don't
  refactor, don't "improve" adjacent code. In particular, resist the
  urge to clean up "obviously unused" imports or variables alongside the
  real fix — what looks unused at a glance may be load-bearing in ways
  that aren't immediately visible, and introducing a compile error while
  fixing a deploy error makes things worse.
- **If the change touches `schema.ts`, you MUST also run the matching
  `ALTER TABLE` on the dev DB in the same session.** See rule 1. Half
  a change is worse than no change.
- **When you finish, tell the user explicitly that "Claude Code should
  review and sync on the next session."** Don't assume sync is
  automatic — Claude Code reads from main on session start; if your
  edits didn't go through a PR with review, the user needs to know to
  surface them.
- **Don't narrate assumptions about how Publish or the workspace works
  unless you've verified them.** "I think Replit only diffs schema.ts"
  is a confident-sounding wrong claim that has already cost this
  project a publish cycle. If you're not sure, say "I'm not sure" and
  ask.

## Pointers, in order of importance

1. `CLAUDE.md` — kernel rules for Claude Code, also describes the
   two-sandbox model
2. `.claude/reference/pitfalls.md` — project-specific gotchas, grows
   over time
3. `.claude/reference/data-model.md` — schema and invariants
4. `docs/security/` — reviewed control DDL and security evidence
5. `.claude/reference/{retrieval,ingestion,secrets,eval}.md` — topical
   reference

If you're about to make a change that doesn't match how the codebase
currently works, **stop and ask the user**. The patterns in here
weren't arbitrary — most came from incidents documented in
pitfalls.md. Repeating them costs time and trust.
