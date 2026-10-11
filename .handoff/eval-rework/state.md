# Contract  (original retained; explicit user changes recorded as amendments)
Goal: Rework the super-user Evaluation Center (/admin/evaluations) in one PR on branch claude/focused-knuth-dsfx43 (tree = origin/main 1ef8b7a at start). The owner found the page confusing and asked for a critical rework; they approved, in one PR: (1) trial runs that test a model/effort/threshold/topK without changing production, a per-question diff against the baseline, a plain-language summary with counts and a small-set warning, and faster runs with a time/call estimate; (2) growing the question set: add from real refused/flagged questions, AI-drafted questions from a source document (approved before saving), CSV import, and an "expected answer" graded by an AI judge; (3) the faithfulness judge moved off direct OpenAI onto an OpenRouter ZDR-pinned route, a protected (held-out) toggle in the UI, and plain explanations of each metric. The fixture API gains evaluation routes so the page can be browser-checked.

Repo rules that bind every step (from CLAUDE.md): no new unit tests unless the user asks (existing tests may be updated when a contract change breaks them); never run pnpm install; no drizzle-kit; schema change = one raw SQL file lib/db/sql/NNNN_name.sql; product non-negotiables (citations or refusal, program scoping server-side, refusal over hallucination) untouched; all provider calls stay inside OpenRouter ZDR pinning (provider: {only:[p], zdr:true, data_collection:"deny", allow_fallbacks:false}) and run text through protectProviderText; Tailwind v3 literal class names only; semantic tokens only (no raw colors); UI copy plain, no em dashes; no model identifiers in commits/PR text.

## API contract (all routes under /api/admin/evaluations; super user; scoped to the selected program like today)

Questions
- EvalQuestionItem gains `expectedAnswer: string | null` and `isProtected: boolean`.
- GET /questions response gains `expectedAnswerReady: boolean` (true when the eval_questions.expected_answer column exists).
- POST /questions and PUT /questions/:id body gains `expectedAnswer?: string | null` (trim, max 2000) and `isProtected?: boolean` (default false on create; unchanged when omitted on update). An in-KB question needs at least one of expectedDocId, expectedAnswerContains, expectedAnswer. A non-empty expectedAnswer while the column is missing answers 409 `{ error: "Expected answers need a database update first (lib/db/sql/0021_eval_expected_answer.sql)." }`. kind classification: in-KB when any of the three is set.
- POST /questions/bulk body `{ items: QuestionBody[] }` (1..100) → 200 `{ created: EvalQuestionItem[], errors: Array<{ index: number; error: string }> }`; each item validated like POST /questions; valid items saved even when others fail.
- GET /questions/suggestions?days=30 (days 1..90, default 30) → `{ items: Array<{ question: string; askCount: number; lastAskedAt: string; outcome: "refused" | "flagged"; alreadyInSet: boolean }> }`, at most 50, from query_log in the selected program in the window: refused = refused true; flagged = flagged_missing true or feedback < 0 (when not refused). Grouped by lower(trim(question)), most asked first. alreadyInSet = an eval question in the program has the same lower(trim(question)).
- POST /questions/draft body `{ documentId: uuid, count?: 1..10 (default 5) }` → `{ items: Array<{ question: string; expectedAnswer: string; expectedDocId: string; expectedDocTitle: string }> }`. Nothing is saved. Reads that document's current-version chunks in the selected program (404 if the document is not in the program), sends excerpts through protectProviderText to the first route of the active answers chain via runUtilityCompletion (JSON mode where supported), parses and keeps only items with non-empty question and answer. Rate-limited (reuse workloadRateLimitMiddleware or a per-user limit). 503 `{ error }` when the model reply is unusable.

Runs
- POST /runs body gains `trial?: { routeId: ApprovedModelRouteId; reasoningEffort?: ReasoningEffort; threshold?: number (0..1); topK?: number (1..20 int) }`. routeId must be an approved route; reasoningEffort must be in that route's supportedEfforts (400 otherwise). A trial run pins that single route (no fallback chain) with the given effort, and passes threshold/topK to retrieval for that run only (no env var or app_settings change).
- EvalRunConfiguration gains `trial: boolean`; for a trial, routeChain = [the pinned route with its effort], generation = that route, retrieval.threshold/topK = the overrides (else runtime values). Non-trial runs: trial false, unchanged otherwise.
- Questions run 3 at a time (concurrency 3); results stay in question-set order; progress (completedQuestions) still advances; cancel still stops after in-flight questions.
- EvalQuestionResult gains `expectedAnswer: string | null`, `correctness: { verdict: "correct" | "partial" | "incorrect"; reason: string } | null`, `correctnessJudgeFailed: boolean`. Correctness is judged for every non-refused in-KB answer whose question has an expectedAnswer, whether or not the faithfulness toggle is on.
- Pass rule, in-KB: not refused AND citation ok (if expectedDocId) AND every phrase present (if phrases) AND correctness verdict "correct" (if expectedAnswer). A correctness judge failure fails the question with error "Answer grading failed". Out-of-KB: unchanged (pass iff refused).
- answerCorrect (existing field) = combined result of phrases and correctness where present (null when neither applies). EvalSummary gains `correctnessJudgeFailures: number`.

