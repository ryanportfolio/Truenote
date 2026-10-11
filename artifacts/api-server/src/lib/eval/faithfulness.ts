import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { RetrievalChunk } from "../retrieval/query.js";
import { formatExcerpts } from "../generation/answer.js";
import { protectProviderText } from "../security/provider-input-firewall.js";
import { getDeadlineConfig } from "../deadlines.js";

/**
 * Claim-level faithfulness judge (Cohere RAG-eval methodology, 2026-07).
 *
 * Decomposes a generated answer into atomic factual claims and labels each
 * one supported/unsupported against the excerpts the LLM actually saw. This
 * catches the failure phrase-matching can't: a well-cited answer that
 * smuggles in ONE invented fee or date. For a refusal-over-hallucination
 * product, unsupported-claim rate is the metric that matters most.
 *
 * One structured-output call does extract + judge together — at eval-set
 * scale (~50-200 questions) the two-call variant buys nothing but latency.
 *
 * Runs on OpenRouter, pinned to the Azure endpoint with Zero Data Retention
 * required, data collection denied and no provider fallback, for the same
 * model the judge used on direct OpenAI. OpenRouter lists openai/gpt-6.1-sol
 * on Azure in its ZDR index with response_format/structured_outputs supported
 * (checked 2026-10-11). Judge prompts carry excerpts and answers, so they now
 * stay inside the same ZDR boundary as answer generation. Scores stay
 * comparable with earlier runs because the model is unchanged.
 * The judge model is a reasoning model: it takes reasoning_effort (low and up;
 * no "none") in place of temperature, so judge runs are not bit-for-bit
 * deterministic. Changing the judge model shifts faithfulness scores; re-run
 * the eval baseline before comparing against older runs.
 */
export const JUDGE_MODEL = "openai/gpt-6.1-sol";
export const JUDGE_REASONING_EFFORT = "medium" as const;

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter-only request field pinning eval judges to one ZDR endpoint. The
 * OpenAI SDK types lack it, so request bodies carrying it are cast.
 */
export const JUDGE_PROVIDER = {
  only: ["azure"],
  zdr: true,
  data_collection: "deny",
  allow_fallbacks: false
} as const;

export type JudgeProviderField = { provider: typeof JUDGE_PROVIDER };

export const ClaimJudgmentSchema = z.object({
  /** The atomic factual claim, quoted or minimally paraphrased from the answer. */
  claim: z.string(),
  /** True ONLY if the excerpts fully support the claim. */
  supported: z.boolean()
});

export const FaithfulnessSchema = z.object({
  claims: z.array(ClaimJudgmentSchema)
});

export type ClaimJudgment = z.infer<typeof ClaimJudgmentSchema>;

export interface FaithfulnessJudgment {
  claims: ClaimJudgment[];
  /** % of claims supported. Null when the answer contained no factual claims. */
  faithfulnessPct: number | null;
  unsupportedClaims: string[];
}

export interface JudgeFaithfulnessInput {
  answer: string;
  /** The chunks the generation step actually received (including neighbors). */
  chunks: RetrievalChunk[];
}

export interface JudgeFaithfulnessDeps {
  client?: OpenAI;
}

let _client: OpenAI | null = null;
/** Shared lazily built OpenRouter client for the eval judges. */
export function getJudgeClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL
    });
  }
  return _client;
}

const JUDGE_SYSTEM_PROMPT = [
  "You are a strict fact-checking judge for a retrieval-augmented answer.",
  "",
  "Decompose the ANSWER into atomic factual claims — each a single verifiable",
  "statement (a fee, date, deadline, step, condition, name, or policy fact).",
  "Then label every claim:",
  "  supported = true  ONLY if the claim is fully supported by the EXCERPTS.",
  "  supported = false if it relies on outside knowledge, plausible inference,",
  "                    or facts absent from the EXCERPTS.",
  "",
  "Rules:",
  "- Citation markers like [chunk_id] are not evidence; judge the claim text",
  "  against excerpt content.",
  "- Ignore meta-statements, hedges, and refusal boilerplate — they are not",
  "  factual claims.",
  "- If the answer contains no factual claims, return an empty claims list.",
  "- When in doubt, supported = false."
].join("\n");

export async function judgeFaithfulness(
  input: JudgeFaithfulnessInput,
  deps: JudgeFaithfulnessDeps = {}
): Promise<FaithfulnessJudgment> {
  const client = deps.client ?? getJudgeClient();
  // Same deterministic pre-provider firewall as the embedding/rerank/generation
  // paths: sensitive content is redacted before the prompt is built, ZDR route
  // or not. Generation saw redacted excerpts too, so the judge scores the same
  // view the answer was produced from.
  const protectedExcerpts = protectProviderText(formatExcerpts(input.chunks)).text;
  const protectedAnswer = protectProviderText(input.answer).text;
  const userPrompt = `EXCERPTS:\n${protectedExcerpts}\n\nANSWER:\n${protectedAnswer}`;

  const { faithfulness } = getDeadlineConfig();
  const request = {
    model: JUDGE_MODEL,
    reasoning_effort: JUDGE_REASONING_EFFORT,
    messages: [
      { role: "system" as const, content: JUDGE_SYSTEM_PROMPT },
      { role: "user" as const, content: userPrompt }
    ],
    response_format: zodResponseFormat(FaithfulnessSchema, "faithfulness")
  };
  const completion = await client.beta.chat.completions.parse(
    { ...request, provider: JUDGE_PROVIDER } as typeof request & JudgeProviderField,
    {
      timeout: faithfulness.timeoutMs,
      maxRetries: faithfulness.maxRetries
    }
  );

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) {
    throw new Error("Faithfulness judge failed to produce a valid judgment");
  }
  return scoreClaims(parsed.claims);
}

/** Pure scoring step, exported for tests. */
export function scoreClaims(claims: ClaimJudgment[]): FaithfulnessJudgment {
  const unsupportedClaims = claims.filter((c) => !c.supported).map((c) => c.claim);
  return {
    claims,
    faithfulnessPct:
      claims.length === 0
        ? null
        : ((claims.length - unsupportedClaims.length) / claims.length) * 100,
    unsupportedClaims
  };
}
