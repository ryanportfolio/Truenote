# Auditor brief: eval-rework round 2 (S2 Question-set backend)

You are an independent auditor in a fresh context. You did not write this work. Judge only from your own inspection and command runs. Do not edit any source file. Write only under /home/user/Truenote/.tmp/long-horizon/eval-rework/round-2/audit/. Do not run any git command that changes refs, the index or HEAD (no commit, stash, update-ref, checkout, reset). Use ./node_modules/.bin/{tsc,vitest,tsx} from artifacts/api-server (npx is blocked).

Workspace root: /home/user/Truenote. Contract version: 1.

## The step and its required behavior
Routes under /api/admin/evaluations (artifacts/api-server/src/routes/admin/evaluations.ts):
- New SQL file lib/db/sql/0021_eval_expected_answer.sql adding `eval_questions.expected_answer text` with IF NOT EXISTS. lib/db/src/schema.ts unchanged.
- EvalQuestionItem has expectedAnswer (string|null) and isProtected (boolean); GET /questions returns expectedAnswerReady (boolean). Both columns are read tolerantly: a missing column yields null/false and does not error.
- POST/PUT /questions accept expectedAnswer (trim, empty => null, max 2000) and isProtected (create default false; PUT leaves it unchanged when omitted). In-KB requires at least one of expectedDocId, expectedAnswerContains, expectedAnswer; kind is in-KB when any is set. Out-of-KB clears expectedAnswer. Non-empty expectedAnswer with the column missing => 409 with error "Expected answers need a database update first (lib/db/sql/0021_eval_expected_answer.sql)."
- POST /questions/bulk {items} 1..100: per-item validation like POST /questions; valid items saved; 200 {created, errors:[{index,error}]}.
- GET /questions/suggestions?days (int 1..90, default 30) → {items:[{question, askCount, lastAskedAt, outcome:"refused"|"flagged", alreadyInSet}]} at most 50, from query_log in the selected program and window where refused OR flagged_missing OR feedback < 0, grouped by lower(btrim(question)), refused outcome if any refused row, ordered by count desc then last asked desc; alreadyInSet when an eval question in the program matches lower(btrim(question)). SQL uses parameter binding, filtered by program_id.
- POST /questions/draft {documentId, count 1..10 default 5}: 404 unless the document is in the selected program; uses only that document's current-version chunks; sends through runUtilityCompletion (which applies protectProviderText + ZDR pinning) on the active answers chain with json:true, walking to the next route on failure/unusable reply; 503 {error:"Drafting failed. Try again."} when all fail; tolerant parsing; returns at most count items {question, expectedAnswer, expectedDocId, expectedDocTitle}; saves nothing; rate-limited per user.
- No change to RunBody or any /runs route.

Write scope: artifacts/api-server/src/routes/admin/evaluations.ts, artifacts/api-server/src/lib/eval/question-sources.ts (new), lib/db/sql/0021_eval_expected_answer.sql (new), at most one limiter added in artifacts/api-server/src/lib/security/route-rate-limit.ts or artifacts/api-server/src/middleware/workload-rate-limit.ts, existing test files under artifacts/api-server/src/lib/eval/__tests__/ and artifacts/api-server/src/routes/admin/__tests__/ only if the contract change broke them (no new test files).

Baseline: manifest /home/user/Truenote/.tmp/long-horizon/eval-rework/round-2/baseline.json, git ref refs/long-horizon/eval-rework/round-2.

## Procedure (in this order)
1. `cd /home/user/Truenote && node .claude/skills/long-horizon/scripts/manifest.mjs . .tmp/long-horizon/eval-rework/round-2/audit/current.json artifacts/api-server/src lib/db && node .claude/skills/long-horizon/scripts/manifest.mjs --diff .tmp/long-horizon/eval-rework/round-2/baseline.json .tmp/long-horizon/eval-rework/round-2/audit/current.json`; `git diff refs/long-horizon/eval-rework/round-2 --stat`; `git status --short`. Every changed path must be inside the write scope. Note: artifacts/api-server/src/lib/eval/faithfulness.ts and correctness.ts were changed by an earlier round and are part of the baseline; they must not change again.
2. Done-check (run yourself; cwd /home/user/Truenote/artifacts/api-server):
   a. `./node_modules/.bin/tsc -p tsconfig.json --noEmit` exit 0; `./node_modules/.bin/vitest run` all pass.
   b. Read the diff of evaluations.ts and question-sources.ts against each requirement above; confirm /runs code unchanged (`git diff refs/long-horizon/eval-rework/round-2 -- artifacts/api-server/src/routes/admin/evaluations.ts` shows no hunk inside run routes or RunBody).
   c. Write a scratch .mts under the audit dir and run with `./node_modules/.bin/tsx` that imports the exported draft parser/prompt builder (and any pure helpers) from question-sources.ts and checks: fenced JSON and prose-wrapped JSON parse; items missing question or answer dropped; result capped at count; an unparsable reply yields no items. If the module exports a function taking an injected completion function or route chain, also check that a throwing first route falls through to the second.
   d. Confirm every SQL statement in the new code uses the sql template with bound parameters and filters by program.
3. Report three verdicts with evidence: status complete/incomplete/blocked (incomplete adds repairable yes/no with your own diagnostic; a broken check = blocked: invalid check); integrity clean/suspect/violation; contract aligned/drifted (version 1). Return the report as your final message (subagents cannot write report files here).
