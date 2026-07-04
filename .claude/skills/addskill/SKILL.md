---
description: Add a new skill to this repo so it's available in every Claude Code web session. Use when the user says /addskill, asks to "add a skill", "install a skill", "create a skill", or wants a third-party skill (e.g. superpowers, impeccable) to show up in the available-skills list. Skills must live in the project's .claude/skills/ folder and be committed — personal/global installs do NOT follow the user into the web sandbox.
---

# Add skill — install a skill into this repo

Skills only appear in a Claude Code web session if they're committed to `<repo>/.claude/skills/<name>/`. Personal installs (`~/.claude/skills/`) and CLI-only plugins do NOT follow the user to the web. The fix is always: put the skill folder in the repo and commit it.

## Step 1: Confirm the skill source

Ask the user (or infer from `$ARGUMENTS`) where the skill content comes from:

- **A name + description** the user wants you to author from scratch
- **An existing local folder** (e.g. `~/.claude/skills/<name>/`) to copy in
- **A third-party skill** (e.g. `superpowers`, `impeccable`) — these usually ship via a Claude Code plugin marketplace. Ask the user for the source URL/repo. Do NOT invent contents.

If the source is ambiguous or the user only gave a name you don't recognize, ask once before authoring.

## Step 2: Create the skill folder

Skill location is **always**:

```
/<repo-root>/.claude/skills/<skill-name>/SKILL.md
```

- Folder name is the skill name as it will appear after `/` (kebab-case, no spaces).
- The file MUST be named `SKILL.md` (capitalized exactly).
- Sub-files (helper scripts, references) are allowed in the same folder.

```
mkdir -p .claude/skills/<skill-name>
```

## Step 3: Author SKILL.md

Required structure — YAML frontmatter then markdown body:

````markdown
---
description: One-paragraph description. Lead with what the skill does, then the trigger phrases ("Use when the user says /<name>, asks to ..."). The harness uses this string to decide when to surface the skill, so trigger phrases matter.
---

# <Skill name> — short tagline

Brief intro: what the skill produces and when it runs.

## Step 1: ...
## Step 2: ...
## Step N: ...

## Anti-patterns

- Don't ...
- Don't ...
````

Rules of thumb:

- **Description is the routing signal.** Include concrete trigger phrases the user is likely to say. Mention the slash command form (`/<name>`) explicitly.
- **Be concise.** Existing skills in this repo (`pr`, `enhance-prompt`, `impartial-review`) are good length references — short numbered steps, anti-patterns at the end.
- **No emojis** unless the user asks.
- **Don't reference platform-specific tools** in the body (e.g. "use the Bash tool"). Say "run this command" instead. Skills should work across CLI and web.
- **`$ARGUMENTS`** is available inside the skill body — that's how the user passes input via `/skillname some text`.

## Step 4: Verify the skill is wired up

After writing, sanity-check:

- File exists at `.claude/skills/<name>/SKILL.md`
- Frontmatter parses (single `---` block at the very top, valid YAML)
- `description` field is present and non-empty
- Skill name folder matches the slash command the user expects

You can grep existing skills for shape comparison:
```
ls .claude/skills/
head -5 .claude/skills/pr/SKILL.md
```

## Step 5: Commit and push

Skills only become visible in **future** web sessions after they're committed and pushed. On the current branch:

```
git add .claude/skills/<skill-name>/SKILL.md
git commit -m "Add /<skill-name> skill"
git push -u origin <current-branch>
```

Then provide the PR comparison URL per repo policy (derive the repo path from `git remote get-url origin`):
```
https://github.com/<owner>/<repo>/compare/<current-branch>
```

Tell the user the skill will appear in the **next** session — the available-skills list is loaded at session start, so the current session won't see it until reload.

## Anti-patterns

- Don't put skills in `~/.claude/skills/` — they won't follow to the web sandbox.
- Don't put skills in the repo root or a random subfolder — only `.claude/skills/<name>/SKILL.md` is loaded.
- Don't fabricate the contents of a third-party skill (`superpowers`, etc.) you don't have the source for. Ask the user for the source.
- Don't skip the commit/push step. Uncommitted skills won't survive the next session.
- Don't use `git add -A` or `git add .` — stage only the new skill file(s).
- Don't claim the skill is "now available" in the current session — it isn't until the session reloads.
