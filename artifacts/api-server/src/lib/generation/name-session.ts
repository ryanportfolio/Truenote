import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { getDeadlineConfig } from "../deadlines.js";
import { recordAppError } from "../observability/error-log.js";

/**
 * Auto-name a chat session from its opening exchange.
 *
 * A CSR's session history is only browsable if each entry names its
 * subject. The opening question sets the subject for the overwhelming
 * majority of CSR lookups (follow-ups elaborate the same topic), so we
 * name once, from the first Q+A, rather than re-summarizing every turn.
 *
 * Same low-stakes/latency-sensitive posture as the follow-up rewriter:
 *   - gpt-4o-mini (a title is not worth gpt-4o).
 *   - Any failure falls back to a truncated question — naming is an
 *     enhancement, never a gate on answering.
 */
const NAME_MODEL = "gpt-4o-mini";

/** Hard cap on the stored title; the namer is told to stay well under it. */
export const MAX_TITLE_CHARS = 60;
const MAX_FIELD_CHARS = 500;

export const SessionNameSchema = z.object({
  title: z.string()
});

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
  client?: OpenAI;
}

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI();
  return _client;
}

const NAME_SYSTEM_PROMPT = [
  "You write a short title for a customer-service knowledge-base lookup.",
  "",
  "Rules:",
  "- 2 to 6 words. Title Case. No trailing punctuation.",
  "- Name the SUBJECT of the question, not the fact in the answer.",
  "- No quotes, no 'Question about', no filler. Just the topic.",
  '- Example: "What is the cancellation fee on the Basic plan?" -> "Basic Plan Cancellation Fee".'
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
    const client = deps.client ?? getClient();
    const context = input.answer
      ? `QUESTION: ${question.slice(0, MAX_FIELD_CHARS)}\n\nANSWER: ${input.answer.slice(0, MAX_FIELD_CHARS)}`
      : `QUESTION: ${question.slice(0, MAX_FIELD_CHARS)}`;
    const { nameSession: deadline } = getDeadlineConfig();
    const completion = await client.beta.chat.completions.parse(
      {
        model: NAME_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: NAME_SYSTEM_PROMPT },
          { role: "user", content: context }
        ],
        response_format: zodResponseFormat(SessionNameSchema, "session_name")
      },
      {
        timeout: deadline.timeoutMs,
        maxRetries: deadline.maxRetries
      }
    );
    const title = completion.choices[0]?.message.parsed?.title?.trim();
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
      provider: "openai-direct",
      model: NAME_MODEL,
      correlationId: input.diagnostics?.correlationId,
      userId: input.diagnostics?.userId,
      programId: input.diagnostics?.programId
    });
    return fallbackTitle(question);
  }
}
