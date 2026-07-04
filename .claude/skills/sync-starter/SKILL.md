---
description: Sync this project with the claude-starter template repo — pull skill/hook/settings improvements down from the template, or push a generic improvement made here back up to it. Use when the user says /sync-starter, "pull template updates", "update skills from starter", "is the starter ahead of us", or "push this skill fix back to the starter". Diff-driven and selective; never bulk-overwrites project-tuned files.
---

# sync-starter — two-way sync with the claude-starter template

Spawned projects freeze the template at spawn date; the template keeps improving. This skill closes the gap in both directions. Template repo: `ryanportfolio/claude-starter`.

## Direction A: Pull template improvements into this project

### Step 1: Wire the remote (once)

```
git remote get-url starter || git remote add starter https://github.com/ryanportfolio/claude-starter.git
git fetch starter
```

### Step 2: Diff the shared surface

Only these paths are sync candidates:

```
git diff --stat HEAD starter/main -- .claude/skills .claude/hooks .claude/settings.json
```

**Diverged-by-design — NEVER bulk-pull these:**
- `CLAUDE.md` — project-configured (FILL IN sections replaced). If the template's kernel changed, read the template version (`git show starter/main:CLAUDE.md`), and hand-merge the relevant rule into the project copy.
- `.claude/reference/*` — project knowledge. Template only ships skeletons.
- `.claude/skills/applying-best-practices/SKILL.md` — catalog is tuned per stack by `/init-project`. Hand-merge discipline-section changes only.

### Step 3: Present and pick

Group the diff for the user: **new skills** / **changed skills** / **hooks+settings changes**, one line each on what changed (read the actual diff, don't guess from filenames). Ask which to take (plain chat, numbered).

### Step 4: Apply selectively

```
git checkout starter/main -- .claude/skills/<picked>/ .claude/hooks/<picked>
```

For `settings.json`: merge, don't overwrite — the project may have its own permission additions. Read both, union the `allow` lists, keep project-specific hooks.

### Step 5: Ship

Branch, stage exactly the pulled paths, commit (`Sync from claude-starter: <what>`), push, PR — per the project's git rule.

## Direction B: Push a generic improvement back to the template

When a skill fix / new skill / hook improvement made in THIS project is generic (would help every project):

1. **Genericize first.** Strip project-specific names, paths, URLs, stack assumptions — the same scrub discipline the template was built with. If it can't be genericized, it doesn't go back.
2. **Get the change to the template repo:**
   - If this machine has the template checked out locally (e.g. `~/code/claude-starter`), apply the change there directly.
   - Otherwise clone it to scratch: `git clone https://github.com/ryanportfolio/claude-starter .tmp/claude-starter`, apply, push from there.
3. Commit to the template on a branch, push, open the PR (or commit to main directly if the user says so — template is solo-maintained).
4. **Bump the plugin version** when the change touches the shared surface (`.claude/skills`, `.claude/hooks`, `.claude/settings.json`): edit `version` in the template's `.claude-plugin/plugin.json` — patch for fixes, minor for new skills. Plugin installs only receive updates when this number changes; spawned projects get changes via Direction A regardless.
5. Mention that other spawned projects pick it up via Direction A.

## Anti-patterns

- Don't `git checkout starter/main -- .claude` wholesale — it clobbers diverged-by-design files.
- Don't overwrite `settings.json` — union the permission lists.
- Don't push project-flavored content back to the template — genericize or leave it.
- Don't treat a CLAUDE.md diff as pullable — kernel changes are always a hand-merge.
- Don't sync on every session. This is occasional maintenance, user-triggered.
