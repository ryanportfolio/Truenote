# Eval Harness

> The eval suite is how you prove (to yourself and to leadership) that retrieval works. Treat it as first-class — not a nice-to-have.

## What it does

For each question in `eval_questions`:
1. Run the full query pipeline (embed → hybrid search → rerank → LLM).
2. Check: did the cited chunk(s) come from `expected_doc_id`?
3. Check: does the answer contain every phrase in `expected_answer_contains`?
4. Check: when `expected_answer` is set, does the correctness judge grade the answer "correct"?
5. Record refusal rate, latency, citation accuracy.

Output: a JSON summary + a per-question breakdown.

## When to run

- Before any PR that touches `ingestion/`, `retrieval/`, the LLM system prompt, or chunk/embedding logic.
- Weekly from the super-user Evaluation Center; pin a trusted completed run as the baseline.
- Before the pitch demo. Walk into the room with a number.

## Pitch-ready metrics

Report these on the admin Evaluation page:

- **Answer accuracy**: % of in-KB questions with expected phrases or an expected answer where every phrase appears in the answer and, when an expected answer is set, the correctness judge graded it "correct" (`combineAnswerCorrect` in `runner.ts`).
- **Citation accuracy**: % of questions where the cited chunk is from the expected doc.
- **Refusal rate on in-KB questions**: should be low (false negatives are bad).
- **Refusal rate on out-of-KB questions**: should be high (false positives = hallucination).
- **p50 / p95 latency**: CSRs are mid-call. Slow = unusable.
- **Stage-level recall (2026-07)**: for questions with `expected_doc_id` — `retrievalRecallPct` (doc entered the pre-rerank candidate pool) and `rerankRecallPct` (doc survived into the top-K). Plus `inKbFailuresByStage` attributing each in-KB failure to `retrieval` / `rerank` / `threshold` / `generation` (`unattributed` = no expected_doc_id or errored). This tells you WHICH stage to tune: retrieval misses → chunking/embedding/query work; rerank misses → candidate K or rerank model; threshold pile-up → retune `RERANK_CONFIDENCE_THRESHOLD` (especially after a `COHERE_RERANK_MODEL` change); generation misses → prompt/model work.
- **Expected-doc rank (2026-07)**: `expectedDocRank` per question (1-based, in the post-rerank top-K) + `expectedDocRankMean`. A doc that passes at rank 7-of-8 is one rerank-model change away from a miss.
- **Claim-level faithfulness (2026-07; the "Judge faithfulness" toggle or `--judge`)**: the judge (see "Judges" below) decomposes each non-refused answer into atomic factual claims and labels each supported/unsupported against the excerpts the LLM saw (Cohere RAG-eval methodology). `meanFaithfulnessPct`, `unfaithfulQuestions`, `judgeFailures`, and per-question `unsupportedClaims` keep partial judge outages visible instead of presenting a partial mean as suite-wide. Catches what phrase-matching can't: a *passing*, well-cited answer with one invented fee. The CLI lists "passing answer(s) with unsupported claims" separately. One extra judge call per judged question, so it is opt-in. Out-of-KB questions that wrongly got answers ARE judged (prime hallucination candidates). Judge model history: gpt-4o before 2026-10-07, so older faithfulness scores are not comparable.
- **Answer grading (correctness)**: `correctness` per question (`verdict` correct / partial / incorrect plus a one-sentence `reason`) and `correctnessJudgeFailures` in the summary. The Evaluation Center shows "Graded: …" with the reason on each result and an "Answer grading" line when any grading call failed.
- **Generation path**: per-question `generationPath` plus `fallbackGenerationCount` / `failedFallbackCount` show when the configured primary degraded to a later ZDR route or every approved route failed.

## Judges

Both judges live in `artifacts/api-server/src/lib/eval/`: `faithfulness.ts` (claims against excerpts) and `correctness.ts` (answer against the expected answer). They share one client and one route:

