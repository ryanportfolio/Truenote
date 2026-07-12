import OpenAI from "openai";
import type { RetrievalChunk } from "../retrieval/query.js";
import { getDeadlineConfig, isAbortError } from "../deadlines.js";
import {
  elapsedMs,
  type ProviderAttemptOutcome,
  type ProviderAttemptTiming,
  type ProviderTokenUsage
} from "../observability/pipeline-timing.js";
import { recordAppError } from "../observability/error-log.js";
import {
  getActiveModelChain,
  type ApprovedModelRoute
} from "./model-routing.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface Source {
  chunk_id: string;
  doc_title: string;
  excerpt: string;
}

export interface AnswerPayload {
  answer: string;
  sources: Source[];
  refused: boolean;
  confidence: "high" | "medium" | "low";
}

export type AnswerValidationFailureReason =
  | "empty_answer"
  | "missing_inline_citation"
  | "unknown_citation_ids";

export interface AnswerValidationFailure {
  reason: AnswerValidationFailureReason;
  inlineCitationIds: string[];
  recognizedCitationIds: string[];
  unknownCitationIds: string[];
  availableChunkIds: string[];
  returnedText: string;
}

export type AnswerValidationResult =
  | { payload: AnswerPayload; failure: null }
  | { payload: null; failure: AnswerValidationFailure };

/** Canned refusal copy, matching the system prompt verbatim. */
export const REFUSAL_TEXT =
  "I couldn't find this in the knowledge base. Please escalate or check the source documents directly.";

/**
 * Rules 1–7 of the system prompt from .claude/reference/retrieval.md →
 * Generation contract. Do not paraphrase the rule text — the wording is part
 * of the product contract and is tested against eval questions in Phase 2.
 *
 * The EXCERPTS and QUESTION blocks are the user message, built by
 * buildUserPrompt(). Keeping them out of the system prompt lets the prompt
 * cache across requests with different excerpts.
 */
export function buildSystemPrompt(programName: string): string {
  return [
    `You are a customer service knowledge assistant for ${programName}.`,
    "",
    "RULES (non-negotiable):",
    "1. ONLY use the EXCERPTS below. Do not use outside knowledge.",
    "2. If the answer is not fully supported by the excerpts, return exactly:",
    `   "${REFUSAL_TEXT}"`,
    "3. Never invent fees, dates, names, policy numbers, or procedures.",
    "4. Cite every factual claim by copying its short SOURCE token exactly.",
    "   Use forms like [S1] or [S2]; never copy or invent a UUID.",
    "5. Prefer the most recent document version when excerpts conflict.",
    "6. Format the answer as GitHub-flavored Markdown. Use numbered steps for",
    "   procedures, bullet lists for options, and **bold** for key values",
    "   (fees, dates, deadlines). Use a table only to compare options. Never",
    "   use headings, code blocks, images, links, or task lists.",
    "7. Return only the final Markdown answer or the exact refusal text.",
    "   Never return JSON, metadata, analysis, or a separate sources list."
  ].join("\n");
}

export function formatExcerpts(chunks: RetrievalChunk[]): string {
  return chunks
    .map((c, index) => {
      const title = c.docTitle ?? "Untitled";
      return `SOURCE [S${index + 1}] (doc: ${title})\n${c.content}`;
    })
    .join("\n\n---\n\n");
}

export function buildUserPrompt(question: string, chunks: RetrievalChunk[]): string {
  return `EXCERPTS:\n${formatExcerpts(chunks)}\n\nQUESTION: ${question}`;
}

export function cannedRefusal(): AnswerPayload {
  return {
    answer: REFUSAL_TEXT,
    sources: [],
    refused: true,
    confidence: "low"
  };
}

let _primaryClient: OpenAI | null = null;
function getPrimaryClient(): OpenAI {
  if (!_primaryClient) {
    _primaryClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL
    });
  }
  return _primaryClient;
}

export interface GenerateAnswerInput {
  programName: string;
  question: string;
  chunks: RetrievalChunk[];
  /** When retrieval returned refused=true, skip the LLM call entirely. */
  refusedByRetrieval?: boolean;
  /** Cancels in-flight generation and halts the route chain (client disconnect or overall ask deadline). */
  signal?: AbortSignal;
  /** Request identity for durable operator diagnostics. Never includes prompts or excerpts. */
  diagnostics?: {
    correlationId?: string;
    userId?: string;
    programId?: string;
  };
}

export interface GenerateAnswerResult {
  payload: AnswerPayload;
  llmCalled: boolean;
  generationPath: "retrieval-refusal" | "primary" | "fallback" | "fallback-failed";
  providerAttempts: ProviderAttemptTiming[];
}

