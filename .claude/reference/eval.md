# Eval Harness

> The eval suite is how you prove (to yourself and to leadership) that retrieval works. Treat it as first-class — not a nice-to-have.

## What it does

For each question in `eval_questions`:
1. Run the full query pipeline (embed → hybrid search → rerank → LLM).
2. Check: did the cited chunk(s) come from `expected_doc_id`?
3. Check: does the answer contain every phrase in `expected_answer_contains`?
4. Record refusal rate, latency, citation accuracy.

Output: a JSON summary + a per-question breakdown.

## When to run

- Before any PR that touches `ingestion/`, `retrieval/`, the LLM system prompt, or chunk/embedding logic.
- Weekly from the super-user Evaluation Center; pin a trusted completed run as the baseline.
- Before the pitch demo. Walk into the room with a number.

## Pitch-ready metrics

Report these on the admin Evaluation page:

- **Answer accuracy**: % of questions where required phrases all appear in the answer.
- **Citation accuracy**: % of questions where the cited chunk is from the expected doc.
- **Refusal rate on in-KB questions**: should be low (false negatives are bad).
- **Refusal rate on out-of-KB questions**: should be high (false positives = hallucination).
- **p50 / p95 latency**: CSRs are mid-call. Slow = unusable.
- **Stage-level recall (2026-07)**: for questions with `expected_doc_id` — `retrievalRecallPct` (doc entered the pre-rerank candidate pool) and `rerankRecallPct` (doc survived into the top-K). Plus `inKbFailuresByStage` attributing each in-KB failure to `retrieval` / `rerank` / `threshold` / `generation` (`unattributed` = no expected_doc_id or errored). This tells you WHICH stage to tune: retrieval misses → chunking/embedding/query work; rerank misses → candidate K or rerank model; threshold pile-up → retune `RERANK_CONFIDENCE_THRESHOLD` (especially after a `COHERE_RERANK_MODEL` change); generation misses → prompt/model work.
- **Expected-doc rank (2026-07)**: `expectedDocRank` per question (1-based, in the post-rerank top-K) + `expectedDocRankMean`. A doc that passes at rank 7-of-8 is one rerank-model change away from a miss.
- **Claim-level faithfulness (2026-07, `--judge`)**: gpt-6.1-sol judge (direct OpenAI, medium reasoning; gpt-4o before 2026-10-07, so older judge scores are not comparable) decomposes each non-refused answer into atomic factual claims and labels each supported/unsupported against the excerpts the LLM saw (Cohere RAG-eval methodology). `meanFaithfulnessPct`, `unfaithfulQuestions`, `judgeFailures`, and per-question `unsupportedClaims` keep partial judge outages visible instead of presenting a partial mean as suite-wide. Catches what phrase-matching can't: a *passing*, well-cited answer with one invented fee — the CLI lists "passing answer(s) with unsupported claims" separately. One extra gpt-6.1-sol call per judged question → opt-in flag. Out-of-KB questions that wrongly got answers ARE judged (prime hallucination candidates).
- **Generation path**: per-question `generationPath` plus `fallbackGenerationCount` / `failedFallbackCount` show when the configured primary degraded to a later ZDR route or every approved route failed.

## Authoring eval questions

The eval set is only as good as its questions. Bias toward:
- Real questions CSRs actually ask (pull from past tickets/chat logs).
- Edge cases the KB *should* handle (multi-doc answers, recent policy changes).
- A small number of intentional out-of-KB questions to verify refusal.

50 questions is a useful floor. 200+ is when you can publish confidence intervals.

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
--judge                 claim-level faithfulness judge (extra gpt-6.1-sol call per non-refused answer)
--threshold 0.25 --top-k 12 --candidate-k 40      run-scoped overrides; Railway variables stay untouched
--rerank-model rerank-v4.0-pro --threshold 0.2     rerank model trial; retune the threshold with it
--neighbors 0                                      A/B neighbor expansion
```

Implementation: `artifacts/api-server/src/lib/eval/runner.ts` is the pure runner — loads questions, calls `retrieve()` + `generateAnswer()` directly (skips HTTP/auth so eval doesn't pollute `query_log`), scores each result. `scripts/src/eval.ts` is the CLI wrapper.

The super-user `/admin/evaluations` surface manages program-scoped questions and
queues durable runs through pg-boss. Runs execute in the existing worker, one
question at a time, while `eval_runs` stores progress, the pinned ordered model
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
cancel queued/running work; a running worker stops after its current question
when its next lease-guarded progress write is rejected.

Scoring contract:
- **In-KB** (has `expected_doc_id` OR `expected_answer_contains`): pass iff not refused AND (if `expected_doc_id` is set) the cited chunks resolve to that doc AND every phrase in `expected_answer_contains` appears in the answer (case-insensitive substring).
- **Out-of-KB** (neither set): pass iff refused.

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
  dates, policy numbers) and out-of-KB refusal cases.

The column ships as `lib/db/sql/0002_eval_questions_is_protected.sql`, applied to Railway production on 2026-10-08 with `scripts/railway-apply-sql.mjs`. No question is protected yet, so `splits.protected` has 0 questions and the admin page shows no held-out split line until some are marked.

Mark questions protected with raw SQL and owner-selected ids (there is no UI toggle yet):

```sql
UPDATE eval_questions SET is_protected = true WHERE id IN ('<uuid>', '<uuid>', ...);
```

To freeze a baseline: run the full suite, then pin the completed run in
`/admin/evaluations`. Do NOT create a separate baseline file — the DB baseline
already carries the config snapshot and question-set hash.

## Pitfalls

- Eval questions written by the developer who built the system are biased toward what the system handles well. Have an ops person or actual CSR write half the set.
- "Required phrases" matching is brittle for paraphrased answers. Pair it with an LLM-judge check ("does this answer convey {expected}?") for higher-fidelity scoring on a sample. Not built yet: `--judge` (gpt-6.1-sol) scores faithfulness to the excerpts, not agreement with the expected answer.
- Railway has only the production environment, so eval always runs against production. Scope it to the demo program (`--program 00000000-0000-0000-0000-0000000000aa`), whose documents are known, and keep runs small (`--limit`): each run is slow and burns tokens.
- Each question burns embedding + generation tokens (~$0.001 at current pricing). Don't run in a loop without a reason.
- The runner does NOT write to `query_log` — eval traffic is excluded from the live ops dashboard on purpose.
