---
description: Rewrite a rough or under-specified request into a polished, copy/paste-ready prompt that any agent or LLM can act on cold. Use when the user gives a quick description of something they want done and asks for it to be turned into a better prompt — e.g., "make this a good prompt", "rewrite this so I can paste it into a new session", "turn this into a copy/paste prompt", or invokes the skill with their rough request as the argument. Output is one fenced markdown block the user copies verbatim, plus a 1-2 sentence note on what changed. The output prompt is platform-neutral (no references to specific tools, agents, or platforms) but project-aware (encodes relevant constraints from CLAUDE.md when applicable to the task).
user-invocable: true
---

# Enhance prompt

Turn the user's rough request (in `$ARGUMENTS`) into a single, polished prompt that an agent with no prior conversation memory can act on. The output must be platform-neutral — it should work whether the user pastes it into a fresh coding-agent session, an in-IDE assistant, or a generic chat LLM.

## Step 1: Extract the real goal

Look past surface wording. Common patterns to recognize:

- "Review X" usually means **audit + propose, not edit**. Phase the work.
- "Add feature X" needs scope, edge cases, UI placement
- "Fix bug X" needs reproduction steps, current vs expected behavior
- "Refactor X" needs scope boundaries (which files, which patterns to keep)
- "Make it better / cleaner / faster" needs concrete success criteria

If the request is genuinely ambiguous on a point that materially changes the output, ask the user once before drafting. Otherwise proceed and surface assumptions inside the prompt as `<TODO: confirm>` placeholders.

## Step 2: Gather receiver-cold context

The receiver has no memory of this conversation and may have no view of the codebase. Add the context they need to act:

- **File paths and line numbers** — if they exist and you can grep them, include them. `Edit client/src/pages/Foo.tsx:142` is 10× more actionable than "edit the foo page."
- **Existing patterns to match** — point at one reference in the codebase ("follow the pattern in `bar.tsx:80-110`")
- **Current state vs desired state** — for bug fixes and changes, spell both out concretely
- **Don't invent facts.** If the user didn't tell you a tier name, file path, or behavior and you can't verify it, leave a `<TODO: user fills in>` placeholder rather than making something up.
- **Don't quote large code blocks.** Reference the file path; if the receiver has repo access they'll read it. Quote the minimum necessary only when the receiver clearly won't have repo access.

## Step 3: Phase risky work

Anything that touches user-visible copy, database schemas, public APIs, model routing, payment logic, or is a large refactor → split into phases and tell the receiver to STOP between them:

1. **Phase 1: Audit / propose only.** Write findings to `.tmp/<task>-plan.md` or list inline. No file edits.
2. **Phase 2: User reviews.**
3. **Phase 3 (separate prompt or continuation): Implement the approved subset.**

For safe, mechanical work (typo fixes, renaming a single internal variable, adding a console log), a single phase is fine.

When in doubt, phase it. Cheap to skip a phase, expensive to undo a bad edit.

## Step 4: Specify the deliverable

Always include:

- **What artifacts to produce** (file edits, a markdown audit, a new component, a verification script, etc.)
- **Format if structured output is expected** (table layout, severity-tagged list, JSON shape, fenced sections with specific headings)
- **Verification step** — type-check, screenshot, dry-run script — appropriate to the task
- **Scope guards** — common ones: "don't refactor unrelated files", "don't add tests unless asked", "don't install packages without confirmation", "don't change user-facing copy outside the listed strings"

## Step 5: Bake in relevant project constraints

If a `CLAUDE.md` exists in the working directory, skim it for rules that touch the current task and include only those in the prompt. Don't dump the whole kernel — irrelevant rules dilute signal.

High-frequency categories to consider including when applicable:

- **Internal aliasing or stealth naming rules** — if task touches extraction, error surfaces, banners, or user-facing copy that mentions providers/products by name
- **Manual package install policy** — if task may add dependencies
- **Manual DB migration policy** — if task involves schema changes
- **Translation / i18n approval flow** — if task changes user-facing wording
- **Settings duplicated across multiple files** — if task touches a config that's known to live in multiple places (e.g., default model lists, feature flags)
- **Multi-theme / multi-mode UI requirements** — if task adds visual elements
- **Product-specific naming or terminology rules** — if relevant

When you bake a constraint in, **quote the rule plainly as a constraint** — don't write "CLAUDE.md says X." The receiver may not have CLAUDE.md and shouldn't need it.

## Step 6: Keep the output platform-neutral

The output prompt must work regardless of who/what executes it.

- ❌ Don't say "use the Bash tool", "via the Task subagent", "as Replit Agent", "as Claude Code"
- ❌ Don't reference specific UI affordances of one platform ("click the X button in the sidebar")
- ✅ Do say "run the following command", "search the codebase for X", "edit the file at `path:line`", "produce a markdown file at `<path>`"
- ✅ Do specify outcomes and artifacts, not the path to get there

The receiver will use whatever tools they have. Trust them with the *what*; don't prescribe the *how* unless the *how* is itself the point.

## Step 7: Output format

Produce **one outer-fenced markdown block** the user can copy verbatim. Use four backticks for the outer fence so any triple-backtick code blocks inside render correctly:

````
```markdown
[the polished prompt goes here]
```
````

Above the block, add a 1-2 sentence note on what changed from the user's input — e.g., "I added a phase split, three file path references, and the aliasing constraint since this touches extraction copy."

Do NOT execute the prompt yourself. Do NOT make any file edits as part of running this skill. The deliverable is the prompt — nothing more.

## Anti-patterns to avoid

- **Don't pad.** A 200-word prompt that's all signal beats an 800-word prompt that repeats itself. If a sentence doesn't change what the receiver does, cut it.
- **Don't invent constraints the user didn't ask for.** A typo fix doesn't need a 5-phase audit. Match prompt complexity to actual job complexity.
- **Don't dump CLAUDE.md verbatim.** Quote only the rules that apply to this task.
- **Don't substitute your judgment for the user's clear choices.** If they've decided something, encode it as-is. If they've left something open, ask or flag as `<TODO>`.
- **Don't generate placeholders for things you could verify yourself.** If you can grep the file path or read the relevant code, do it instead of writing `<file path>`.
- **Don't reference platform-specific tools or UI.** The output must be tool-agnostic.
- **Don't pre-write the receiver's reply.** Phrases like "the agent will respond with X" or "you should answer Y" leak frame; just specify what the receiver should produce.
