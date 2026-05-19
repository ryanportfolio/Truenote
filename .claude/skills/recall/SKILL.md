---
description: Look up project-specific reference and capture new learnings for this codebase. Use when starting work in an unfamiliar area, when the user asks "what do we know about X" / "any pitfalls with Y" / "remind me how Z works", says "remember this" / "save this learning" / "add to reference", or invokes /recall. Reads from `.claude/reference/<topic>.md` (env vars, AI providers, theme system, PDF pipeline, pitfalls, etc.) and appends new entries with dated headers. Auto-fire BEFORE non-trivial edits in unfamiliar areas — extraction code, theme/CSS, PDF pipeline, Model Council, i18n, blog posts — because the reference catches gotchas the kernel CLAUDE.md no longer carries.
user-invocable: true
---

# recall — project memory for Extract-Video-Wisdom

Topical project reference lives in `.claude/reference/<topic>.md`. CLAUDE.md carries only cross-cutting safety and process rules; everything else (env vars, theme palette, PDF pipeline quirks, area pitfalls) is in the reference. This skill is the read/write interface to that store.

## When to invoke

**Lookup (most common):**
- User says `/recall <topic>` or `/recall <question>`.
- User asks "what do we know about X", "any pitfalls with Y", "remind me how Z works".
- BEFORE editing in an area you don't already have loaded: extraction routing, theme/CSS, PDF pipeline, Model Council, i18n strings, blog posts, secrets/env wiring.

**Capture:**
- User says `/recall save <text>`, "remember this", "save this learning", "add to reference".
- A quirk just bit you (or just bit the user) and the lesson belongs in the next session's context.

## Step 1: Look up

1. List the available topics:
   ```
   ls .claude/reference/
   ```
2. Match the user's query to a topic. Current topics:

   | File | Covers |
   |---|---|
   | `secrets.md` | Env var names + what they key (`C_KEY`, `MINIMAX_KEY`, `Deepseek_KEY`, etc.) |
   | `ai-providers.md` | The 6 user-facing extraction models, supporting AI services, third-party integrations |
   | `architecture.md` | Extraction pipeline flow, auth, state strategy |
   | `pdf-pipeline.md` | PyMuPDF + Mistral OCR (legacy Docling/LlamaParse names) |
   | `theme-system.md` | Dark vs night-light, CSS variable palette, React/CSS patterns, body::before reset rule |
   | `pitfalls.md` | Model Council duplication, OpenRouter `:free` suffix, i18n discipline, arXiv URLs, caching, blog post format |
   | `commands.md` | npm scripts |
   | `tech-stack.md` | Non-default library choices |
   | `deployment.md` | Build output, asset paths |

3. Read the matched file(s). If the query spans multiple topics, read each.
4. If nothing in the table fits the query, grep the directory for keywords:
   ```
   grep -rn -i '<keyword>' .claude/reference/
   ```
5. Summarize the relevant entries to the user with file:line references.

If nothing relevant exists, say so plainly — don't fabricate from memory or guesses.

## Step 2: Capture

When the user wants to save a learning:

1. **Pick the topic file.** Use an existing file when the topic fits. Create a new file only if no existing topic fits AND the topic is durable (worth a permanent home, not a one-off).
2. **Append at the bottom** under a dated header:
   ```markdown
   ### YYYY-MM-DD: <short title>

   <Body — 1 to 5 sentences. State the symptom and the fix, not just the fix. Include `file:line` refs where relevant. Don't quote large blocks of code.>
   ```
3. **Date format:** today's date. Check the conversation context's `# currentDate` block first; otherwise run `date +%Y-%m-%d`.
4. **If creating a new topic file,** also add a row to the index table in CLAUDE.md's "Project Reference Library" section so future sessions discover it.
5. **Commit on the current branch** with a message like `recall: <short title>`. Don't bundle unrelated changes.

## Step 3: Stay disciplined

- **Never duplicate kernel rules.** Model aliasing, two-sandbox model, popup-tool ban, npm-install rule, git workflow stay in CLAUDE.md. The reference is for area-specific info that only matters when working on a specific subsystem.
- **Don't let `pitfalls.md` become a junk drawer.** If it grows past ~200 lines, propose splitting by area (`pitfalls-extraction.md`, `pitfalls-ui.md`, `pitfalls-content.md`) and update the CLAUDE.md index.
- **Keep entries terse.** A learning is a flag for the next session, not a tutorial. 1–5 sentences. Link to code, don't quote it at length.
- **Date everything.** Future-you needs to know which entries might be stale.

## Anti-patterns

- Don't move safety-critical rules out of CLAUDE.md (model aliasing, two-sandbox model, popup-tool ban, npm-install rule). Those need to be active every session, not loaded on demand by description matching.
- Don't append to `.claude/reference/` without committing — uncommitted entries vanish in the next sandbox.
- Don't fabricate entries. If you don't know what's already in a file, read it; don't summarize from training-data guesses.
- Don't trigger this skill for tasks that aren't about this codebase (generic library questions, design discussions, unrelated CLI help).
- Don't expand an entry on re-read. Replace stale entries; don't accrete over time.
- Don't use `git add -A` or `git add .` when committing a recall entry — stage only the reference file you touched.
