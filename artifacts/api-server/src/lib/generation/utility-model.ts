import OpenAI from "openai";
import { protectProviderText } from "../security/provider-input-firewall.js";
import {
  reasoningRequestFields,
  resolveApprovedModelRoute,
  type ApprovedModelRoute,
  type ApprovedModelRouteId
} from "./model-routing.js";

/**
 * Auxiliary LLM calls (follow-up rewrite, session naming) route through the
 * same OpenRouter Zero Data Retention boundary as answer generation, instead
 * of hitting OpenAI directly. This keeps CSR questions and knowledge-base
 * answer snippets inside the ZDR posture the product enforces on the answer
 * itself — no auxiliary call quietly ships that content to a provider whose
 * retention policy is not pinned here.
 *
 * Pinned to one approved route (Mercury 2.5 on Inception's ZDR endpoint). The
 * rewrite runs before retrieval under a 5 s deadline, so the utility route is
 * the fastest approved model, a diffusion LLM at low reasoning effort. These
 * calls are low-stakes and fail open in their callers (rewrite → raw question,
 * naming → truncated title), so a single pinned route with no fallback is
 * deliberate: a failure degrades to the caller's fallback, never to a
 * direct-provider call.
 */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const UTILITY_MODEL_ROUTE_ID: ApprovedModelRouteId = "mercury-2.5-inception";

/** The pinned ZDR route for auxiliary utility calls. */
export const UTILITY_MODEL_ROUTE: ApprovedModelRoute =
  resolveApprovedModelRoute(UTILITY_MODEL_ROUTE_ID);

let _client: OpenAI | null = null;
function getUtilityClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL
    });
  }
  return _client;
}

export interface UtilityCompletionInput {
  system: string;
  /** One user message, or several sent in order. */
  user: string | readonly string[];
  /** Per-call bound; a slow provider hits this and the caller falls back. */
  timeoutMs: number;
  maxRetries: number;
  /** Cancels the in-flight call (client disconnect or overall ask deadline). */
  signal?: AbortSignal;
  /**
   * Ask for a JSON object reply (`response_format: json_object`). Sent only
   * when the route's endpoint supports it (route.jsonMode).
   */
  json?: boolean;
}

export interface UtilityCompletionDeps {
  /** Injected for tests. Defaults to the shared OpenRouter client. */
  client?: OpenAI;
  /** Override the pinned route (tests / reproducible runs). */
  route?: ApprovedModelRoute;
  /**
   * Called with the exact request body just before it is sent, so a caller
   * can log what a failed call sent. Must not change the body.
   */
  onRequest?: (body: Readonly<Record<string, unknown>>) => void;
}

export interface UtilityCompletionResult {
  /** The reply text, or null when the model returns nothing. */
  text: string | null;
  finishReason: string | null;
  /** OpenRouter's generation id (`gen-...`), for its activity log. */
  generationId: string | null;
  /** Prompt tokens the provider counted. */
  promptTokens: number | null;
  /**
   * The model's reasoning text when the provider returns it: `reasoning`,
   * else the text of `reasoning_details`.
   */
  reasoning: string | null;
  /** The complete response body as returned, for diagnostics. */
  raw: unknown;
}

/**
 * The request fields besides the messages and provider pinning: temperature,
 * the route's reasoning fields and JSON mode.
 */
function utilityRequestFields(route: ApprovedModelRoute, json: boolean): Record<string, unknown> {
  return {
    ...(route.reasoningEffort === "none" ? { temperature: 0 } : {}),
    // OpenRouter-only shape (efforts "none" and "xhigh", or the reasoning
    // switch), which the OpenAI SDK types lack.
    ...reasoningRequestFields(route),
    ...(json && route.jsonMode ? { response_format: { type: "json_object" } } : {})
  };
}

/**
 * Run a single pinned-ZDR-route chat completion and return the raw message
 * text (null when the model returns nothing). Mirrors the provider block in
 * generateAnswer(): one pinned provider, ZDR required, data collection denied,
 * no provider fallback. Utility callers ask for a single plain-text value (a
 * question, a title) and use the text directly — the answer path dropped
 * structured output because enforced JSON errored on ZDR providers, and small
 * models botch it. Use stripWrappingQuotes() to clean the returned text.
 */
export async function runUtilityCompletion(
  input: UtilityCompletionInput,
  deps: UtilityCompletionDeps = {}
): Promise<string | null> {
  return (await runUtilityCompletionDetailed(input, deps)).text;
}

/** runUtilityCompletion with the whole reply, for callers that log it. */
export async function runUtilityCompletionDetailed(
  input: UtilityCompletionInput,
  deps: UtilityCompletionDeps = {}
): Promise<UtilityCompletionResult> {
  const client = deps.client ?? getUtilityClient();
  const route = deps.route ?? UTILITY_MODEL_ROUTE;
  const protectedSystem = protectProviderText(input.system).text;
  const userMessages = typeof input.user === "string" ? [input.user] : input.user;

  const request = {
    model: route.model,
    messages: [
      { role: "system" as const, content: protectedSystem },
      ...userMessages.map((message) => ({
        role: "user" as const,
        content: protectProviderText(message).text
      }))
    ]
  } satisfies OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

  const body = {
    ...request,
    ...utilityRequestFields(route, input.json === true),
    provider: {
      only: [route.provider],
      zdr: true,
      data_collection: "deny",
      allow_fallbacks: false
    }
  } as typeof request & {
    provider: {
      only: string[];
      zdr: boolean;
      data_collection: "deny";
      allow_fallbacks: boolean;
    };
  };
  deps.onRequest?.(body);
  const completion = await client.chat.completions.create(body, {
    timeout: input.timeoutMs,
    maxRetries: input.maxRetries,
    signal: input.signal
  });

  // Read loosely: OpenRouter adds `message.reasoning` and
  // `reasoning_details`, which the SDK types lack.
  const reply = completion as unknown as OpenRouterCompletion;
  const choice = reply.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  return {
    text: text ? text : null,
    finishReason: stringOrNull(choice?.finish_reason),
    generationId: stringOrNull(reply.id),
    promptTokens:
      typeof reply.usage?.prompt_tokens === "number" ? reply.usage.prompt_tokens : null,
    reasoning: stringOrNull(choice?.message?.reasoning) ?? reasoningDetailsText(choice?.message?.reasoning_details),
    raw: completion
  };
}

interface OpenRouterCompletion {
  id?: unknown;
  usage?: { prompt_tokens?: unknown } | null;
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown; reasoning?: unknown; reasoning_details?: unknown };
  }>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The text and summary parts of OpenRouter's `reasoning_details`, joined. */
function reasoningDetailsText(details: unknown): string | null {
  if (!Array.isArray(details)) return null;
  const parts = details.flatMap((detail) => {
    const record = detail as { text?: unknown; summary?: unknown } | null;
    return [record?.text, record?.summary].filter(
      (part): part is string => typeof part === "string" && part.trim() !== ""
    );
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Strip a matching pair of wrapping quotes a model may add around a plain-text
 * value. Matters for the rewrite: a quoted question would otherwise become a
 * BM25 phrase search. Returns the trimmed text unchanged when it is not quoted.
 */
export function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^["'`“”]([\s\S]*)["'`“”]$/);
  return match?.[1] !== undefined ? match[1].trim() : trimmed;
}
