# Auditor brief: eval-rework round 6 (S5b Frontend: Questions view)

You are an independent auditor in a fresh context. You did not write this work. Judge only from your own inspection, command runs and screenshots you take and read yourself. Do not edit any source file. Write scratch files only under /home/user/Truenote/.tmp/long-horizon/eval-rework/round-6/audit/. Do not run any git command that changes refs, the index or HEAD. Use ./node_modules/.bin/{tsc,vitest} from artifacts/rag-app (npx is blocked). Return your report as your final message.

Workspace root: /home/user/Truenote. Contract version: 1.

## Required behavior (Questions side of /admin/evaluations)
1. Question form has Expected answer (disabled with a note when expectedAnswerReady is false) and a Held-out checkbox, each with a plain one-line explanation; in-KB requires a source, phrase, or expected answer; form can be prefilled.
2. List shows Held-out and AI-graded tags and what each question checks; delete goes through the shared ConfirmDialog (useConfirm), not window.confirm.
3. Entry points: Add question, From real questions, Draft from a source, Import CSV; one panel open at a time.
4. From real questions: 7/30/90 window, outcome tag, ask count, last asked, Add prefilling the form (refused -> refuse kind, flagged -> answer kind), In set disabled when alreadyInSet, empty state.
5. Draft from a source: document + count, pending state, cards with Approve (saves in-kb with expected source + answer), Edit (prefills form), Discard; explains nothing is added until approved; errors inline.
6. Import CSV: client-side RFC 4180 parsing (quoted commas, escaped quotes, embedded newlines, CRLF), header required, columns question, kind, expected_answer, expected_source (title match, unknown = row error), expected_phrases (semicolons), notes, held_out; preview with per-row errors; saves valid rows through POST /questions/bulk in chunks of 100 and shows results; template download.
7. Existing behaviors kept: Questions tab count, run-one-question, edit, program switch reset.
8. Design rules: semantic tokens only, literal Tailwind classes, accessible names on controls, no em dashes in UI copy, existing primitives reused, no new dependency.

Write scope: artifacts/rag-app/src/pages/AdminEvaluations.tsx, artifacts/rag-app/src/components/admin/evaluations/*, artifacts/rag-app/src/lib/evaluationMetrics.ts or new artifacts/rag-app/src/lib/csv.ts, existing rag-app tests only if broken (no new test files).

Baseline: manifest /home/user/Truenote/.tmp/long-horizon/eval-rework/round-6/baseline.json, git ref refs/long-horizon/eval-rework/round-6.

## Procedure (in this order)
1. `cd /home/user/Truenote && node .claude/skills/long-horizon/scripts/manifest.mjs . .tmp/long-horizon/eval-rework/round-6/audit/current.json artifacts/rag-app && node .claude/skills/long-horizon/scripts/manifest.mjs --diff .tmp/long-horizon/eval-rework/round-6/baseline.json .tmp/long-horizon/eval-rework/round-6/audit/current.json` (no --ref flag), `git diff refs/long-horizon/eval-rework/round-6 --stat`, `git status --short`. All changes inside the write scope; package.json and lockfile unchanged.
2. Done-check:
   a. rag-app tsc exit 0; vitest all pass.
   b. Write your own scratch .mts (run with artifacts/api-server/node_modules/.bin/tsx) importing the CSV parser and checking quoted commas, escaped quotes, embedded newline, CRLF, missing header, unknown kind, unknown source title.
   c. grep the changed TSX for raw colors, template-built class names, em dashes, window.confirm; justify or flag hits.
   d. Browser: start `node scripts/preview/review-env.mjs` in the background from /home/user/Truenote (log under the audit dir), record pids of 5099 and 5180 via `ss -ltnp`, playwright-core via createRequire("/opt/node-tools/node_modules/"), chromium /opt/pw-browsers/chromium, headless:false, args ["--window-position=-2400,-2400"], under `xvfb-run -a env FONTCONFIG_FILE=/home/user/Truenote/.tmp/wow-loop/demo-portals/fonts.conf`. Persona http://localhost:5180/api/__mock/as/super_user, /admin/evaluations, Questions tab. At 1440 and 768 exercise requirements 1-7 end to end (create with expected answer + held-out, edit, delete via dialog, add from suggestion, draft approve/edit/discard, CSV import with good and bad rows including a quoted comma and an unknown source, save). Read your screenshots. Console errors must be none; note horizontal overflow at 768.
   e. Stop the preview by recorded pids; confirm 5180 and 5099 free.
3. Report three verdicts with evidence: status complete/incomplete/blocked (incomplete adds repairable yes/no with your own diagnostic; a broken check = blocked: invalid check); integrity clean/suspect/violation; contract aligned/drifted (version 1). List screenshot paths you read.