- OpenRouter, base URL `https://openrouter.ai/api/v1`, key `OPENROUTER_API_KEY`. No eval judge calls OpenAI directly.
- Model `openai/gpt-6.1-sol` (`JUDGE_MODEL`), reasoning effort `medium` (`JUDGE_REASONING_EFFORT`), no temperature, so judge runs are not bit-for-bit repeatable.
- Provider pin (`JUDGE_PROVIDER`): `only: ["azure"]`, `zdr: true`, `data_collection: "deny"`, `allow_fallbacks: false`. Prompts carry excerpts and answers, so they stay inside the same ZDR boundary as answer generation.
- Every text goes through `protectProviderText` before the prompt is built: excerpts and answer for faithfulness; question, expected answer and answer for correctness.
- Structured output (zod schema). Timeout and retries come from the `FAITHFULNESS` deadline (`FAITHFULNESS_TIMEOUT_MS`, default 60000; `FAITHFULNESS_MAX_RETRIES`, default 2) for both judges; there is no separate correctness prefix.

When each one runs and what a failure does:

- **Faithfulness**: only when the run has the judge on, the answer is not a refusal and retrieval returned chunks. A failed call sets `faithfulnessJudgeFailed`, counts in `judgeFailures` and leaves the question unjudged; it never changes pass or fail.
- **Correctness**: on every in-KB question that has an expected answer and got a non-refused answer, whether or not the faithfulness toggle is on. Only "correct" passes; "partial" and "incorrect" fail the answer check. A failed call sets `correctnessJudgeFailed`, sets the result's `error` to "Answer grading failed", counts in `correctnessJudgeFailures`, fails the question and leaves its failure stage unattributed. A refused in-KB question gets no grading call; it already fails.

Changing the judge model shifts both scores; re-run the baseline before comparing against older runs.

## Authoring eval questions

The eval set is only as good as its questions. Bias toward:
- Real questions CSRs actually ask (pull from past tickets/chat logs).
- Edge cases the KB *should* handle (multi-doc answers, recent policy changes).
- A small number of intentional out-of-KB questions to verify refusal.

50 questions is a useful floor. 200+ is when you can publish confidence intervals.

## Evaluation Center flow (`/admin/evaluations`)

Super users only. Everything is scoped to the selected program. The page has two tabs, **Runs** and **Questions**.

1. **Build the question set** (Questions tab). Four ways in:
   - **Add question**: the form takes the question, kind ("Answer from KB" or "Refuse safely"), expected answer, expected source, expected phrases (one per line), a "Held-out question" checkbox and notes. An answer question needs at least one of expected answer, source or phrase.
   - **From real questions**: CSR questions from `query_log` in the last 7, 30 or 90 days (API: 1 to 90, default 30) that were refused, flagged as missing content or rated thumbs-down, grouped by trimmed lower-case text, most-asked first, at most 50 (`question-sources.ts`, `loadQuestionSuggestions`). A row already in the set reads "In set". "Add" opens the form prefilled, as a refuse question when the asked question was refused and as an answer question otherwise. No model call.
   - **Draft from a source**: pick a document and a count (3, 5 or 10; API 1 to 10). The server reads the document's current-version chunk text in order, up to 12,000 characters, and asks the answers model chain for questions with one- or two-sentence expected answers. Nothing is saved until you press **Approve** on a draft (it saves an answer question with that expected answer and the source as expected source); **Edit** opens the form, **Discard** drops it. A source with no processed text, or a chain where every route fails or returns nothing usable, answers 503 "Drafting failed. Try again." Limited to 10 draft requests a minute per user (`evalQuestionDraftLimit`).
   - **Import CSV**: a header row is required; column names match case-insensitively and unknown columns are ignored. Columns (the template from "Download template" has all of them):

     | Column | Format |
     |---|---|
     | `question` | Required, at most 2000 characters |
     | `kind` | `answer` (also `in-kb` or empty) or `refuse` (also `out-of-kb`) |
     | `expected_answer` | At most 2000 characters |
     | `expected_source` | A document title in the selected program, matched ignoring case |
     | `expected_phrases` | Separated by semicolons; at most 20, each at most 500 characters |
     | `notes` | At most 2000 characters |
     | `held_out` | `true` / `false` (also `yes` / `no`, `1` / `0`; empty is false) |

     An answer row needs an expected answer, source or phrase; a refuse row must have none of them. The file is at most 2 MB. The browser checks every row first and shows per-row errors; valid rows go to `POST /api/admin/evaluations/questions/bulk` in batches of 100, which saves each row on its own and returns per-row errors, so one bad row does not block the others.
