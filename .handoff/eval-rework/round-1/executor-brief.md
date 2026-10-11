# Executor brief: eval-rework round 1 (S1 Judges)

You are an executor in a fresh context working in /home/user/Truenote (TypeScript monorepo; api-server is Express + OpenAI SDK pointed at OpenRouter). Do this one step, verify it, and report what you changed and how to check it. Do not commit.

## Step
1. artifacts/api-server/src/lib/eval/faithfulness.ts currently calls direct OpenAI (`new OpenAI()`, model "gpt-6.1-sol", `client.beta.chat.completions.parse` with zodResponseFormat). Move it to OpenRouter with ZDR pinning:
   - Lazily construct one client: `new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" })`. Keep the injectable `deps.client`.
   - model "openai/gpt-6.1-sol", reasoning_effort "medium", and add `provider: { only: ["azure"], zdr: true, data_collection: "deny", allow_fallbacks: false }` to the request body (OpenRouter-only field; cast the body the way artifacts/api-server/src/lib/generation/utility-model.ts does). Keep the structured output (zodResponseFormat) and scoreClaims behavior. Keep protectProviderText on excerpts and answer. Update the file's header comment: it now runs on OpenRouter's ZDR-pinned Azure endpoint for the same model (OpenRouter lists openai/gpt-6.1-sol on Azure in its ZDR index, with response_format/structured_outputs supported, checked 2026-10-11), so judge text stays inside the same ZDR boundary as answers; scores stay comparable because the model is the same.
2. Create artifacts/api-server/src/lib/eval/correctness.ts exporting
   `judgeAnswerCorrectness(input: { question: string; expectedAnswer: string; answer: string }, deps: { client?: OpenAI } = {}): Promise<{ verdict: "correct" | "partial" | "incorrect"; reason: string }>`
   - Same client construction and request routing as the faithfulness judge (share a small helper only if it stays inside these two files; e.g. export the client getter and provider block from faithfulness.ts, or duplicate the few lines).
   - Structured output via zodResponseFormat with a schema { verdict: enum, reason: string }.
   - All three texts through protectProviderText (artifacts/api-server/src/lib/security/provider-input-firewall.js).
   - System prompt: grade whether the ANSWER conveys the EXPECTED ANSWER for the QUESTION; a paraphrase that conveys the expected key facts is "correct"; some but not all key facts is "partial"; a missing or contradicted key fact, or a refusal, is "incorrect"; extra correct detail does not lower the grade; reason is one short sentence naming what is missing or wrong.
   - Use the same deadline config the faithfulness judge uses (getDeadlineConfig().faithfulness) for timeout/maxRetries.
   - Throw an Error when the parsed reply is missing.
3. No other file changes, except existing tests under artifacts/api-server/src/lib/eval/__tests__/ if your change breaks them (do not add new test files: repo rule).

Write scope: artifacts/api-server/src/lib/eval/faithfulness.ts, artifacts/api-server/src/lib/eval/correctness.ts, existing files in artifacts/api-server/src/lib/eval/__tests__/.

## Verify before reporting (cwd artifacts/api-server)
- `npx tsc -p tsconfig.json --noEmit` exits 0.
- `npx vitest run` all pass.
- A scratch stub-client script (put it under /home/user/Truenote/.tmp/long-horizon/eval-rework/round-1/exec/, run with `npx tsx`, use a .mts extension) showing both request bodies.

## Rules
- Never run pnpm/npm install. No new dependencies. No model identifiers in comments beyond the model id string the code needs.
- If you start a long-lived process, append "pid port command" to /home/user/Truenote/.tmp/long-horizon/eval-rework/processes.log and stop it before you finish.
- Report: files changed, what each change does, commands run with results.