Judges (both via OpenRouter, base URL https://openrouter.ai/api/v1, OPENROUTER_API_KEY)
- Faithfulness: model "openai/gpt-6.1-sol", provider {only:["azure"], zdr:true, data_collection:"deny", allow_fallbacks:false}, reasoning_effort "medium", structured output as today. Judge label recorded unchanged in meaning.
- Correctness: same route; input question, expected answer, answer; output {verdict, reason}; inputs through protectProviderText; a paraphrase that conveys the expected facts is "correct"; a missing or contradicted key fact is "incorrect"; some but not all key facts is "partial".

Frontend (rag-app)
- Runs view: plain one-line summary ("17 of 20 passed (85%)"), counts shown with percentages, a warning when the scored set has fewer than 30 questions ("each question moves the score N points"); a "Compared with baseline" list of newly failing / newly passing questions (by questionId) when a baseline exists, shown even when configurations differ (labelled as a different setup); metric help text explaining each metric in plain words; trial runs labelled "Trial" in history with their setup.
- Run launcher: "Run evaluation" for the live setup and "Trial run" with route, effort (only supported levels; Lightning shows On/Off), threshold, topK; an estimate line before start: questions, answer calls, judge calls, and approx time from the last completed run's p50 latency × questions / 3.
- Questions view: form adds Expected answer (textarea) and Held-out toggle (with a one-line explanation); a "Suggestions from real questions" panel listing refused/flagged questions with Add (opens form prefilled; refused defaults to kind out-of-kb but editable); "Draft from a source" (pick a document, count) showing drafts each with Approve/Edit/Discard, approve saves via POST /questions; CSV import (columns: question, kind, expected_answer, expected_source, expected_phrases (semicolon separated), notes; header row required) with a preview and per-row errors, saved via /questions/bulk. When expectedAnswerReady is false the Expected answer field is disabled with a note.
- Delete confirmation uses the shared ConfirmDialog (useConfirm), not window.confirm.

# Acceptance
1. `cd artifacts/api-server && npx tsc -p tsconfig.json --noEmit` exits 0 and `npx vitest run` passes all tests.
2. `cd artifacts/rag-app && npx tsc -p tsconfig.json --noEmit` exits 0 and `npx vitest run` passes all tests.
3. Stub-client check: faithfulness and correctness judge requests carry model openai/gpt-6.1-sol, provider only ["azure"], zdr true, data_collection "deny", allow_fallbacks false, and the OpenAI client is constructed with the OpenRouter base URL; no direct-OpenAI client remains in lib/eval.
4. lib/db/sql/0021_eval_expected_answer.sql adds eval_questions.expected_answer text (IF NOT EXISTS); question reads/writes tolerate the column's absence (expectedAnswerReady false, 409 on a non-empty expectedAnswer).
5. Trial runs: POST /runs validates trial fields per the contract; the worker pins the single route with the requested effort and passes threshold/topK into retrieve() for that run only; configuration.trial is recorded.
6. Runner executes 3 questions concurrently, preserves order, and applies the pass rule including correctness.
7. Fixture API (scripts/preview/mock-api) serves every contract endpoint with plausible data, including a run that progresses over a few seconds and a baseline with a differing result set.
8. Local fixture browser check at 1440 and 768: Runs view summary/counts/small-set warning/baseline diff/metric help/trial launcher with estimate; Questions view expected answer + held-out, suggestions add, draft approve, CSV import preview and save, delete via ConfirmDialog; no console errors.
9. Docs: .claude/reference/eval.md describes the new flow, judges routing, trial runs, expected answers, and the 0021 SQL step; DESIGN.md updated only if new visual vocabulary was introduced.
Version: 1

# Amendments
- (none)

# Verified progress
- S1 Judges: faithfulness judge on OpenRouter (baseURL openrouter.ai/api/v1, OPENROUTER_API_KEY), model openai/gpt-6.1-sol, effort medium, provider only azure + zdr + deny + no fallbacks; new correctness.ts judgeAnswerCorrectness({question, expectedAnswer, answer}) -> {verdict, reason}; protectProviderText on all texts; no direct-OpenAI client in lib/eval. Exports from faithfulness.ts: getJudgeClient, JUDGE_MODEL, JUDGE_REASONING_EFFORT, JUDGE_PROVIDER. — contract version: 1; evidence: round-1 auditor a5764d0023876abd1 (tsc 0, vitest 936/936, stub bodies + real-SDK URL in evidence/round-1/check.out); brief round-1/auditor-brief.md; baseline refs/long-horizon/eval-rework/round-1. Committed as 4e4f94b.
- S2 Question-set backend: 0021 SQL (expected_answer, unbound); tolerant expectedAnswer/isProtected reads (information_schema check cached 60s) + 409 when column missing; POST/PUT extras via raw UPDATE; POST /questions/bulk; GET /questions/suggestions (lib/eval/question-sources.ts loadQuestionSuggestions); POST /questions/draft (draftQuestionsWithChain over answers chain, json mode, 503 on exhaustion, evalQuestionDraftLimit 10/min). PUT omitting expectedAnswer clears it (replace semantics). — contract version: 1; evidence: round-2 auditor a227e286dc8e047e3 (tsc 0, vitest 936, 13/13 scratch checks at round-2/audit/draft-check.mts, SQL bound + program-filtered); brief round-2/auditor-brief.md; baseline refs/long-horizon/eval-rework/round-2. Committed as af63f13.
- S3 Runs backend: RetrievalInput.threshold override; RunBody.trial (EvalTrialOverridesSchema in persistence.ts) with 400s; configuration.trial + trialOverrides; captureConfiguration(judge, trial) exported; worker pins primaryRoute with trial effort and passes threshold/topK; mapWithConcurrency (3), order kept, cancel semantics kept; expectedAnswer loaded tolerantly, in snapshot and hash (only when set); correctness judged always for in-KB with expectedAnswer; pass rule per contract; summary.correctnessJudgeFailures; configurationFrom no longer requires `fallback` (fixes null configuration on every ZDR-only run); question routes: noProgram expectedAnswerReady false, create/PUT transactional. runEval(questions, callbacks, deps) injectable. — contract version: 1; evidence: round-3 auditor a70b3771615a28ea7 (tsc 0 api + scripts, vitest 936, 24/24 runtime checks evidence/round-3/audit.mts); brief round-3/auditor-brief.md; baseline refs/long-horizon/eval-rework/round-3. Committed as c3c3590 + 2a326cd.
- S4 Fixture API: scripts/preview/mock-api/evaluations.mjs registered in server.mjs; every contract endpoint with seeded baseline (101, 10/12), live run (102, 03+07 newly fail, 04 newly passes), trial run (103, Lightning, threshold 0.25); run lifecycle queued -> running -> completed (~700 ms/question); cancel, baseline, validation, program scope, persona 403s; draft returns exactly count. Fixture message differences from brief match the real API (409 "An evaluation is already running for this program", cancel "Cancelled by super user"); fixture POST/PUT give the specific in-KB message while the real single POST/PUT give "Invalid evaluation question". — contract version: 1; evidence: round-4 auditor a6421efc9084f5e69 (all but draft count) + round-4r auditor aa8175b84819665ac (120/120 draft cases, other routes byte-identical to baseline when masked); briefs round-4/ and round-4r/; refs round-4, round-4r. Committed 4797a72 + 1f4a08d.

# Remaining
5. S5a Frontend types, API client, Runs view rework (summary, diff, help, trial launcher, estimate). depends on: 3, 4; writes: artifacts/rag-app/src/types/api.ts, artifacts/rag-app/src/lib/api.ts, artifacts/rag-app/src/lib/evaluationMetrics.ts, artifacts/rag-app/src/pages/AdminEvaluations.tsx, artifacts/rag-app/src/components/admin/evaluations/* (new).
6. S5b Frontend Questions view (form fields, suggestions, drafts, CSV import, ConfirmDialog). depends on: 5; writes: artifacts/rag-app/src/pages/AdminEvaluations.tsx, artifacts/rag-app/src/components/admin/evaluations/*.
7. S6 Docs (.claude/reference/eval.md, DESIGN.md if needed). depends on: 3, 6; writes: .claude/reference/eval.md, DESIGN.md.

# Current rounds
Round: 5   Batch: 6   Phase: executing
Contract version: 1
Workspace: /home/user/Truenote (main workspace; sequential rounds)
Workers: executor ac51d0892f81e376c (running)
Step: S5a Frontend types, API client, Runs view (Remaining 5)
Done-check: per round-5/auditor-brief.md (rag-app tsc/vitest; grep design rules; fixture browser at 1440 + 768 covering requirements 2-8; trial run to completion; no console errors; ports freed)
Write scope: rag-app src types/api.ts, lib/api.ts, lib/evaluationMetrics.ts, pages/AdminEvaluations.tsx, components/admin/evaluations/* (new), index.css small rule only
Baseline: .tmp/long-horizon/eval-rework/round-5/baseline.json + refs/long-horizon/eval-rework/round-5 (1f4a08d)
Auditor brief: .tmp/long-horizon/eval-rework/round-5/auditor-brief.md sha256 c37381051dd72edb9f4fe25306ab983361736148ec562d50ad098a16b53c8bdc
Residue: none

# Dead ends
- (none)

# Method notes
- Fixture preview: `node scripts/preview/review-env.mjs` serves http://localhost:5180 (mock API 5099); persona via GET /api/__mock/as/super_user. Browser: playwright-core from /opt/node-tools/node_modules via createRequire, executablePath /opt/pw-browsers/chromium, headless:false under `xvfb-run -a`, env FONTCONFIG_FILE=/home/user/Truenote/.tmp/wow-loop/demo-portals/fonts.conf. Stop the preview by killing the PIDs you recorded (pkill -f patterns can kill your own shell). source: Manager; confirmed in earlier PRs.
- Typecheck/test commands: `cd artifacts/api-server && npx tsc -p tsconfig.json --noEmit`, `npx vitest run`; same in artifacts/rag-app. Never pnpm install. source: Manager; confirmed.

- NEVER pass `--ref HEAD` (or any branch name) to manifest.mjs: --ref runs `git update-ref <ref> <stash snapshot>`, so `--ref HEAD` moves the branch onto a stash commit. Audit manifests omit --ref; only Manager baselines pass refs/long-horizon/eval-rework/round-N. source: round 1 (auditor brief defect moved HEAD to 6039b3d at 19:00:04; content intact, history carries stash commits until squash merge); confirmed.

- Use ./node_modules/.bin/{tsc,vitest,tsx} from the package dir; `npx` is denied by the auto-mode classifier for subagents. Subagents cannot write report files; the final message is the report. source: round 1 auditor; confirmed.

# Audit log
- round 4r (batch 5): S4 recovery (draft count) — complete/clean/aligned; 120/120 draft cases, baseline comparison shows only added items.
- round 4 (batch 4): S4 Fixture API — incomplete (repairable: yes)/clean/aligned; all endpoints pass except draft returns fewer than count on short docs (4/29 at 5, 20/29 at 10). Recovery round 4r = step's 2nd attempt.
- round 3 (batch 3): S3 Runs backend + round-2 fixes — complete/clean/aligned; tsc 0, vitest 936, 24/24 runtime checks; POST /runs, SQL, transactions verified by reading only (no DB). HEAD moved mid-audit by Manager's WIP commit 2a326cd (content unchanged).
- round 2 (batch 2): S2 Question-set backend — complete/clean/aligned; tsc 0, vitest 936, 13 draft checks. Non-blocking findings: noProgramSelected GET /questions lacks expectedAnswerReady; insert+extras UPDATE not transactional (both folded into round 3); 60s column cache delay after 0021 applied (accepted).
- round 1 (batch 1): S1 Judges — complete/clean/aligned; tsc 0, vitest 936 pass, stub + real-SDK request checks. Note: auditor brief's `--ref HEAD` moved the branch to stash commit 6039b3d (Plan defect, see Method notes); later committed on top as 4e4f94b and pushed; left for squash merge.

# Handoff note (2026-10-11, old session ran low on usage)
- This folder is a tracked copy of .tmp/long-horizon/eval-rework (state, briefs, baseline manifests). Restore it to .tmp/long-horizon/eval-rework/ in the new session and delete .handoff/ from the branch before the PR is opened.
- The refs/long-horizon/eval-rework/round-N git refs were local to the old container and are gone. Baseline manifests remain; their pinned commit for round 5 was 1f4a08d (pushed).
- Round 5 executor ran in the old session; its partial or finished output is whatever is committed on the branch after 1f4a08d. Its writer stopped when the old session ended. Treat round 5 as interrupted execution: keep the edits, record integrity unavailable for attribution, and run a recovery round 5r from the current workspace (new baseline + ref taken at that point) whose executor finishes the round-5 step, then audit with the round-5 auditor brief requirements against the new baseline.
