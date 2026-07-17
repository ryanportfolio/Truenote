import OpenAI from "openai";
import { protectProviderText } from "../security/provider-input-firewall.js";
import {
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
 * Pinned to one approved route (Granite 4.1 8B on WandB's ZDR endpoint). These
 * calls are low-stakes and fail open in their callers (rewrite → raw question,
 * naming → truncated title), so a single pinned route with no fallback is
 * deliberate: a failure degrades to the caller's fallback, never to a
 * direct-provider call.
 */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const UTILITY_MODEL_ROUTE_ID: ApprovedModelRouteId = "granite-4.1-8b-wandb";

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
}

export interface UtilityCompletionDeps {
  /** Injected for tests. Defaults to the shared OpenRouter client. */
  client?: OpenAI;
  /** Override the pinned route (tests / reproducible runs). */
  route?: ApprovedModelRoute;
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
  const client = deps.client ?? getUtilityClient();
  const route = deps.route ?? UTILITY_MODEL_ROUTE;
  const protectedSystem = protectProviderText(input.system).text;
  const protectedUser = protectProviderText(input.user).text;

  const request = {
    model: route.model,
    ...(route.reasoningEffort === "none"
      ? { temperature: 0 }
      : { reasoning_effort: route.reasoningEffort }),
    messages: [
      { role: "system", content: protectedSystem },
      { role: "user", content: protectedUser }
    ]
  } satisfies OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

  const completion = await client.chat.completions.create(
    {
      ...request,
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

  const text = completion.choices[0]?.message.content?.trim();
  return text ? text : null;
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
