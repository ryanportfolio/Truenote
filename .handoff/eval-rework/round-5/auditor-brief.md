# Auditor brief: eval-rework round 5 (S5a Frontend: types, API client, Runs view)

You are an independent auditor in a fresh context. You did not write this work. Judge only from your own inspection, command runs and screenshots you take and read yourself. Do not edit any source file. Write scratch files only under /home/user/Truenote/.tmp/long-horizon/eval-rework/round-5/audit/. Do not run any git command that changes refs, the index or HEAD. Use ./node_modules/.bin/{tsc,vitest} from artifacts/rag-app (npx is blocked). Return your report as your final message.

Workspace root: /home/user/Truenote. Contract version: 1.

## Required behavior (Runs side of /admin/evaluations, rag-app)
1. types/api.ts and lib/api.ts carry: EvalQuestionItem.expectedAnswer/isProtected; questions response expectedAnswerReady; client functions for POST /questions/bulk, GET /questions/suggestions, POST /questions/draft; startEvalRun accepting trial {routeId, reasoningEffort?, threshold?, topK?}; configuration.trial; result expectedAnswer, correctness, correctnessJudgeFailed; summary correctnessJudgeFailures (older-run fields optional).
2. Header explains the page in plain words (a test set of questions with known answers or expected refusals; a run grades the live assistant so you can see if a change helped or hurt).
3. Launcher: "Run evaluation" (live) and a "Trial run" panel with model (approved routes), effort limited to that route's supportedEfforts (toggle routes labelled Reasoning On/Off), threshold 0..1, top K 1..20, faithfulness judge checkbox; a pre-run estimate line with question count, answer calls, judge calls when judging, AI-graded answers when any, and minutes from the last completed run's p50 latency × n / 3. Starting a trial posts trial fields and the run progresses to completed in the UI.
4. Selected run: lead sentence "{passed} of {total} passed ({pct})"; when not the baseline, newly failing / newly passing counts; trial runs show a Trial badge and setup line; metric tiles show counts where available and each has an info control with an accessible name explaining the metric in plain words.
5. Small-set warning when scored questions < 30 stating points per question and a noise band.
6. Baseline diff lists newly failing and newly passing questions by questionId, shown even when setups differ (with a "different setup" note); numeric deltas only when comparableToBaseline.
7. Result rows show expected answer and correctness verdict + reason, or "Answer grading failed".
8. Run history marks trial runs and shows pass as count with percentage.
9. Design rules: semantic tokens only (no raw hex/rgb/oklch literals in TSX), literal Tailwind classes (no template-built class names), accessible names on controls, no em dashes in UI copy, existing primitives reused.

Write scope: artifacts/rag-app/src/types/api.ts, lib/api.ts, lib/evaluationMetrics.ts, pages/AdminEvaluations.tsx, components/admin/evaluations/* (new), existing rag-app tests only if broken (no new test files), index.css only for a small rule.

Baseline: manifest /home/user/Truenote/.tmp/long-horizon/eval-rework/round-5/baseline.json, git ref refs/long-horizon/eval-rework/round-5.

## Procedure (in this order)
1. `cd /home/user/Truenote && node .claude/skills/long-horizon/scripts/manifest.mjs . .tmp/long-horizon/eval-rework/round-5/audit/current.json artifacts/rag-app/src && node .claude/skills/long-horizon/scripts/manifest.mjs --diff .tmp/long-horizon/eval-rework/round-5/baseline.json .tmp/long-horizon/eval-rework/round-5/audit/current.json` (no --ref flag), `git diff refs/long-horizon/eval-rework/round-5 --stat`, `git status --short`. All changes inside the write scope.
2. Done-check:
   a. artifacts/rag-app: tsc -p tsconfig.json --noEmit exit 0; vitest run all pass.
   b. `grep -nE "#[0-9a-fA-F]{3,6}\b|rgb\(|oklch\(|—|\\$\{[^}]*\}-|className=\{\`" ` over the changed/new TSX files; justify or flag any hit (a template className is only a defect if it builds a Tailwind class name dynamically).
   c. Browser: from /home/user/Truenote start `node scripts/preview/review-env.mjs > .tmp/long-horizon/eval-rework/round-5/audit/preview.log 2>&1 &` and record the pids of the mock API (5099) and Vite (5180) via `ss -ltnp`; wait for http://localhost:5180/. Use playwright-core (`createRequire("/opt/node-tools/node_modules/")`), chromium at /opt/pw-browsers/chromium, headless:false, args ["--window-position=-2400,-2400"], run under `xvfb-run -a env FONTCONFIG_FILE=/home/user/Truenote/.tmp/wow-loop/demo-portals/fonts.conf node <script>`. Persona: http://localhost:5180/api/__mock/as/super_user, then /admin/evaluations. At 1440 and 768 widths, verify each requirement 2-8 by locating elements by role/name/text and by screenshots you read yourself: select the later live run, the trial run, the baseline; open the trial panel, pick Nemotron 3.5 Lightning and confirm its effort control offers only On/Off, pick GPT-5.4 Nano and confirm five levels; confirm the estimate line; start a trial and poll until completed; expand a result with a correctness verdict; open two metric help controls. Record console errors (must be none) and any horizontal overflow at 768.
   d. Stop the preview by the recorded pids; confirm ports 5180 and 5099 are free.
3. Report three verdicts with evidence: status complete/incomplete/blocked (incomplete adds repairable yes/no with your own diagnostic; a broken check = blocked: invalid check); integrity clean/suspect/violation; contract aligned/drifted (version 1). List screenshot paths you read.
