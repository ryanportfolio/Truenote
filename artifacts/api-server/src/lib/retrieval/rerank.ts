import { CohereClient } from "cohere-ai";
import { getDeadlineConfig } from "../deadlines.js";
import { protectProviderText, protectProviderTexts } from "../security/provider-input-firewall.js";

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
  /** Cancels the in-flight rerank (client disconnect or overall ask deadline). */
  signal?: AbortSignal;
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
 * Default stays on rerank-english-v3.0 because the RERANK_CONFIDENCE_THRESHOLD
 * default (0.3) was tuned on it. The upgrade target is rerank-v4.0-pro
 * (2026-10-07). Switching is a deliberate, eval-gated act: run the eval suite
 * with COHERE_RERANK_MODEL=rerank-v4.0-pro, RETUNE the threshold, then set the
 * model and the retuned threshold together in the Railway variables. Score
 * distributions differ between rerank model versions, so the old threshold
 * is invalid the moment the model changes. Change this default only together
 * with DEFAULT_RERANK_THRESHOLD in query.ts.
 */
const DEFAULT_RERANK_MODEL = "rerank-english-v3.0";

export function getRerankModel(): string {
  return process.env.COHERE_RERANK_MODEL || DEFAULT_RERANK_MODEL;
}

export interface RerankDeps {
  /** Injected for tests. Defaults to the shared Cohere client. */
  client?: CohereClient;
}

export async function rerankWithCohere(
  input: RerankInput,
  deps: RerankDeps = {}
): Promise<RerankResult> {
  if (input.documents.length === 0) return { results: [] };
  const c = deps.client ?? client();
  const top = Math.min(input.topN ?? 8, input.documents.length);
  const { rerank } = getDeadlineConfig();
  const response = await c.rerank(
    {
      model: getRerankModel(),
      query: protectProviderText(input.question).text,
      documents: protectProviderTexts(input.documents),
      topN: top
    },
    {
      timeoutInSeconds: rerank.timeoutMs / 1000,
      maxRetries: rerank.maxRetries,
      abortSignal: input.signal
    }
  );
  return {
    results: response.results.map((r) => ({
      index: r.index,
      relevance_score: r.relevanceScore
    }))
  };
}