export interface GenerateAnswerDeps {
  /** Primary generation client. Defaults to OpenRouter. */
  client?: OpenAI;
  /** Ordered approved-route chain override for tests (index 0 = primary).
   *  Production reads the persisted global order. */
  routeChain?: ApprovedModelRoute[];
  /** Pin one approved route for a reproducible evaluation run. */
  primaryRoute?: ApprovedModelRoute;
}

async function callGenerationModel(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: {
    openRouterProvider: string;
    reasoningEffort: "none" | "low" | "medium";
    /** Per-attempt bounds. A slow provider hits this and the chain advances to the next route. */
    timeoutMs: number;
    maxRetries: number;
    /** Cancels this attempt AND (via isAbortError in the caller) halts the whole chain. */
    signal?: AbortSignal;
  }
): Promise<{ text: string | null; usage: ProviderTokenUsage | null }> {
  const request = {
    model,
    ...(options.reasoningEffort === "none"
      ? { temperature: 0 }
      : { reasoning_effort: options.reasoningEffort }),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  } satisfies OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

  // Every generation call stays inside OpenRouter's per-request ZDR boundary.
  // A provider without a matching ZDR endpoint is rejected before receiving
  // the prompt; there is deliberately no direct-provider escape hatch.
  const completion = await client.chat.completions.create(
    {
      ...request,
      provider: {
        only: [options.openRouterProvider],
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
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries,
      signal: options.signal
    }
  );

  const text = completion.choices[0]?.message.content?.trim();
  return { text: text ? text : null, usage: readTokenUsage(completion.usage) };
}

/** Map an OpenAI/OpenRouter usage block to our camelCase counts. Null when absent. */
function readTokenUsage(usage: unknown): ProviderTokenUsage | null {
  if (typeof usage !== "object" || usage === null) return null;
  const raw = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const out: ProviderTokenUsage = {};
  const prompt = count(raw.prompt_tokens);
  const completion = count(raw.completion_tokens);
  const total = count(raw.total_tokens);
  if (prompt !== undefined) out.promptTokens = prompt;
  if (completion !== undefined) out.completionTokens = completion;
  if (total !== undefined) out.totalTokens = total;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Build source metadata solely from inline citations and retrieved ground
 * truth. The model does not emit a duplicate sources array. A rejected primary
 * answer is a provider failure for routing purposes and advances to the next
 * approved ZDR route.
 */
export function validateGeneratedAnswer(
  returnedText: string,
  chunks: RetrievalChunk[]
): AnswerValidationResult {
  const answer = returnedText.trim();
  if (answer === REFUSAL_TEXT) return { payload: cannedRefusal(), failure: null };

  const availableChunkIds = chunks.map((chunk) => chunk.id);
  const availableIds = new Set(availableChunkIds);
  const { normalizedAnswer, inlineCitationIds } = normalizeInlineCitations(
    answer,
    chunks
  );
  const recognizedCitationIds = inlineCitationIds.filter((id) => availableIds.has(id));
  const unknownCitationIds = inlineCitationIds.filter((id) => !availableIds.has(id));
  const failureBase = {
    inlineCitationIds,
    recognizedCitationIds,
    unknownCitationIds,
    availableChunkIds,
    returnedText
  };

  if (answer.length === 0) {
    return { payload: null, failure: { reason: "empty_answer", ...failureBase } };
  }
  if (inlineCitationIds.length === 0) {
    return {
      payload: null,
      failure: { reason: "missing_inline_citation", ...failureBase }
    };
  }
  if (unknownCitationIds.length > 0) {
    return {
      payload: null,
      failure: { reason: "unknown_citation_ids", ...failureBase }
    };
  }

  return {
    payload: {
      answer: normalizedAnswer,
      sources: buildSources(recognizedCitationIds, chunks),
      refused: false,
      confidence: "medium"
    },
    failure: null
  };
}

function normalizeInlineCitations(
  answer: string,
  chunks: RetrievalChunk[]
): {
  normalizedAnswer: string;
  inlineCitationIds: string[];
} {
  const ids: string[] = [];
  const seen = new Set<string>();
  const aliases = new Map<string, string>(
    chunks.map((chunk, index) => [`s${index + 1}`, chunk.id])
  );
  const normalizedAnswer = answer.replace(
    /\[([^\[\]\r\n]+)\]|【([^【】\r\n]+)】/g,
    (original, squareContent: string | undefined, wideContent: string | undefined) => {
      const raw = (squareContent ?? wideContent ?? "").trim();
      const token = raw.replace(/^chunk_id\s*:\s*/i, "").trim();
      if (!token) return original;
      const resolvedId = aliases.get(token.toLowerCase()) ?? token;
      if (!seen.has(resolvedId)) {
        seen.add(resolvedId);
        ids.push(resolvedId);
      }
      return `[${resolvedId}]`;
    }
  );
  return { normalizedAnswer, inlineCitationIds: ids };
}

export async function generateAnswer(
  input: GenerateAnswerInput,
  deps: GenerateAnswerDeps = {}
): Promise<GenerateAnswerResult> {
  if (input.refusedByRetrieval || input.chunks.length === 0) {
    return {
      payload: cannedRefusal(),
      llmCalled: false,
      generationPath: "retrieval-refusal",
      providerAttempts: []
    };
  }

  const systemPrompt = buildSystemPrompt(input.programName);
  const userPrompt = buildUserPrompt(input.question, input.chunks);

  // Walk the admin-ordered ZDR-only OpenRouter chain. Any request error, empty
  // answer, or invalid/missing citation advances to the next route. A valid
  // refusal ends the walk. Exhaustion returns a defensive refusal; it never
  // escapes to a direct provider whose retention policy is not enforced here.
  const client = deps.client ?? getPrimaryClient();
  const chain = deps.primaryRoute
    ? [deps.primaryRoute]
    : deps.routeChain ?? (await getActiveModelChain());

  const generationDeadline = getDeadlineConfig().generation;
  let payload: AnswerPayload | null = null;
  let generationPath: GenerateAnswerResult["generationPath"] = "primary";
  const providerAttempts: ProviderAttemptTiming[] = [];
  for (const [index, route] of chain.entries()) {
    // A cancellation (client disconnect or overall ask deadline) between routes
    // stops the walk immediately — do not spend another provider call on a
    // request nobody is waiting for.
    if (input.signal?.aborted) break;
    const attemptStartedAt = performance.now();
    let outcome: ProviderAttemptOutcome = "error";
    let validationFailure: AnswerValidationFailure | null = null;
    let attemptTokens: ProviderTokenUsage | undefined;
    try {
      const routeResult = await callGenerationModel(
        client,
        route.model,
        systemPrompt,
        userPrompt,
        {
          openRouterProvider: route.provider,
          reasoningEffort: route.reasoningEffort,
          timeoutMs: generationDeadline.timeoutMs,
          maxRetries: generationDeadline.maxRetries,
          signal: input.signal
        }
      );
      // Record usage even when the answer later fails validation — a rejected
      // answer still cost tokens, and cost telemetry must reflect that.
      attemptTokens = routeResult.usage ?? undefined;
      const routeText = routeResult.text;
      if (!routeText) {
        outcome = "invalid";
        throw new Error(`route ${route.id} returned no text answer`);
      }
      // A valid refusal short-circuits the chain. Validation failures cascade
      // and carry exact diagnostics for the super-user error log.
      const validation = validateGeneratedAnswer(routeText, input.chunks);
      validationFailure = validation.failure;
      if (!validation.payload) {
        outcome = "invalid";
        throw new Error(
          `route ${route.id} failed answer validation: ${validation.failure.reason}`
        );
      }
      payload = validation.payload;
      generationPath = index === 0 ? "primary" : "fallback";
      outcome = "success";
      break;
    } catch (err) {
      // A cancelled request is not a route failure to fall through — halt the
      // whole chain so the caller can fail closed. The finally block below
      // still records this attempt's timing.
      if (isAbortError(err) || input.signal?.aborted) throw err;
      console.warn(
        `[generation] route ${route.id} failed; trying next in chain:`,
        err instanceof Error ? err.message : err
      );
      void recordAppError({
        severity: "warning",
        source: "generation",
        operation: "openrouter-route-attempt",
        error: err,
        provider: route.provider,
        model: route.model,
        routeId: route.id,
        correlationId: input.diagnostics?.correlationId,
        userId: input.diagnostics?.userId,
        programId: input.diagnostics?.programId,
        context: {
          attempt: index + 1,
          chainLength: chain.length,
          reasoningEffort: route.reasoningEffort,
          outcome,
          chunkCount: input.chunks.length,
          ...(validationFailure ? { validation: validationFailure } : {})
        }
      });
    } finally {
      providerAttempts.push({
        routeId: route.id,
        provider: route.provider,
        model: route.model,
        durationMs: elapsedMs(attemptStartedAt),
        outcome,
        ...(attemptTokens ? { tokens: attemptTokens } : {})
      });
    }
  }

  if (!payload) {
    // Every ZDR-approved route failed validation — defensive refusal.
    return {
      payload: cannedRefusal(),
      llmCalled: true,
      generationPath: "fallback-failed",
      providerAttempts
    };
  }

  return { payload, llmCalled: true, generationPath, providerAttempts };
}

/** Build citation cards in first-appearance order from retrieved ground truth. */
function buildSources(
  citationIds: string[],
  retrievedChunks: RetrievalChunk[]
): Source[] {
  const byId = new Map(retrievedChunks.map((c) => [c.id, c]));
  const out: Source[] = [];
  for (const citationId of citationIds) {
    const chunk = byId.get(citationId);
    if (!chunk) continue;
    out.push({
      chunk_id: chunk.id,
      doc_title: chunk.docTitle ?? "Untitled",
      excerpt: chunk.content
    });
  }
  return out;
}
