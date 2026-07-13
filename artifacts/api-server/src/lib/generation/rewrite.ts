import type OpenAI from "openai";
import { getDeadlineConfig, isAbortError } from "../deadlines.js";
import { recordAppError } from "../observability/error-log.js";
import {
  runUtilityCompletion,
  stripWrappingQuotes,
  UTILITY_MODEL_ROUTE
} from "./utility-model.js";

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
 * Routes through the shared OpenRouter ZDR utility (Granite 4.1 8B), NOT
 * direct OpenAI: the follow-up plus recent history stay inside the same
 * Zero Data Retention boundary the product enforces on answer generation.
 * Rewriting is low-stakes (worst case equals sending the raw follow-up to
 * retrieval), so a single pinned route with fail-open fallback is deliberate.
 */

/** Most recent exchanges to give the rewriter. More adds cost, not accuracy. */
const MAX_HISTORY_TURNS = 3;
/** Per-field cap; answers can be long and the rewriter only needs referents. */
const MAX_FIELD_CHARS = 500;

export interface HistoryTurn {
  question: string;
  answer: string;
}

export interface RewriteInput {
  question: string;
  history: HistoryTurn[];
  /** Cancels the in-flight rewrite (client disconnect or overall ask deadline). */
  signal?: AbortSignal;
  diagnostics?: {
    correlationId?: string;
    userId?: string;
    programId?: string;
  };
}

export interface RewriteResult {
  standaloneQuestion: string;
  llmCalled: boolean;
}

export interface RewriteDeps {
  /** Injected for tests. Defaults to the shared OpenRouter ZDR utility client. */
  client?: OpenAI;
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
  "- Keep the rewritten question short and searchable.",
  "",
  "Return ONLY the rewritten standalone question as plain text — no quotes,",
  "no preamble, no explanation, nothing else."
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
    const { rewrite } = getDeadlineConfig();
    const raw = await runUtilityCompletion(
      {
        system: REWRITE_SYSTEM_PROMPT,
        user: `CONVERSATION:\n${formatHistory(input.history)}\n\nFOLLOW-UP: ${question}`,
        timeoutMs: rewrite.timeoutMs,
        maxRetries: rewrite.maxRetries,
        signal: input.signal
      },
      { client: deps.client }
    );
    const rewritten = raw ? stripWrappingQuotes(raw) : "";
    if (!rewritten) {
      return { standaloneQuestion: question, llmCalled: true };
    }
    return { standaloneQuestion: rewritten, llmCalled: true };
  } catch (err) {
    // A cancelled request (client disconnect or overall ask deadline) is not a
    // rewrite failure to swallow — halt the pipeline instead of continuing to
    // retrieval with the raw question after the caller has already given up.
    if (isAbortError(err)) throw err;
    console.warn(
      "[rewrite] follow-up rewrite failed; using the original question:",
      err instanceof Error ? err.message : err
    );
    void recordAppError({
      severity: "warning",
      source: "generation",
      operation: "follow-up-rewrite",
      error: err,
      provider: UTILITY_MODEL_ROUTE.provider,
      model: UTILITY_MODEL_ROUTE.model,
      correlationId: input.diagnostics?.correlationId,
      userId: input.diagnostics?.userId,
      programId: input.diagnostics?.programId,
      context: { historyTurns: input.history.length }
    });
    return { standaloneQuestion: question, llmCalled: false };
  }
}
