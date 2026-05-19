#!/bin/bash
set -euo pipefail

# SessionStart hook
#
# CLOUD (CLAUDE_CODE_REMOTE=true):
#   - Inject CLAUDE.md into session context
#   - Auto-rebase current branch onto origin/main (cloud sandbox is isolated, safe to rewrite)
#
# LOCAL (CLAUDE_CODE_REMOTE unset):
#   - Read-only fetch from origin
#   - Report ahead/behind for current branch
#   - Report whether local main is behind origin/main
#   - List remote branches not present locally (e.g. cloud sessions from another day)
#   - List open PRs (if gh CLI is available)
#   - Never modifies the working tree or any branch

# Retry a git fetch up to 4 times with exponential backoff (2s, 4s, 8s, 16s).
# The cloud sandbox's local git proxy occasionally returns transient 503s;
# without retries, a single blip surfaces as a SessionStart hook error.
# Usage: fetch_with_retry <args to pass to git fetch...>
fetch_with_retry() {
  local attempt=1
  local max_attempts=4
  local delay=2
  while [ "$attempt" -le "$max_attempts" ]; do
    if git fetch "$@" 2>&1; then
      return 0
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      echo "[SessionStart] fetch attempt $attempt failed, retrying in ${delay}s..." >&2
      sleep "$delay"
      delay=$((delay * 2))
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

# ---------- Cloud path ----------
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  if [ -f "$CLAUDE_PROJECT_DIR/CLAUDE.md" ]; then
    echo "📋 Loading project guidelines from CLAUDE.md..." >&2
    echo "" >&2
    echo "=== CLAUDE.MD PROJECT GUIDELINES ===" >&2
    cat "$CLAUDE_PROJECT_DIR/CLAUDE.md" >&2
    echo "" >&2
    echo "=== END CLAUDE.MD ===" >&2
    echo "" >&2
  fi

  echo "[SessionStart] Syncing branch with latest main..." >&2

  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

  if [ "$CURRENT_BRANCH" = "main" ]; then
    echo "[SessionStart] Already on main branch, skipping sync" >&2
    exit 0
  fi

  echo "[SessionStart] Fetching origin/main..." >&2
  if ! fetch_with_retry origin main; then
    echo "[SessionStart] Warning: Failed to fetch origin/main after 4 attempts; continuing without sync" >&2
    exit 0
  fi

  if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    echo "[SessionStart] Warning: Uncommitted changes detected, skipping sync" >&2
    exit 0
  fi

  echo "[SessionStart] Rebasing $CURRENT_BRANCH onto origin/main..." >&2
  if git rebase origin/main 2>&1; then
    echo "[SessionStart] ✓ Successfully rebased onto origin/main" >&2
  else
    echo "[SessionStart] Rebase failed, aborting..." >&2
    git rebase --abort 2>/dev/null || true

    echo "[SessionStart] Attempting merge with origin/main..." >&2
    if git merge origin/main --no-edit 2>&1; then
      echo "[SessionStart] ✓ Successfully merged origin/main" >&2
    else
      echo "[SessionStart] Warning: Merge failed, you may need to resolve conflicts manually" >&2
      git merge --abort 2>/dev/null || true
      exit 0
    fi
  fi

  echo "[SessionStart] Sync complete!" >&2
  exit 0
fi

# ---------- Local path ----------
# Skip silently if not a git repo
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Skip silently if no origin remote
if ! git remote get-url origin >/dev/null 2>&1; then
  exit 0
fi

echo "[SessionStart] Fetching from origin (read-only sync)..." >&2
if ! fetch_with_retry --all --prune --quiet 2>/dev/null; then
  echo "[SessionStart] Warning: fetch failed after 4 attempts; reporting from cached state" >&2
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "(detached)")

# Current branch ahead/behind origin/<current>
if [ "$CURRENT_BRANCH" != "(detached)" ] \
  && git rev-parse --verify --quiet "refs/remotes/origin/$CURRENT_BRANCH" >/dev/null 2>&1; then
  AHEAD=$(git rev-list --count "origin/$CURRENT_BRANCH..HEAD" 2>/dev/null || echo "0")
  BEHIND=$(git rev-list --count "HEAD..origin/$CURRENT_BRANCH" 2>/dev/null || echo "0")
  if [ "$AHEAD" != "0" ] || [ "$BEHIND" != "0" ]; then
    echo "[SessionStart] $CURRENT_BRANCH: $AHEAD ahead, $BEHIND behind origin" >&2
  fi
fi

# Local main vs origin/main (only flag if user is not currently on main)
if [ "$CURRENT_BRANCH" != "main" ] \
  && git rev-parse --verify --quiet "refs/heads/main" >/dev/null 2>&1 \
  && git rev-parse --verify --quiet "refs/remotes/origin/main" >/dev/null 2>&1; then
  MAIN_BEHIND=$(git rev-list --count "main..origin/main" 2>/dev/null || echo "0")
  if [ "$MAIN_BEHIND" != "0" ]; then
    echo "[SessionStart] Local main is $MAIN_BEHIND commits behind origin/main — checkout main and pull to sync" >&2
  fi
fi

# Remote branches not present locally (cap to 10 most recent by committerdate).
# `|| true` suppresses SIGPIPE (141) when `head -10` closes the pipe early.
NEW_BRANCHES=$(
  {
    git for-each-ref \
      --sort=-committerdate \
      --format='%(refname:short)|%(committerdate:relative)' \
      refs/remotes/origin/ 2>/dev/null \
    | sed 's|^origin/||' \
    | while IFS='|' read -r remote_branch when; do
        [ -z "$remote_branch" ] && continue
        # skip HEAD symbolic ref (varies by git version: "HEAD" or just "origin")
        case "$remote_branch" in
          HEAD|origin) continue ;;
        esac
        if ! git rev-parse --verify --quiet "refs/heads/$remote_branch" >/dev/null 2>&1; then
          printf '  - %s (%s)\n' "$remote_branch" "$when"
        fi
      done \
    | head -10
  } || true
)
if [ -n "$NEW_BRANCHES" ]; then
  echo "[SessionStart] Branches on origin not present locally (most recent first):" >&2
  printf '%s\n' "$NEW_BRANCHES" >&2
fi

# Open PRs (if gh available and authenticated)
if command -v gh >/dev/null 2>&1; then
  OPEN_PRS=$(gh pr list --state open --limit 5 \
    --json number,title,headRefName \
    --jq '.[] | "  #\(.number) [\(.headRefName)] \(.title)"' 2>/dev/null || true)
  if [ -n "$OPEN_PRS" ]; then
    echo "[SessionStart] Open PRs:" >&2
    printf '%s\n' "$OPEN_PRS" >&2
  fi
fi

exit 0
