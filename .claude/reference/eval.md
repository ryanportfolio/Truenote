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
- **Claim-level faithfulness (2026-07, `--judge`)**: gpt-4o judge decomposes each non-refused answer into atomic factual claims and labels each supported/unsupported against the excerpts the LLM saw (Cohere RAG-eval methodology). `meanFaithfulnessPct`, `unfaithfulQuestions`, `judgeFailures`, and per-question `unsupportedClaims` keep partial judge outages visible instead of presenting a partial mean as suite-wide. Catches what phrase-matching can't: a *passing*, well-cited answer with one invented fee — the CLI lists "passing answer(s) with unsupported claims" separately. One extra gpt-4o call per judged question → opt-in flag. Out-of-KB questions that wrongly got answers ARE judged (prime hallucination candidates).
- **Generation path**: per-question `generationPath` plus `fallbackGenerationCount` / `failedFallbackCount` show when the configured primary degraded to a later ZDR route or every approved route failed.

## Authoring eval questions

The eval set is only as good as its questions. Bias toward:
- Real questions CSRs actually ask (pull from past tickets/chat logs).
- Edge cases the KB *should* handle (multi-doc answers, recent policy changes).
- A small number of intentional out-of-KB questions to verify refusal.

50 questions is a useful floor. 200+ is when you can publish confidence intervals.

## Running the harness

```bash
# Replit (or any env with secrets loaded):
pnpm --filter @workspace/scripts run eval

# Filter to one program:
pnpm --filter @workspace/scripts run eval -- --program <uuid>

# Single question (debugging a regression):
pnpm --filter @workspace/scripts run eval -- --question <uuid>

# Smoke test (first 5 questions):
pnpm --filter @workspace/scripts run eval -- --limit 5

# Machine-readable output (suppresses the human summary):
pnpm --filter @workspace/scripts run eval -- --json > .tmp/eval-result.json

# Claim-level faithfulness judge (extra gpt-4o call per non-refused answer):
pnpm --filter @workspace/scripts run eval -- --judge

# Parameter sweep without touching Replit Secrets (run-scoped env overrides):
pnpm --filter @workspace/scripts run eval -- --threshold 0.25 --top-k 12
pnpm --filter @workspace/scripts run eval -- --rerank-model rerank-v3.5 --threshold 0.2
pnpm --filter @workspace/scripts run eval -- --neighbors 0   # A/B neighbor expansion
```

Implementation: `artifacts/api-server/src/lib/eval/runner.ts` is the pure runner — loads questions, calls `retrieve()` + `generateAnswer()` directly (skips HTTP/auth so eval doesn't pollute `query_log`), scores each result. `scripts/src/eval.ts` is the CLI wrapper.

The super-user `/admin/evaluations` surface manages program-scoped questions and
queues durable runs through pg-boss. Runs execute in the existing worker, one
question at a time, while `eval_runs` stores progress, the pinned ordered model
chain, direct backup, retrieval configuration, full report, history, and one
baseline per program.
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

## Pitfalls

- Eval questions written by the developer who built the system are biased toward what the system handles well. Have an ops person or actual CSR write half the set.
- "Required phrases" matching is brittle for paraphrased answers. Pair it with an LLM-judge fallback (cheap `gpt-4o` call: "does this answer convey {expected}?") for higher-fidelity scoring on a sample.
- Don't run eval against production traffic — it's slow and burns tokens. Run against a fixture program with known docs.
- Each question burns embedding + generation tokens (~$0.001 at current pricing). Don't run in a loop without a reason.
- The runner does NOT write to `query_log` — eval traffic is excluded from the live ops dashboard on purpose.