2. **Run the live setup** (Runs tab): **Run evaluation** queues a run of the whole set with the live answer chain and retrieval settings. The line under the button gives the question count, about how many answer calls, up to how many faithfulness judge calls when "Judge faithfulness" is on, how many answers the AI grades, and about how many minutes (last completed run's p50 latency × questions ÷ 3). The row action "Run this question" queues a single-question run.
3. **Read the summary**: the lead sentence says "N of M passed (P%)." and, when a completed baseline other than the selected run exists, adds "X newly failing, Y newly passing since the baseline." Below it: the setup line, the metric counts, and the secondary stats. With fewer than 30 questions a "Small test set" note says how many points one question moves the score and to treat changes under two questions' worth as noise. "Changes since the baseline" lists newly failing and newly passing questions (matched by question id, each with "Show result"), the unchanged count, and questions only in one of the two runs. When the setup differs from the baseline it says the differences may come from the setup; when the question set or scope differs, score deltas are hidden and only questions in both runs are compared.
4. **Try a trial run** (see "Trial runs" below) to test a model, effort or retrieval setting before changing anything CSRs use.
5. **Pin a baseline**: "Set baseline" on a completed run. One baseline per program.

## Trial runs

**Trial run** on the Runs tab opens a form: model (any approved route), effort (only the levels that route supports; toggle routes show On/Off), threshold (0 to 1) and top K (whole number, 1 to 20). Empty fields use the live value; the faithfulness toggle applies too. The request is `POST /api/admin/evaluations/runs` with `trial: { routeId, reasoningEffort?, threshold?, topK? }` (`EvalTrialOverridesSchema` in `persistence.ts`). The API answers 400 "Pick an approved model" or "Pick an effort level that model supports" for a bad route or effort.

- The worker (`queue.ts`, `captureConfiguration`) resolves the route, uses the requested effort or the effort routing currently sends for it, and checks the route supports it. It never falls back to a normal run: an invalid stored trial fails the run ("Trial run settings are no longer valid", "Trial model is no longer approved", "Trial effort level is not supported by that model").
- A trial pins that one route with no fallback chain (`generateAnswer` gets `primaryRoute`), and passes threshold and top K to `retrieve()` for this run only. It changes no Railway variable, no model-routing setting and nothing CSRs use; candidate K, neighbor anchors and the rerank model stay live.
- The completed run records `configuration.trial: true` and `configuration.trialOverrides` with the effort actually sent; `configuration.retrieval` holds the threshold and top K used. The UI shows a "Trial" chip in the run list and the summary, and a setup line such as "Trial: <model>, medium effort, threshold 0.25, top 8".
- A trial is still one run: the one-active-run-per-program rule and the eval run rate limit apply. When its setup differs from the baseline's, the summary hides score deltas and the diff warns that differences may come from the setup.

## Expected answers (`lib/db/sql/0021_eval_expected_answer.sql`)

`eval_questions.expected_answer` is a nullable `text` column with no default: one or two sentences an admin writes, or accepts from a draft, as the reference answer the correctness judge grades against. It is not bound in Drizzle; the question routes and the runner read and write it with tolerant raw queries. A question with only an expected answer counts as in-KB. The question-set hash includes the expected answer only when one is set, so existing sets keep their hash.

**Not applied to production yet.** Until it is:

- `GET /api/admin/evaluations/questions` returns `expectedAnswerReady: false`; the form's expected-answer field is disabled with "Needs a database update before expected answers can be saved."; drafts cannot be approved (Edit keeps a draft with its source only); CSV rows with an expected answer show an error.
- Creating or updating a question with a non-empty expected answer answers 409 "Expected answers need a database update first (lib/db/sql/0021_eval_expected_answer.sql)." (in the bulk route, as that row's error).
- The runner treats every expected answer as null, so no correctness call runs.

The routes check which optional columns exist through `information_schema` and cache the result for 60 seconds per api-server process (`COLUMN_CHECK_TTL_MS`), so after the column is added the UI can take up to a minute to enable the field.

Apply, per CLAUDE.md "Database schema changes" and `deployment.md`: after the PR merges, `node scripts/railway-apply-sql.mjs lib/db/sql/0021_eval_expected_answer.sql` (dry run, prints the status); after the owner's go, the same command with `--apply`. Then check the column exists and record it in the applied list in `deployment.md`.

## What a run costs

Per question in a normal run:

- 1 query embedding (OpenAI) and, when hybrid search found candidates, 1 Cohere rerank.
- The answer model, unless retrieval refused (no model call then). A route that errors or returns an invalid answer advances to the next route in the chain, so one question can make several answer calls.
- 1 correctness judge call when the question has an expected answer and was answered.
- 1 faithfulness judge call when the toggle is on and the question was answered from retrieved chunks.
- Each provider call can also retry, up to its `<PREFIX>_MAX_RETRIES` setting (`EMBED_QUERY`, `RERANK`, `GENERATION`, `FAITHFULNESS`; `secrets.md`).

A **trial run** makes the same calls, except the answer model is one pinned route with no chain to walk. A **draft** request makes no embedding or rerank call: one answer-chain call (60-second timeout, no retries), moving to the next route only when a route fails or returns nothing usable. **From real questions** is a database query with no model call.

## Running the harness

There is no local database and only one Railway environment (`production`), so the CLI runs only inside the Railway `worker` container, which holds the secrets. Use the demo program `00000000-0000-0000-0000-0000000000aa`:

```bash
railway ssh -p 2aa5cb01-5438-4fbd-aade-626d4e252977 -e b35c4090-cbcd-4deb-9434-e9b63a309bd9 -s worker -- "cd /app/scripts && ./node_modules/.bin/tsx src/eval.ts --program 00000000-0000-0000-0000-0000000000aa --limit 5"
```

Flags for `src/eval.ts` (append inside the quoted command):

```text
--program <uuid>        filter to one program (always pass the demo program)
--question <uuid>       single question (debugging a regression)
--limit 5               smoke test (first 5 questions)
--json                  machine-readable output (suppresses the human summary)
--judge                 claim-level faithfulness judge (extra judge call per non-refused answer)
--threshold 0.25 --top-k 12 --candidate-k 40      run-scoped overrides; Railway variables stay untouched
--rerank-model rerank-v4.0-pro --threshold 0.2     rerank model trial; retune the threshold with it
--neighbors 0                                      A/B neighbor expansion
```

The CLI grades expected answers without a flag: it loads `expected_answer` like the worker does, so any question with one makes a correctness call. Keys it needs, all on `worker`: `DATABASE_URL`, `OPENAI_API_KEY` (query embeddings), `COHERE_API_KEY` (rerank), `OPENROUTER_API_KEY` (answers and both judges). The human summary does not print verdicts: a grading failure shows as `ERROR: Answer grading failed`, and a "partial" or "incorrect" verdict shows only as a failed question; use `--json` for `correctness`. The CLI has no trial-route option; it uses the live chain.

Implementation: `artifacts/api-server/src/lib/eval/runner.ts` is the pure runner — loads questions, calls `retrieve()` + `generateAnswer()` directly (skips HTTP/auth so eval doesn't pollute `query_log`), scores each result. `scripts/src/eval.ts` is the CLI wrapper.

The super-user `/admin/evaluations` surface manages program-scoped questions and
queues durable runs through pg-boss. Runs execute in the existing worker, three
questions at a time (`EVAL_QUESTION_CONCURRENCY`); results keep question-set
order (`created_at`, then id) whatever order they finish in. `eval_runs` stores
progress, the pinned ordered model
chain, retrieval configuration, full report, history, and one baseline per
program. Older runs may also carry a legacy direct-backup snapshot; ZDR-only
runs have none.
Only one run per program may be queued/running. Missing `eval_runs` DDL returns a
setup state and leaves question editing available; it never moves the model work
into the HTTP request. Completed configuration snapshots include a hash of the
exact scored question definitions, so the UI hides baseline deltas after the
question set or pipeline configuration changes. Each run freezes its question
definitions at queue time, uses its run UUID as pg-boss's time-windowed
singleton key, and keeps a private lease token plus broker job ID in
`configuration` so an expired worker cannot overwrite a retry or be fenced by
an unrelated duplicate job. Worker startup, a one-minute worker loop, and
run-list reads reconcile any queued row left by an API crash between durable
insert and queue send. Runs are capped at 250 questions and a super user can
cancel queued/running work; a running worker starts no new question once its
next lease-guarded progress write is rejected, lets the questions already in
flight finish, and stops without a report.

Scoring contract:
- **In-KB** (has `expected_doc_id`, `expected_answer_contains` or `expected_answer`): pass iff not refused AND (if `expected_doc_id` is set) the cited chunks resolve to that doc AND every phrase in `expected_answer_contains` appears in the answer (case-insensitive substring) AND (if `expected_answer` is set) the correctness judge grades the answer "correct". A failed grading call fails the question.
- **Out-of-KB** (none of the three set): pass iff refused.

Exit code: non-zero if any question fails. Useful as a future CI gate.

Citation matching uses stable `documents.id` from the already authorized retrieval rows, not chunk ids — chunk ids change on re-ingest, and a second post-generation lookup can race that change.

## Protected (held-out) questions (2026-07-11)

`eval_questions.is_protected` marks a held-out control set that is **never used
to tune** thresholds, prompts, or models. A gap between the protected and open
pass rates is evidence the pipeline was tuned to the questions it was measured
on (overfitting). This is orthogonal to the durable **baseline** (`eval_runs.is_baseline`,
pinned per program via `/admin/evaluations`) — the baseline detects "did the
numbers move"; protected questions detect "did we cheat to move them."

- The runner reports `summary.splits.protected` and `summary.splits.open`
  (`{ total, passed, passRatePct }`) on every run; the admin Evaluation page
  shows a "Held-out split" line once any protected question exists. Older runs
  recorded before the column omit `splits`.
- `is_protected` is read via a **tolerant raw query** (not the drizzle table),
  so the column needs no Drizzle binding in `lib/db/src/schema.ts`. Missing
  column ⇒ every question is unprotected (pre-DDL deployments still run).
- **Policy (enforced by review, not code):** never edit a protected question,
  and never use it to tune. Investigate protected failures on the open set.
  Aim for ~30–40% protected, weighted toward exact-value questions (fees,
  dates, policy numbers) and out-of-KB refusal cases. The UI does not block
  editing a held-out question; the policy still applies.

The column ships as `lib/db/sql/0002_eval_questions_is_protected.sql`, applied to Railway production on 2026-10-08 with `scripts/railway-apply-sql.mjs`. No question was protected when it was applied; the admin page shows the held-out split line only once at least one is.

Mark questions held-out in the UI: the "Held-out question" checkbox in the question form, or `held_out` = `true` in a CSV import. Held-out questions carry a "Held-out" chip in the question list. Raw SQL still works for marking many owner-selected ids at once:

```sql
UPDATE eval_questions SET is_protected = true WHERE id IN ('<uuid>', '<uuid>', ...);
```

To freeze a baseline: run the full suite, then pin the completed run in
`/admin/evaluations`. Do NOT create a separate baseline file — the DB baseline
already carries the config snapshot and question-set hash.

## Pitfalls

- Eval questions written by the developer who built the system are biased toward what the system handles well. Have an ops person or actual CSR write half the set.
- "Required phrases" matching is brittle for paraphrased answers. Prefer an expected answer, which the correctness judge grades so a paraphrase counts; keep phrases for exact values (fees, dates, policy numbers) that must appear verbatim. Faithfulness and correctness answer different questions: faithfulness checks claims against the excerpts, correctness checks the answer against the expected answer.
- Railway has only the production environment, so eval always runs against production. Scope it to the demo program (`--program 00000000-0000-0000-0000-0000000000aa`), whose documents are known, and keep runs small (`--limit`): each run is slow and burns tokens.
- Each question burns embedding + generation tokens (~$0.001 at current pricing), plus rerank and any judge calls ("What a run costs"). Don't run in a loop without a reason.
- Latency in a run includes queueing on shared provider pools with three questions in flight; compare latency only between runs made at the same concurrency.
- The runner does NOT write to `query_log` — eval traffic is excluded from the live ops dashboard on purpose.
