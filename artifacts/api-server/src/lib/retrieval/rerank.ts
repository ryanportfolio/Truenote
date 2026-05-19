import { CohereClient } from "cohere-ai";

let _cohere: CohereClient | null = null;

function client(): CohereClient {
  if (_cohere) return _cohere;
  const token = process.env.COHERE_API_KEY;
  if (!token) throw new Error("COHERE_API_KEY is not set");
  _cohere = new CohereClient({ token });
  return _cohere;
}

export interface RerankInput {
  question: string;
  documents: string[];
  topN?: number;
}

export interface RerankResultItem {
  /** Index into the original `documents` array. */
  index: number;
  /** 0..1 relevance from rerank-english-v3.0. */
  relevance_score: number;
}

export interface RerankResult {
  results: RerankResultItem[];
}

/** rerank-english-v3.0 — the model name is locked per .claude/reference/secrets.md. */
const RERANK_MODEL = "rerank-english-v3.0";

export async function rerankWithCohere(input: RerankInput): Promise<RerankResult> {
  if (input.documents.length === 0) return { results: [] };
  const c = client();
  const top = Math.min(input.topN ?? 8, input.documents.length);
  const response = await c.rerank({
    model: RERANK_MODEL,
    query: input.question,
    documents: input.documents,
    topN: top
  });
  return {
    results: response.results.map((r) => ({
      index: r.index,
      relevance_score: r.relevanceScore
    }))
  };
}
