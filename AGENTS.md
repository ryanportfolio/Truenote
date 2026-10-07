# Codex Instructions

This repository supports both Claude Code and Codex. Claude Code remains the
primary workspace and continues to use `CLAUDE.md`, `.claude/settings.json`,
hooks, and `.claude/skills/` exactly as before.

## Shared Project Instructions

- Read `CLAUDE.md` after this file. Honor its project facts, architecture,
  verification requirements, environment constraints, hard lines, and
  reference-library routing.
- Production runs on Railway, not Replit (since 2026-10-07). Never route work
  through Replit; see "Hosting" in `CLAUDE.md` and
  `.claude/reference/deployment.md`.
- If `CLAUDE.md` still contains `FILL IN` markers, treat those facts as unknown.
  Inspect the repository or ask the user instead of guessing.
- Read the relevant `.claude/reference/` file before non-trivial work in an
  unfamiliar area.

## Codex Runtime Defaults

- Use RTK explicitly for supported noisy reads when installed; use native commands for mutations, exact parsing, interactivity, and full verification output.
- Inspect actual tool availability before capability-gated skills. Independent-review skills do not have a valid main-thread fallback.
- Read `.agents/CODEX-SKILL-COMPATIBILITY.md` before adapted, gated, or dangerous skills.

## Runtime Boundary

- Do not execute `.claude/hooks/session-start.sh` in Codex.
- No unit tests or type tests unless the user asks.
- Do not inherit Claude-only runtime behavior: popup-tool rules, SessionStart
  directives, default `caveman` activation, Anthropic model names, Claude skill
  invocation syntax, or automatic git integration.
- Translate Claude-only tool names to the available Codex equivalent per
  `.agents/codex-tools.md`. Current Codex system, developer, sandbox, approval,
  and tool instructions take precedence.
- Treat `$ARGUMENTS` in a skill as the current invocation's free-form input.

## Skills

- `.claude/skills/` remains Claude's library. Codex uses standalone native skills under `.agents/skills/`, registered in `.agents/skill-modes.json` as `native` or `disabled` (Claude-only). Read them directly and resolve resources from their Codex skill directory.
- Adding or editing a skill updates its standalone Codex version in the same change and registers it `native` (or `disabled`) in `.agents/skill-modes.json`; never ship a generated adapter. For a `native` skill, once its port matches, run `node .claude/scripts/sync-codex-skills.mjs --baseline <name>` (`disabled` skills skip it), then `--check`, which fails on drift or a missing registration.
- Tool mapping: `.agents/codex-tools.md`. Maintenance and personal copies: `docs/codex-skills.md`.

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

## Browser per session

- Browser per session, never shared. The official playwright plugin holds one persistent profile; a second connection fails with "Browser is already in use ... use --isolated" and deadlocks. Parallel or subagent browser work uses `@playwright/mcp --isolated` (in-memory profile; copy `.mcp.json` from claude-starter).
