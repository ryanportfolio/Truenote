---
description: Critically review recent code changes (uncommitted diff, latest commit, or active PR) for bugs, schema drift, edge cases, and observability gaps. Use when the user asks to review, audit, check, stress-test, or "look hard at" recent work — including code Claude itself just wrote. Dispatches parallel Sonnet 4.6 subagents (general-purpose, fresh context) so the reviewer is genuinely impartial — not the same context that just wrote the code. Verifies claims with grep/read before asserting, severity-tags findings (blocking / should-fix / nitpick), surfaces things that look suspicious but verified fine, and gives concrete fixes with file:line references.
user-invocable: true
---

# Impartial review

You are reviewing work that was probably written too fast — possibly by you. Your job is to find what's wrong, not validate what's right. **If you wrote the code yourself, look harder, not softer.** Bias toward finding real issues, even at the cost of being uncomfortable.

The hardest bias to overcome is defending code you just wrote. The fix is mechanical: dispatch the actual review to fresh-context Sonnet 4.6 subagents that have not seen the conversation that produced the code. Your job in the main session is to gather the diff, brief the subagents, and consolidate findings.

## Step 1: Identify scope

Use `$ARGUMENTS` if the user named a specific scope (file path, PR number, "the Q&A changes", commit SHA, etc.). Otherwise default to recent work in this priority order:

1. `git status` and `git diff` — uncommitted changes
2. `git log -1 --stat` and `git show HEAD` — most recent commit
3. If there's an open PR on the current branch, include the full PR diff (`git diff origin/main...HEAD`)

State the scope you're reviewing in your first sentence so the user can redirect if it's wrong. Also count the changed lines (`git diff <range> --stat | tail -1`) — you'll need this for Step 2.

## Step 2: Pick review mode

- **Tiny diff (< 50 changed lines, single file, no schema/auth/cache code):** review inline in the main session. Spawning 4 subagents for a 20-line CSS tweak is wasteful.
- **Everything else:** dispatch **four parallel Sonnet 4.6 subagents** (see Step 3). This is the default.

If you're not sure, dispatch. Subagents are cheap relative to a missed bug.

## Step 3: Dispatch four parallel Sonnet 4.6 review subagents

Send all four `Agent` tool calls **in a single message** so they run concurrently. Each uses:

- `subagent_type: "general-purpose"`
- `model: "sonnet"` (resolves to Sonnet 4.6 — the current Sonnet alias)
- A self-contained prompt — subagents do not inherit your context

Each prompt must include:

1. The exact diff to review (paste it inline if < ~1500 lines; otherwise give the exact `git` command and the commit range/branch).
2. Their assigned category bucket (below).
3. The verification rule from Step 4.
4. The severity scheme from Step 5.
5. The per-finding output format from Step 6.
6. An instruction to **only** report findings in their bucket — the main session deduplicates and merges.

### The four buckets

**Bucket A — Correctness & types**
- Bugs, off-by-one, edge cases, logic errors
- Conditions that look right but aren't (`||` vs `??`, missing `await`, mutating loops, truthy/falsy traps)
- Drizzle table ↔ Zod schema drift; inferred type drift
- Consumers of a changed type that no longer compile
- Optional fields added without updating callers

**Bucket B — Data flow, compatibility, error handling**
- Where input comes from, where output goes, what cache rows look like
- Concurrent access; stale or wrong-shape cache rows
- Old data in the DB; old extractions; old cache rows; old API requests
- Required migrations; backwards-incompatible changes
- Failure paths, timeouts, retries; external APIs returning null/empty/wrong shape
- Values assumed present that can be undefined

**Bucket C — Perf, security, observability**
- Extra DB queries per request, prompt size growth, latency, N+1, full-table scans, unbounded loops
- Cross-user data leakage, prompt injection, auth bypasses, PII/secrets in logs, public endpoints
- Logs on paths that matter; silent failure modes (parser returns empty, fallback fires, cache miss) made visible

**Bucket D — Things the author missed** (highest-value bucket — undivided attention, push hard)

This is the single highest-leverage category and gets its own dedicated reviewer. The agent should treat the diff as a list of incomplete changes and look for what wasn't done.

- Updated one of two related code paths and forgot the other (e.g., streaming + non-streaming, server + client, English + i18n locales)
- Changed a type/interface but not all consumers
- Captured data but forgot to persist or read it back
- Added a feature but forgot the tear-down (cleanup, expiry, eviction, cache invalidation)
- Fixed the streaming version but left the non-streaming version broken (or vice versa)
- Added a config option / env var / flag but forgot to thread it through to the code that actually uses it
- Added a new model / provider / route but didn't register it in the dispatcher, switch, or admin list
- Added a column / field but didn't include it in serializers, exports, or display
- Renamed something but left old references (search the diff for the old name)
- Added handling for the success path but not the error path (or vice versa)
- Added a test but didn't run the suite that includes it

For this bucket specifically: greppability beats cleverness. The agent should `grep` the changed identifiers across the codebase and look at every hit to see if anything was missed.

### Subagent prompt template

