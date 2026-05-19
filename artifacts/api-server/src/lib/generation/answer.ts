import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { RetrievalChunk } from "../retrieval/query.js";

const GENERATION_MODEL = "gpt-4o";

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
 * Rules 1–5 of the system prompt from .claude/reference/retrieval.md →
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
    "5. Prefer the most recent document version when excerpts conflict."
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

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI();
  return _client;
}

export interface GenerateAnswerInput {
  programName: string;
  question: string;
  chunks: RetrievalChunk[];
  /** When retrieval returned refused=true, skip the LLM call entirely. */
  refusedByRetrieval?: boolean;
}

export interface GenerateAnswerResult {
  payload: AnswerPayload;
  llmCalled: boolean;
}

export interface GenerateAnswerDeps {
  client?: OpenAI;
}

export async function generateAnswer(
  input: GenerateAnswerInput,
  deps: GenerateAnswerDeps = {}
): Promise<GenerateAnswerResult> {
  if (input.refusedByRetrieval || input.chunks.length === 0) {
    return { payload: cannedRefusal(), llmCalled: false };
  }

  const systemPrompt = buildSystemPrompt(input.programName);
  const userPrompt = buildUserPrompt(input.question, input.chunks);

  const client = deps.client ?? getClient();
  // OpenAI structured outputs — Zod -> JSON schema -> guaranteed shape from
  // the model. We do NOT rely on "respond as JSON" in the prompt alone
  // (retrieval.md → Generation contract).
  const completion = await client.beta.chat.completions.parse({
    model: GENERATION_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    response_format: zodResponseFormat(AnswerSchema, "answer")
  });

  const choice = completion.choices[0];
  if (!choice?.message.parsed) {
    // Model failed to satisfy the schema — defensive refusal.
    return { payload: cannedRefusal(), llmCalled: true };
  }

  let payload = choice.message.parsed;

  // Replace LLM-returned sources with trusted ones built from the retrieved
  // chunks. The LLM can:
  //   - cite a chunk_id we never sent (hallucination)
  //   - cite a real chunk_id but invent the excerpt or doc_title
  // Either way, the CitationPanel would display the LLM's text as if it were
  // ground truth. We don't take that risk — the chunk's actual content +
  // title are authoritative.
  payload = { ...payload, sources: validateSources(payload.sources, input.chunks) };

  // Hard rule from the mission: zero sources => refusal, regardless of the
  // model's `refused` flag. An answer without citations is not an answer.
  if (payload.sources.length === 0) {
    payload = cannedRefusal();
  }

  return { payload, llmCalled: true };
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
