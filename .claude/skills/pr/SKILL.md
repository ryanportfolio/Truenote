---
description: Push current branch changes to GitHub and provide a PR comparison link. Use when the user says /pr, asks to create a PR, or wants to push their changes.
user-invocable: true
---

# PR — Push & Create PR Link

Push the current branch to GitHub and return a one-click PR comparison URL.

## Step 1: Assess current state

Run these in parallel:
- `git status` — check for uncommitted changes and untracked files
- `git branch --show-current` — confirm the current branch
- `git diff --stat` — see unstaged changes
- `git diff --cached --stat` — see staged changes
- `git log origin/main..HEAD --oneline` — see commits ahead of main

## Step 2: Handle uncommitted changes

If there are uncommitted changes (modified or untracked files relevant to the work):

1. Stage only the relevant files — never use `git add -A` or `git add .`. Exclude:
   - `.claude/settings.local.json`
   - `.env` files, credentials, secrets
   - Large binaries
   - Unrelated config files

2. Draft a concise commit message (1-2 sentences) following the repo's commit style. Review recent commits with `git log --oneline -5` for style reference.

3. Commit with:
```
git commit -m "message here

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Step 3: Handle branch naming

If currently on `main`, create a descriptive feature branch first:
```
git checkout -b antigravity/descriptive-name
```

## Step 4: Push

Push the branch to origin:
```
git push -u origin <branch-name>
```

## Step 5: Provide PR link

Construct and display the PR comparison URL:

```
https://github.com/Aoh1578/Extract-Video-Wisdom/compare/<branch-name>
```

Report this URL clearly to the user — that's the deliverable.

## Anti-patterns

- Don't use `git add -A` or `git add .` — stage specific files only
- Don't commit `.env`, credentials, or `settings.local.json`
- Don't push to `main` directly
- Don't amend existing commits unless the user explicitly asked
- Don't skip hooks (no `--no-verify`)
- Don't babble about PR babysitting, CI watching, etc. — just provide the link
