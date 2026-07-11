import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { RetrievalChunk } from "../retrieval/query.js";
import { formatExcerpts } from "../generation/answer.js";

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
 * Kept on direct OpenAI gpt-4o so the judge is operationally independent of
 * the OpenRouter answer path and still runs if the primary provider is down.
 */
const JUDGE_MODEL = "gpt-4o";

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
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI();
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
  const client = deps.client ?? getClient();
  const userPrompt = `EXCERPTS:\n${formatExcerpts(input.chunks)}\n\nANSWER:\n${input.answer}`;

  const completion = await client.beta.chat.completions.parse({
    model: JUDGE_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ],
    response_format: zodResponseFormat(FaithfulnessSchema, "faithfulness")
  });

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
