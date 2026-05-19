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
- Weekly on a cron, results pinned to an admin dashboard.
- Before the pitch demo. Walk into the room with a number.

## Pitch-ready metrics

Report these on the admin Evaluation page:

- **Answer accuracy**: % of questions where required phrases all appear in the answer.
- **Citation accuracy**: % of questions where the cited chunk is from the expected doc.
- **Refusal rate on in-KB questions**: should be low (false negatives are bad).
- **Refusal rate on out-of-KB questions**: should be high (false positives = hallucination).
- **p50 / p95 latency**: CSRs are mid-call. Slow = unusable.

## Authoring eval questions

The eval set is only as good as its questions. Bias toward:
- Real questions CSRs actually ask (pull from past tickets/chat logs).
- Edge cases the KB *should* handle (multi-doc answers, recent policy changes).
- A small number of intentional out-of-KB questions to verify refusal.

50 questions is a useful floor. 200+ is when you can publish confidence intervals.

## Pitfalls

- Eval questions written by the developer who built the system are biased toward what the system handles well. Have an ops person or actual CSR write half the set.
- "Required phrases" matching is brittle for paraphrased answers. Pair it with an LLM-judge fallback (cheap `gpt-4o` call: "does this answer convey {expected}?") for higher-fidelity scoring on a sample.
- Don't run eval against production traffic — it's slow and burns tokens. Run against a fixture program with known docs.
