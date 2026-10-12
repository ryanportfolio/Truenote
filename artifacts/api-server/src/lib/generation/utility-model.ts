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
  user: string;
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
}

export interface UtilityCompletionResult {
  /** The reply text, or null when the model returns nothing. */
  text: string | null;
  finishReason: string | null;
  /** Provider and model OpenRouter reports for the reply. */
  servedBy: string | null;
  servedModel: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  /** The model's reasoning text, when the provider returns it. */
  reasoning: string | null;
}

/**
 * The request fields besides the messages and provider pinning: temperature,
 * the route's reasoning fields and JSON mode. Exported so diagnostics log the
 * fields a call sends.
 */
export function utilityRequestFields(
  route: ApprovedModelRoute,
  json: boolean
): Record<string, unknown> {
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

/** runUtilityCompletion with the reply's metadata, for callers that log it. */
export async function runUtilityCompletionDetailed(
  input: UtilityCompletionInput,
  deps: UtilityCompletionDeps = {}
): Promise<UtilityCompletionResult> {
  const client = deps.client ?? getUtilityClient();
  const route = deps.route ?? UTILITY_MODEL_ROUTE;
  const protectedSystem = protectProviderText(input.system).text;
  const protectedUser = protectProviderText(input.user).text;

  const request = {
    model: route.model,
    messages: [
      { role: "system", content: protectedSystem },
      { role: "user", content: protectedUser }
    ]
  } satisfies OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

  const completion = await client.chat.completions.create(
    {
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
    },
    {
      timeout: input.timeoutMs,
      maxRetries: input.maxRetries,
      signal: input.signal
    }
  );

  // Read loosely: OpenRouter adds `provider` and `message.reasoning`, which
  // the SDK types lack.
  const reply = completion as unknown as OpenRouterCompletion;
  const choice = reply.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  const usage = reply.usage;
  return {
    text: text ? text : null,
    finishReason: stringOrNull(choice?.finish_reason),
    servedBy: stringOrNull(reply.provider),
    servedModel: stringOrNull(reply.model),
    promptTokens: numberOrNull(usage?.prompt_tokens),
    completionTokens: numberOrNull(usage?.completion_tokens),
    reasoningTokens: numberOrNull(usage?.completion_tokens_details?.reasoning_tokens),
    reasoning: stringOrNull(choice?.message?.reasoning)
  };
}

interface OpenRouterCompletion {
  model?: unknown;
  provider?: unknown;
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown; reasoning?: unknown };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown } | null;
  } | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