```
You are an impartial code reviewer. Fresh context — you did not write this code.
Your job: find what's wrong, not validate what's right. Bias toward finding real issues.

## Scope
[paste the diff here, OR give the exact git command + range]

## Your bucket: [A / B / C / D — name]
Review ONLY these categories:
[paste the bucket's bullets]

Do NOT report findings outside your bucket. The main session merges with three
other reviewers covering the rest.

## Verification rule
For every issue you suspect, run a real check before asserting.
- grep for actual call sites before claiming code is unused or that a function does X
- Read the file before claiming a function's behavior or signature
- Don't say "this might break Y" — open Y, look, then say either "Y breaks
  because [specific reason]" or "Y is fine because [specific reason]"
- Distinguish "I haven't checked X" from "I checked X and it's fine"
Plausible-sounding-but-unchecked claims are the most common review failure.
Do not produce them.

## Severity tags
🔴 BLOCKING — Real bug, regression, schema drift, security/privacy issue, data correctness
🟡 SHOULD-FIX — Edge case that will bite, observability gap, inconsistency, parity issue
🟢 NITPICK — Style, future polish, deferable

If every finding is 🟢, you didn't look hard enough. Go back and push harder
on your bucket — especially if you're Bucket D, where 🟢-only output usually
means you didn't grep aggressively enough for missed paths.

## Output format
Return ONLY a list of findings in this format, severity-ordered (🔴 first):

## 🔴 Short title
`path/to/file.ts:123`

[Concrete description: what's wrong, what triggers it, what the impact is.
Reference specific code, not abstract worries.]

**Fix:** [Specific edit. Not "consider improving X" — say what to change and where.]

After the findings, add a section:

## Things I checked and verified fine
- [Item that looked suspicious but you confirmed is OK, with a one-line reason.]

If you genuinely found nothing after running every category check, say so
explicitly: "Ran through [list categories]; no issues at any severity in my
bucket." Do not pad with nitpicks to look productive.
```

## Step 4: Verification rule (applies inline too)

For every potential issue, run a real check before asserting. `grep` for call sites. `Read` the file. Open the consumer and look. Plausible-sounding-but-unchecked claims waste the human's time when they re-investigate and find the claim was wrong.

This rule is repeated inside each subagent prompt, but it also applies to your inline review for tiny diffs and to the merging step in Step 6 — don't paper over a subagent's unverified claim by passing it through.

## Step 5: Severity tags

🔴 **BLOCKING** — Real bug, regression, schema drift, security/privacy issue, or data correctness problem. Should not merge.

🟡 **SHOULD-FIX** — Edge case that will eventually bite, observability gap, inconsistency, minor parity issue between code paths. Should be fixed but not blocking.

🟢 **NITPICK** — Style preference, future polish, deferable consideration. Mention it but make clear it can be skipped.

## Step 6: Merge subagent findings and present

When the four agents return:

1. **Deduplicate.** Two agents may flag the same issue from different angles — merge into one finding, keep the higher severity.
2. **Spot-check the highest-severity claims.** Sonnet 4.6 in a fresh context is good but not infallible. For each 🔴, do a quick `grep`/`Read` to confirm before passing it to the human. If a claim doesn't hold up, demote or drop it and say why.
3. **Severity-order globally.** All 🔴 first across all buckets, then all 🟡, then 🟢 — not bucket-by-bucket and not in the order agents returned.
4. **Present in this format:**

```
## 🔴 Short title of the issue
`path/to/file.ts:123`

[Concrete description: what's wrong, what triggers it, what the impact is.]

**Fix:** [Specific edit to make.]
```

After the findings, include:

```
## Things I checked and verified fine

- [Suspicious-looking item that's actually OK, with a one-line reason. Merge
  these from all four subagents so the human doesn't re-investigate.]

## Recommendation

[Which fixes are blocking merge, which can be a follow-up, which can be skipped.
Be concrete about merge readiness.]
```

If every subagent returned zero findings and your spot-checks confirm: say so explicitly. "Four Sonnet 4.6 subagents reviewed buckets A/B/C/D; all returned zero findings and I confirmed the highest-suspicion items. Recommend merge." Don't manufacture nitpicks — but be extra skeptical of zero findings from Bucket D, since "nothing missed" is rare on a non-trivial diff.

## Anti-patterns to avoid

- **Don't skip subagent dispatch to save tokens on a non-tiny diff.** The whole point of this skill is fresh context. Reviewing in the same session that wrote the code reintroduces the bias the skill exists to defeat.
- **Don't dispatch for a 20-line CSS tweak.** Use judgment — the tiny-diff inline path exists for a reason.
- **Don't pass subagent findings through unchecked.** Spot-check the 🔴s. If a subagent hallucinates a function name or misreads the diff, the human pays the cost.
- **Don't praise the implementation.** "This looks well-structured" is not useful — find what's wrong.
- **Don't list findings in the order subagents returned them.** Severity-order globally so the human can triage top-down.
- **Don't mix "I haven't checked" with "I checked and it's fine."** They're different. State which.
- **Don't give generic advice ungrounded in the code.** Point at the specific line and say what to change.
- **Don't be defensive of code you wrote.** That's the easiest trap. Dispatching to fresh-context subagents is the structural fix; don't undermine it by overruling their findings without verification.
