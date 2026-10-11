# Auditor brief: eval-rework round 1 (S1 Judges)

You are an independent auditor in a fresh context. You did not write this work. Judge only from your own inspection and command runs. Do not edit any source file. Write only under /home/user/Truenote/.tmp/long-horizon/eval-rework/round-1/audit/.

Workspace root: /home/user/Truenote (git repo). Contract version: 1.

## The step
Move the eval faithfulness judge (artifacts/api-server/src/lib/eval/faithfulness.ts) off direct OpenAI onto OpenRouter with ZDR pinning, and add a new answer-correctness judge module artifacts/api-server/src/lib/eval/correctness.ts.

Required behavior (contract):
- Both judges construct their OpenAI SDK client with baseURL "https://openrouter.ai/api/v1" and apiKey process.env.OPENROUTER_API_KEY (lazily, once), and accept an injected client for tests.
- Both send model "openai/gpt-6.1-sol", reasoning_effort "medium", and provider {only:["azure"], zdr:true, data_collection:"deny", allow_fallbacks:false}.
- Both run every prompt text (excerpts/answer, or question/expected/answer) through protectProviderText before building the prompt.
- Faithfulness keeps its structured-output schema and scoring (scoreClaims unchanged in behavior).
- Correctness exports `judgeAnswerCorrectness(input: { question: string; expectedAnswer: string; answer: string }, deps?: { client?: OpenAI }): Promise<{ verdict: "correct" | "partial" | "incorrect"; reason: string }>`; the prompt says a paraphrase conveying the expected facts is correct, some but not all key facts is partial, a missing or contradicted key fact is incorrect; it throws when the reply has no valid verdict.
- No direct-OpenAI client (new OpenAI() without the OpenRouter baseURL) remains anywhere in artifacts/api-server/src/lib/eval.

Write scope: artifacts/api-server/src/lib/eval/faithfulness.ts, artifacts/api-server/src/lib/eval/correctness.ts, and existing test files under artifacts/api-server/src/lib/eval/__tests__/ only if the contract change broke them (no new test files).

Baseline: manifest /home/user/Truenote/.tmp/long-horizon/eval-rework/round-1/baseline.json, git ref refs/long-horizon/eval-rework/round-1.

## Procedure (in this order)
1. Rebuild the manifest and diff: `cd /home/user/Truenote && node .claude/skills/long-horizon/scripts/manifest.mjs . .tmp/long-horizon/eval-rework/round-1/audit/current.json --ref HEAD artifacts/api-server/src/lib/eval && node .claude/skills/long-horizon/scripts/manifest.mjs --diff .tmp/long-horizon/eval-rework/round-1/baseline.json .tmp/long-horizon/eval-rework/round-1/audit/current.json` and `git diff refs/long-horizon/eval-rework/round-1 --stat`. Also `git status --short` to catch files outside the manifest paths. Every added/modified/deleted path must be inside the write scope.
2. Done-check (run yourself, cwd /home/user/Truenote/artifacts/api-server):
   a. `npx tsc -p tsconfig.json --noEmit` → exit 0.
   b. `npx vitest run src/lib/eval` → all pass; then `npx vitest run` → all pass.
   c. Write a scratch script under the audit dir (e.g. check.mts) that imports judgeFaithfulness and judgeAnswerCorrectness from the source files, passes a stub client capturing the request body for both `client.beta.chat.completions.parse` and `client.chat.completions.create` (support whichever the code calls) and returning a minimal valid reply, and prints the captured bodies. Run it with `npx tsx <path>` from artifacts/api-server (rename to .mts if tsx complains about top-level await). Confirm model, reasoning_effort, provider fields exactly as required, and that a stub reply with an invalid verdict makes judgeAnswerCorrectness throw.
   d. Read both source files: confirm baseURL/apiKey client construction, protectProviderText on every prompt text, prompt wording for the correctness rubric, and `grep -rn "new OpenAI" artifacts/api-server/src/lib/eval` shows no client without the OpenRouter baseURL.
3. Report three verdicts with evidence: status complete/incomplete/blocked (incomplete adds repairable yes/no with your own diagnostic; a broken check = blocked: invalid check); integrity clean/suspect/violation; contract aligned/drifted (version 1, the requirements above). Save your report to the audit dir as report.md and return it.
