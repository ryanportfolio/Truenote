import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { RetrievalChunk } from "../retrieval/query.js";
import {
  elapsedMs,
  type ProviderAttemptOutcome,
  type ProviderAttemptTiming
} from "../observability/pipeline-timing.js";
import { recordAppError } from "../observability/error-log.js";
import {
  FALLBACK_MODEL,
  getActiveModelChain,
  type ApprovedModelRoute
} from "./model-routing.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const SourceSchema = z.object({
  chunk_id: z.string(),
  doc_title: z.string(),
  excerpt: z.string()
});

export const AnswerSchema = z.object({
  answer: z.string(),
  sources: z.array(SourceSchema),
  refused: z.boolean(),
  confidence: z.enum(["high", "medium", "low"])
});

export type Source = z.infer<typeof SourceSchema>;
export type AnswerPayload = z.infer<typeof AnswerSchema>;

/** Canned refusal copy, matching the system prompt verbatim. */
export const REFUSAL_TEXT =
  "I couldn't find this in the knowledge base. Please escalate or check the source documents directly.";

/**
 * Rules 1–6 of the system prompt from .claude/reference/retrieval.md →
 * Generation contract. Do not paraphrase the rule text — the wording is part
 * of the product contract and is tested against eval questions in Phase 2.
 *
 * Two pieces from the reference document live elsewhere:
 *   - the JSON schema block (response shape) is enforced by
 *     zodResponseFormat(AnswerSchema) below, not via prose instruction.
 *   - the EXCERPTS and QUESTION blocks are the user message, built by
 *     buildUserPrompt(). Keeping them out of the system prompt lets the
 *     system prompt cache across requests with different excerpts.
 */
export function buildSystemPrompt(programName: string): string {
  return [
    `You are a customer service knowledge assistant for ${programName}.`,
    "",
    "RULES (non-negotiable):",
    "1. ONLY use the EXCERPTS below. Do not use outside knowledge.",
    '2. If the answer is not fully supported by the excerpts, set "refused": true',
    `   and answer: "${REFUSAL_TEXT}"`,
    "3. Never invent fees, dates, names, policy numbers, or procedures.",
    "4. Cite every factual claim inline using [chunk_id].",
    "5. Prefer the most recent document version when excerpts conflict.",
    "6. Format the answer as GitHub-flavored Markdown. Use numbered steps for",
    "   procedures, bullet lists for options, and **bold** for key values",
    "   (fees, dates, deadlines). Use a table only to compare options. Never",
    "   use headings, code blocks, images, links, or task lists."
  ].join("\n");
}

