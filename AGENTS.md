# Codex Instructions

This repository supports both Claude Code and Codex. Claude Code remains the
primary workspace and continues to use `CLAUDE.md`, `.claude/settings.json`,
hooks, and `.claude/skills/` exactly as before.

## Shared Project Instructions

- Read `CLAUDE.md` after this file. Honor its project facts, architecture,
  verification requirements, environment constraints, hard lines, and
  reference-library routing.
- If `CLAUDE.md` still contains `FILL IN` markers, treat those facts as unknown.
  Inspect the repository or ask the user instead of guessing.
- Read the relevant `.claude/reference/` file before non-trivial work in an
  unfamiliar area.

## Codex Runtime Defaults

- Use RTK explicitly for supported noisy reads when installed; use native commands for mutations, exact parsing, interactivity, and full verification output.
- On Windows, run repository Python scripts through `.claude/scripts/run-python.ps1`; `python.exe` may resolve to the Microsoft Store stub and `py.exe` may have no registered interpreter.
- Inspect actual tool availability before capability-gated skills. Independent-review skills do not have a valid main-thread fallback.
- Read `.agents/CODEX-SKILL-COMPATIBILITY.md` before adapted, gated, or dangerous skills.

## Runtime Boundary

- Do not execute `.claude/hooks/session-start.sh` in Codex.
- Do not inherit Claude-only runtime behavior: popup-tool rules, SessionStart
  directives, default `caveman` activation, Anthropic model names, Claude skill
  invocation syntax, or automatic git integration.
- Translate Claude-only tool names inside canonical skills to the available
  Codex equivalent. Current Codex system, developer, sandbox, approval, and tool
  instructions take precedence.
- Treat `$ARGUMENTS` inside a canonical skill as the current invocation's
  free-form input.

## Skills

- `.claude/skills/` is the canonical workflow library for both runtimes.
- Codex discovers generated adapters under `.agents/skills/`. When an adapter
  is selected, read its canonical `.claude/skills/<name>/SKILL.md` completely
  and resolve relative resources from that canonical skill directory.
- After adding, removing, or editing a canonical skill or `skillOverrides`, run
  `node .claude/scripts/sync-codex-skills.mjs --write`.
- Do not hand-edit generated adapters.

## Safety And Verification

- Caveman Ultra is the standing prose default from the first reply; do not ask or require an explicit invocation. Use plain prose for safety warnings and irreversible or ambiguous decisions.
- Auto-merge and other persistent side-effect modes still require explicit current-session user intent.
- Do not inherit Claude's automatic commit, push, PR, or merge behavior. Perform
  git publishing only when the current user request includes it.
- Never push to `main`, force-push, merge, delete branches/worktrees, run
  migrations, deploy, install runtime dependencies, or modify external
  checkouts without explicit current-session approval.
- Stage explicit paths and preserve unrelated user changes.
- Verify before claiming completion. State exactly what ran and identify any
  authoritative check that must happen in CI, deployment, or the user's
  environment.
