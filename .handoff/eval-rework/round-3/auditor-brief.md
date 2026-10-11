# Auditor brief: eval-rework round 3 (S3 Runs backend)

You are an independent auditor in a fresh context. You did not write this work. Judge only from your own inspection and command runs. Do not edit any source file. Write scratch files only under /home/user/Truenote/.tmp/long-horizon/eval-rework/round-3/audit/. Do not run any git command that changes refs, the index or HEAD (no commit, stash, update-ref, checkout, reset). Use ./node_modules/.bin/{tsc,vitest,tsx} from artifacts/api-server (npx is blocked). Return your report as your final message (you cannot write report files).

Workspace root: /home/user/Truenote. Contract version: 1.

## Required behavior
- lib/retrieval/query.ts: RetrievalInput gains optional threshold; retrieve uses `input.threshold ?? runtime.threshold`; topK input honored. No other change in that file.
- POST /api/admin/evaluations/runs body accepts trial { routeId (approved), reasoningEffort? (must be in the route's supportedEfforts else 400 "Pick an effort level that model supports"), threshold? 0..1, topK? int 1..20 }. Only RunBody/POST /runs changed in routes/admin/evaluations.ts in this round.
- Run configuration gains trial:boolean; a trial run's routeChain is exactly one route (the pinned one with the requested or default effort), generation = that route, retrieval threshold/topK reflect overrides; overrides persisted for the worker. Older configurations without trial still read.
- Worker: trial runs pass primaryRoute (with the trial effort) to generateAnswer and threshold/topK to retrieve; non-trial unchanged.
- Questions evaluate with concurrency 3; result order = question order; progress advances per finished question through the existing lease-guarded write; a rejected progress write stops new questions and no report is written.
- expectedAnswer loaded tolerantly (missing column => null), included in frozen definitions and the question-set hash.
- EvalQuestionResult has expectedAnswer, correctness {verdict, reason} | null, correctnessJudgeFailed. Correctness judged for every non-refused in-KB answer with an expectedAnswer regardless of the faithfulness toggle; judge error => pass false, error "Answer grading failed". answerCorrect = AND of phrases (if any) and verdict "correct" (if expectedAnswer), null if neither. In-KB pass = not refused AND citation ok (if expectedDocId) AND answerCorrect !== false AND no judge failure. Out-of-KB pass iff refused. classify in-KB when expectedDocId, phrases or expectedAnswer set.
- EvalSummary has correctnessJudgeFailures.
- Question routes fix: GET /questions with no selected program includes expectedAnswerReady; question create and PUT write the row and the expected_answer/is_protected extras inside one db.transaction.

Write scope: artifacts/api-server/src/lib/eval/runner.ts, queue.ts, persistence.ts, artifacts/api-server/src/lib/retrieval/query.ts, artifacts/api-server/src/routes/admin/evaluations.ts (RunBody + POST /runs, plus the question routes fix), scripts/src/eval.ts (only if needed for types), existing tests under artifacts/api-server/src/lib/eval/__tests__/, artifacts/api-server/src/lib/retrieval/__tests__/, artifacts/api-server/src/routes/admin/__tests__/ only if broken (no new test files).

Baseline: manifest /home/user/Truenote/.tmp/long-horizon/eval-rework/round-3/baseline.json, git ref refs/long-horizon/eval-rework/round-3.

## Procedure (in this order)
1. `cd /home/user/Truenote && node .claude/skills/long-horizon/scripts/manifest.mjs . .tmp/long-horizon/eval-rework/round-3/audit/current.json artifacts/api-server/src lib/db scripts/src && node .claude/skills/long-horizon/scripts/manifest.mjs --diff .tmp/long-horizon/eval-rework/round-3/baseline.json .tmp/long-horizon/eval-rework/round-3/audit/current.json` (NO --ref flag), `git diff refs/long-horizon/eval-rework/round-3 --stat`, `git status --short`. Every changed path must be inside the write scope; in evaluations.ts, hunks only in RunBody/POST /runs and the question routes fix.
2. Done-check (cwd /home/user/Truenote/artifacts/api-server):
   a. tsc -p tsconfig.json --noEmit exit 0; vitest run all pass. Also typecheck scripts if a local tsc exists there (`cd /home/user/Truenote/scripts && ls node_modules/.bin/tsc && node_modules/.bin/tsc -p tsconfig.json --noEmit`).
   b. Read the diffs against every requirement above.
   c. Scratch .mts in the audit dir, run with tsx: exercise whatever the code exposes (exported pool helper, pass-rule/grading function, trial override assembly, or runEval/evaluateOne with injectable deps). At minimum prove: (i) concurrency peak is 3 and result order equals input order with uneven delays; (ii) the pass rule truth table for: phrases only, expectedAnswer only (correct/partial/incorrect/judge throws), both, refused in-KB, out-of-KB refused/not; (iii) trial assembly yields a single-route chain with the requested effort and the threshold/topK overrides reach retrieve. If something cannot be exercised without a database, state exactly which and verify it by reading instead.
3. Report three verdicts with evidence: status complete/incomplete/blocked (incomplete adds repairable yes/no with your own diagnostic; a broken check = blocked: invalid check); integrity clean/suspect/violation; contract aligned/drifted (version 1).
