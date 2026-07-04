import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

/**
 * Conversation-aware query rewriting (multi-turn RAG, 2026-07).
 *
 * CSRs ask follow-ups mid-call: "what about the premium plan?" retrieves
 * nothing useful on its own — the referent lives in the previous turn. This
 * step rewrites a follow-up into a standalone question BEFORE retrieval.
 *
 * Contract boundaries (these protect the product non-negotiables):
 *   - The conversation history is used ONLY here, for reference resolution.
 *     Answer generation still sees excerpts + the standalone question — an
 *     ungrounded fact from a previous answer can never leak into a new one.
 *   - First turn (no history) is a passthrough: zero extra latency or cost.
 *   - Any rewrite failure falls back to the original question — the rewrite
 *     is an enhancement, never a gate.
 *
 * gpt-4o-mini: rewriting is low-stakes (worst case equals sending the raw
 * follow-up to retrieval) and latency-sensitive (CSR is mid-call).
 */
const REWRITE_MODEL = "gpt-4o-mini";

/** Most recent exchanges to give the rewriter. More adds cost, not accuracy. */
const MAX_HISTORY_TURNS = 3;
/** Per-field cap; answers can be long and the rewriter only needs referents. */
const MAX_FIELD_CHARS = 500;

export const RewriteSchema = z.object({
  standalone_question: z.string()
});

export interface HistoryTurn {
  question: string;
  answer: string;
}

export interface RewriteInput {
  question: string;
  history: HistoryTurn[];
}

export interface RewriteResult {
  standaloneQuestion: string;
  llmCalled: boolean;
}

export interface RewriteDeps {
  client?: OpenAI;
}

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI();
  return _client;
}

const REWRITE_SYSTEM_PROMPT = [
  "You rewrite a customer-service follow-up question into a fully standalone",
  "search question.",
  "",
  "Rules:",
  "- Use the CONVERSATION only to resolve references (\"it\", \"that plan\",",
  "  \"the fee you mentioned\") in the FOLLOW-UP.",
  "- If the FOLLOW-UP is already standalone, return it unchanged.",
  "- Never answer the question. Never add facts, product names, or details",
  "  that appear in neither the FOLLOW-UP nor the CONVERSATION.",
  "- Keep the rewritten question short and searchable."
].join("\n");

export function formatHistory(history: HistoryTurn[]): string {
  return history
    .slice(-MAX_HISTORY_TURNS)
    .map(
      (t) =>
        `Q: ${t.question.slice(0, MAX_FIELD_CHARS)}\nA: ${t.answer.slice(0, MAX_FIELD_CHARS)}`
    )
    .join("\n\n");
}

export async function rewriteFollowUp(
  input: RewriteInput,
  deps: RewriteDeps = {}
): Promise<RewriteResult> {
  const question = input.question.trim();
  if (input.history.length === 0 || question.length === 0) {
    return { standaloneQuestion: question, llmCalled: false };
  }

  try {
    const client = deps.client ?? getClient();
    const completion = await client.beta.chat.completions.parse({
      model: REWRITE_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: REWRITE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `CONVERSATION:\n${formatHistory(input.history)}\n\nFOLLOW-UP: ${question}`
        }
      ],
      response_format: zodResponseFormat(RewriteSchema, "rewrite")
    });
    const rewritten = completion.choices[0]?.message.parsed?.standalone_question?.trim();
    if (!rewritten) {
      return { standaloneQuestion: question, llmCalled: true };
    }
    return { standaloneQuestion: rewritten, llmCalled: true };
  } catch (err) {
    console.warn(
      "[rewrite] follow-up rewrite failed; using the original question:",
      err instanceof Error ? err.message : err
    );
    return { standaloneQuestion: question, llmCalled: false };
  }
}