export function formatExcerpts(chunks: RetrievalChunk[]): string {
  return chunks
    .map((c) => {
      const title = c.docTitle ?? "Untitled";
      return `[chunk_id: ${c.id}] (doc: ${title})\n${c.content}`;
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

let _fallbackClient: OpenAI | null = null;
function getFallbackClient(): OpenAI {
  if (!_fallbackClient) _fallbackClient = new OpenAI();
  return _fallbackClient;
}

export interface GenerateAnswerInput {
  programName: string;
  question: string;
  chunks: RetrievalChunk[];
  /** When retrieval returned refused=true, skip the LLM call entirely. */
  refusedByRetrieval?: boolean;
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
  /** Backup generation client. Defaults to OpenAI. */
  fallbackClient?: OpenAI;
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
    openRouterProvider?: string;
    reasoningEffort?: "low" | "medium";
  } = {}
): Promise<AnswerPayload | null> {
  const request = {
    model,
    ...(options.reasoningEffort
      ? { reasoning_effort: options.reasoningEffort }
      : { temperature: 0 }),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    response_format: zodResponseFormat(AnswerSchema, "answer")
  } satisfies OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

  // Keep privacy + schema guarantees in the request itself, even though the
  // OpenRouter API key is also assigned to a matching account guardrail.
  const completion = options.openRouterProvider
    ? await client.beta.chat.completions.parse({
        ...request,
        provider: {
          only: [options.openRouterProvider],
          zdr: true,
          data_collection: "deny",
          require_parameters: true,
          allow_fallbacks: false
        }
      } as typeof request & {
        provider: {
          only: string[];
          zdr: boolean;
          data_collection: "deny";
          require_parameters: boolean;
          allow_fallbacks: boolean;
        };
      })
    : await client.beta.chat.completions.parse(request);

  return completion.choices[0]?.message.parsed ?? null;
}

/**
 * Replace model-authored source metadata with retrieved ground truth, then
 * reject any non-refusal answer that is empty, uncited, or cites only chunks
 * the model never received. A rejected primary answer is a provider failure
 * for routing purposes and must be retried through the backup model.
 */
function normalizeAnswer(
  payload: AnswerPayload,
  chunks: RetrievalChunk[]
): AnswerPayload | null {
  if (payload.refused) return cannedRefusal();

  const sources = validateSources(payload.sources, chunks);
  const hasInlineCitation = sources.some((source) =>
    payload.answer.includes(`[${source.chunk_id}]`)
  );
  if (payload.answer.trim().length === 0 || sources.length === 0 || !hasInlineCitation) {
    return null;
  }

  return { ...payload, sources };
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

  // OpenRouter is OpenAI-compatible, so every approved route in the chain and
  // the direct OpenAI backup share the same strict Zod-derived JSON schema.
  // The admin-ordered chain is walked in order (index 0 = primary): any thrown
  // request, invalid structured response, empty answer, or invalid/missing
  // citation is a model error and advances to the next route. A valid grounded
  // refusal is NOT an error — it ends the walk and is returned as-is.
  const client = deps.client ?? getPrimaryClient();
  const chain = deps.primaryRoute
    ? [deps.primaryRoute]
    : deps.routeChain ?? (await getActiveModelChain());

  let payload: AnswerPayload | null = null;
  let generationPath: GenerateAnswerResult["generationPath"] = "primary";
  const providerAttempts: ProviderAttemptTiming[] = [];
  for (const [index, route] of chain.entries()) {
    const attemptStartedAt = performance.now();
    let outcome: ProviderAttemptOutcome = "error";
    try {
      const routePayload = await callGenerationModel(
        client,
        route.model,
        systemPrompt,
        userPrompt,
        {
          openRouterProvider: route.provider,
          reasoningEffort: route.reasoningEffort
        }
      );
      if (!routePayload) {
        outcome = "invalid";
        throw new Error(`route ${route.id} returned no parsed answer`);
      }
      // normalizeAnswer returns the canned refusal (non-null) for a valid
      // refusal, so a refusal short-circuits the chain here; it returns null
      // only for an empty/uncited/unknown-citation answer, which cascades.
      const normalized = normalizeAnswer(routePayload, input.chunks);
      if (!normalized) {
        outcome = "invalid";
        throw new Error(`route ${route.id} returned an invalid or uncited answer`);
      }
      payload = normalized;
      generationPath = index === 0 ? "primary" : "fallback";
      outcome = "success";
      break;
    } catch (err) {
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
          chunkCount: input.chunks.length
        }
      });
    } finally {
      providerAttempts.push({
        routeId: route.id,
        provider: route.provider,
        model: route.model,
        durationMs: elapsedMs(attemptStartedAt),
        outcome
      });
    }
  }

  if (!payload) {
    // The whole OpenRouter chain errored. Last resort: direct OpenAI, which
    // survives an OpenRouter-wide outage because it does not use OpenRouter.
    const fallbackStartedAt = performance.now();
    let fallbackOutcome: ProviderAttemptOutcome = "error";
    try {
      const fallbackClient = deps.fallbackClient ?? getFallbackClient();
      const fallbackPayload = await callGenerationModel(
        fallbackClient,
        FALLBACK_MODEL.model,
        systemPrompt,
        userPrompt,
        { reasoningEffort: FALLBACK_MODEL.reasoningEffort }
      );
      payload = fallbackPayload ? normalizeAnswer(fallbackPayload, input.chunks) : null;
      if (payload) {
        generationPath = "fallback";
        fallbackOutcome = "success";
      } else {
        fallbackOutcome = "invalid";
        void recordAppError({
          severity: "error",
          source: "generation",
          operation: "direct-openai-fallback-validation",
          error: new Error(
            fallbackPayload
              ? "direct OpenAI fallback returned an invalid or uncited answer"
              : "direct OpenAI fallback returned no parsed answer"
          ),
          provider: "openai-direct",
          model: FALLBACK_MODEL.model,
          routeId: "direct-openai-fallback",
          correlationId: input.diagnostics?.correlationId,
          userId: input.diagnostics?.userId,
          programId: input.diagnostics?.programId,
          context: { outcome: fallbackOutcome, chunkCount: input.chunks.length }
        });
      }
    } catch (err) {
      console.warn(
        "[generation] direct OpenAI backup failed:",
        err instanceof Error ? err.message : err
      );
      void recordAppError({
        severity: "error",
        source: "generation",
        operation: "direct-openai-fallback",
        error: err,
        provider: "openai-direct",
        model: FALLBACK_MODEL.model,
        routeId: "direct-openai-fallback",
        correlationId: input.diagnostics?.correlationId,
        userId: input.diagnostics?.userId,
        programId: input.diagnostics?.programId,
        context: { outcome: fallbackOutcome, chunkCount: input.chunks.length }
      });
      payload = null;
    } finally {
      providerAttempts.push({
        routeId: "direct-openai-fallback",
        provider: "openai-direct",
        model: FALLBACK_MODEL.model,
        durationMs: elapsedMs(fallbackStartedAt),
        outcome: fallbackOutcome
      });
    }
  }

  if (!payload) {
    // Every route and the backup failed to satisfy the schema — defensive refusal.
    return {
      payload: cannedRefusal(),
      llmCalled: true,
      generationPath: "fallback-failed",
      providerAttempts
    };
  }

  return { payload, llmCalled: true, generationPath, providerAttempts };
}

/**
 * Validate the LLM's claimed sources against the actual retrieved chunks.
 * For each LLM source with a chunk_id we recognize, emit a source whose
 * doc_title and excerpt come from the retrieved chunk — never from the LLM.
 * Unknown chunk_ids are dropped (which may collapse the answer to refusal
 * upstream).
 */
function validateSources(
  llmSources: Source[],
  retrievedChunks: RetrievalChunk[]
): Source[] {
  const byId = new Map(retrievedChunks.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of llmSources) {
    const chunk = byId.get(s.chunk_id);
    if (!chunk) continue;
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    out.push({
      chunk_id: chunk.id,
      doc_title: chunk.docTitle ?? "Untitled",
      excerpt: chunk.content
    });
  }
  return out;
}
