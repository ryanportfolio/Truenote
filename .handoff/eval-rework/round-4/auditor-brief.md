# Auditor brief: eval-rework round 4 (S4 Fixture API evaluation routes)

You are an independent auditor in a fresh context. You did not write this work. Judge only from your own inspection and command runs. Do not edit any source file. Write scratch files only under /home/user/Truenote/.tmp/long-horizon/eval-rework/round-4/audit/. Do not run any git command that changes refs, the index or HEAD. Return your report as your final message.

Workspace root: /home/user/Truenote. Contract version: 1.

## Required behavior
The fixture API (scripts/preview/mock-api/server.mjs + new scripts/preview/mock-api/evaluations.mjs) serves, for a super user, under /api/admin/evaluations:
- GET /questions → { items, expectedAnswerReady:true }; items have id, programId, question, kind, expectedDocId, expectedDocTitle, expectedAnswerContains, expectedAnswer, isProtected, notes, createdAt; seed includes in-KB with phrases, in-KB with expected answer, out-of-KB, protected.
- POST /questions, PUT /questions/:id, DELETE /questions/:id with: in-KB needing a source, phrase or answer (400 "An in-KB question needs an expected source, phrase, or answer"); unknown expectedDocId rejected; isProtected default false, unchanged when omitted on PUT.
- POST /questions/bulk → { created, errors:[{index,error}] } saving valid items only.
- GET /questions/suggestions → { items:[{question, askCount, lastAskedAt, outcome, alreadyInSet}] }.
- POST /questions/draft {documentId, count} → { items:[{question, expectedAnswer, expectedDocId, expectedDocTitle}] } with count items; unknown document 404 "Source not found in this program".
- GET /runs → { items, persistenceReady:true, noProgramSelected:false }; seeded baseline + later live run with same question-set hash/configuration differing by 2 newly failing and 1 newly passing question + a trial run (configuration.trial true, single route). Fields match artifacts/rag-app/src/types/api.ts EvalRunListItem/EvalSummary/EvalQuestionResult plus configuration.trial, summary.correctnessJudgeFailures, result expectedAnswer/correctness/correctnessJudgeFailed.
- GET /runs/:id → { item, report }.
- POST /runs {judge, questionId?, trial?}: trial.routeId validated against MODEL_ROUTES, effort against supportedEfforts (400 "Pick an effort level that model supports"), threshold 0..1, topK 1..20; 409 when a run is active; the run progresses queued → running → completed over a few seconds and then has results and summary.
- POST /runs/:id/cancel and POST /runs/:id/baseline behave like the real routes (compare with artifacts/api-server/src/routes/admin/evaluations.ts and lib/eval/persistence.ts).
- Non-super-user personas are refused like other admin fixture routes.

Write scope: scripts/preview/mock-api/evaluations.mjs (new), scripts/preview/mock-api/server.mjs (import + registration only), scripts/preview/mock-api/README.md (one line).

Baseline: manifest /home/user/Truenote/.tmp/long-horizon/eval-rework/round-4/baseline.json, git ref refs/long-horizon/eval-rework/round-4.

## Procedure (in this order)
1. `cd /home/user/Truenote && node .claude/skills/long-horizon/scripts/manifest.mjs . .tmp/long-horizon/eval-rework/round-4/audit/current.json scripts/preview && node .claude/skills/long-horizon/scripts/manifest.mjs --diff .tmp/long-horizon/eval-rework/round-4/baseline.json .tmp/long-horizon/eval-rework/round-4/audit/current.json` (no --ref flag), `git diff refs/long-horizon/eval-rework/round-4 --stat`, `git status --short`. Changed paths must be inside the write scope; server.mjs hunks limited to import/registration.
2. Done-check:
   a. `node --check` both .mjs files.
   b. Start the mock API alone: `cd /home/user/Truenote && (MOCK_PORT=5299 PORT=5298 node scripts/preview/mock-api/server.mjs > .tmp/long-horizon/eval-rework/round-4/audit/mock.log 2>&1 & echo $! > .tmp/long-horizon/eval-rework/round-4/audit/mock.pid)`; switch persona to super_user the way server.mjs supports (cookie jar with curl); exercise every endpoint and error case above, a run from POST to completion (poll), cancel on a second run, set baseline; also confirm a CSR persona gets refused. Save the transcript in the audit dir. Kill the server by the recorded pid and confirm port 5299 is free.
   c. Compare field names of emitted objects against artifacts/rag-app/src/types/api.ts (EvalRunListItem, EvalSummary, EvalQuestionResult, EvalQuestionItem) plus the contract additions; list any missing/extra fields.
3. Report three verdicts with evidence: status complete/incomplete/blocked (incomplete adds repairable yes/no with your own diagnostic; a broken check = blocked: invalid check); integrity clean/suspect/violation; contract aligned/drifted (version 1).
