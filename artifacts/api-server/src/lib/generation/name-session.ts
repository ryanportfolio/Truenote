import type OpenAI from "openai";
import { getDeadlineConfig } from "../deadlines.js";
import { recordAppError } from "../observability/error-log.js";
import {
  runUtilityCompletion,
  stripWrappingQuotes,
  UTILITY_MODEL_ROUTE
} from "./utility-model.js";

/**
 * Auto-name a chat session from its opening exchange.
 *
 * A CSR's session history is only browsable if each entry names its
 * subject. The opening question sets the subject for the overwhelming
 * majority of CSR lookups (follow-ups elaborate the same topic), so we
 * name once, from the first Q+A, rather than re-summarizing every turn.
 *
 * Same low-stakes posture as the follow-up rewriter: routes through the
 * shared OpenRouter ZDR utility (Granite 4.1 8B), NOT direct OpenAI, so the
 * opening question and answer stay inside the product's Zero Data Retention
 * boundary. Any failure falls back to a truncated question — naming is an
 * enhancement, never a gate on answering.
 */

/** Hard cap on the stored title; the namer is told to stay well under it. */
export const MAX_TITLE_CHARS = 60;
const MAX_FIELD_CHARS = 500;

export interface NameSessionInput {
  question: string;
  /** The answer to the opening question, for subject context. Optional. */
  answer?: string;
  diagnostics?: {
    correlationId?: string;
    userId?: string;
    programId?: string;
  };
}

export interface NameSessionDeps {
  /** Injected for tests. Defaults to the shared OpenRouter ZDR utility client. */
  client?: OpenAI;
}

const NAME_SYSTEM_PROMPT = [
  "You write a short title for a customer-service knowledge-base lookup.",
  "",
  "Rules:",
  "- 2 to 6 words. Title Case. No trailing punctuation.",
  "- Name the SUBJECT of the question, not the fact in the answer.",
  "- No quotes, no 'Question about', no filler. Just the topic.",
  '- Example: "What is the cancellation fee on the Basic plan?" -> Basic Plan Cancellation Fee.',
  "",
  "Return ONLY the title as plain text — no quotes, no preamble, nothing else."
].join("\n");

/** Deterministic fallback: the question, trimmed to the title cap. */
export function fallbackTitle(question: string): string {
  const clean = question.trim().replace(/\s+/g, " ");
  if (clean.length <= MAX_TITLE_CHARS) return clean;
  return `${clean.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

export async function nameSession(
  input: NameSessionInput,
  deps: NameSessionDeps = {}
): Promise<string> {
  const question = input.question.trim();
  if (question.length === 0) return "New conversation";

  try {
    const context = input.answer
      ? `QUESTION: ${question.slice(0, MAX_FIELD_CHARS)}\n\nANSWER: ${input.answer.slice(0, MAX_FIELD_CHARS)}`
      : `QUESTION: ${question.slice(0, MAX_FIELD_CHARS)}`;
    const { nameSession: deadline } = getDeadlineConfig();
    const raw = await runUtilityCompletion(
      {
        system: NAME_SYSTEM_PROMPT,
        user: context,
        timeoutMs: deadline.timeoutMs,
        maxRetries: deadline.maxRetries
      },
      { client: deps.client }
    );
    const title = raw ? stripWrappingQuotes(raw) : "";
    if (!title) return fallbackTitle(question);
    // Guard against a chatty model blowing the column cap.
    return title.length > MAX_TITLE_CHARS ? fallbackTitle(question) : title;
  } catch (err) {
    console.warn(
      "[name-session] auto-name failed; using the question as the title:",
      err instanceof Error ? err.message : err
    );
    void recordAppError({
      severity: "warning",
      source: "generation",
      operation: "session-name-model",
      error: err,
      provider: UTILITY_MODEL_ROUTE.provider,
      model: UTILITY_MODEL_ROUTE.model,
      correlationId: input.diagnostics?.correlationId,
      userId: input.diagnostics?.userId,
      programId: input.diagnostics?.programId
    });
    return fallbackTitle(question);
  }
}
