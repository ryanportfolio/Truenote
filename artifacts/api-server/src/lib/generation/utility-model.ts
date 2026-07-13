import OpenAI from "openai";
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
 * no provider fallback. The utility route is not assumed to support
 * structured-output json_schema, so callers instruct the model to return a
 * bare JSON object in the prompt and parse it with parseJsonObject().
 */
export async function runUtilityCompletion(
  input: UtilityCompletionInput,
  deps: UtilityCompletionDeps = {}
): Promise<string | null> {
  const client = deps.client ?? getUtilityClient();
  const route = deps.route ?? UTILITY_MODEL_ROUTE;

  const request = {
    model: route.model,
    ...(route.reasoningEffort === "none"
      ? { temperature: 0 }
      : { reasoning_effort: route.reasoningEffort }),
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user }
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
 * Defensive JSON-object extraction for utility responses. Tolerates a ```json
 * fence or surrounding prose by slicing to the outermost braces. Returns null
 * on any failure so callers fall back cleanly; the caller then validates the
 * shape with its own zod schema.
 */
export function parseJsonObject(text: string | null): unknown {
  if (!text) return null;
  let candidate = text.trim();
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) candidate = fence[1].trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
