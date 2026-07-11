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
  /** 0..1 relevance from the configured Cohere rerank model. */
  relevance_score: number;
}

export interface RerankResult {
  results: RerankResultItem[];
}

/**
 * Default stays on rerank-english-v3.0. Upgrading (e.g. to rerank-v3.5) is a
 * deliberate, eval-gated act: set COHERE_RERANK_MODEL in Replit Secrets, run
 * the eval suite, and RETUNE RERANK_CONFIDENCE_THRESHOLD — score
 * distributions differ between rerank model versions, so the old threshold
 * is invalid the moment the model changes.
 */
const DEFAULT_RERANK_MODEL = "rerank-english-v3.0";

export function getRerankModel(): string {
  return process.env.COHERE_RERANK_MODEL || DEFAULT_RERANK_MODEL;
}

export async function rerankWithCohere(input: RerankInput): Promise<RerankResult> {
  if (input.documents.length === 0) return { results: [] };
  const c = client();
  const top = Math.min(input.topN ?? 8, input.documents.length);
  const response = await c.rerank({
    model: getRerankModel(),
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
