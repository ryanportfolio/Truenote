/**
 * Embedding and rerank calls for the compliance assistant. Owner decision,
 * 2026-10-13: compliance excerpts describe security weaknesses, so every
 * provider call stays inside OpenRouter's per-request zero-data-retention
 * boundary, like answer generation. Each request pins one provider from
 * OpenRouter's ZDR endpoint index (GET /api/v1/endpoints/zdr, checked
 * 2026-10-13), sets zdr=true and data_collection=deny, and disables
 * fallback, so OpenRouter refuses the call rather than route it to an
 * endpoint that keeps data.
 *
 * Customer retrieval keeps its direct OpenAI and Cohere clients
 * (lib/ingestion/embedder.ts, lib/retrieval/rerank.ts); nothing here is
 * shared with it.
 *
 * Text passes the local provider firewall first: document text gets the
 * blocking classes (secrets, SSNs, cards) as excerpts do in answer
 * generation; the typed question gets the full firewall.
 */
import { getDeadlineConfig, type ProviderDeadline } from "../deadlines.js";
import {
  protectApprovedDocumentText,
  protectProviderText
} from "../security/provider-input-firewall.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const COMPLIANCE_EMBEDDING_ROUTE = {
  model: "openai/text-embedding-3-small",
  provider: "azure"
} as const;

export const COMPLIANCE_RERANK_ROUTE = {
  model: "qwen/qwen3-reranker-8b",
  provider: "fireworks"
} as const;

const EMBED_BATCH_SIZE = 100;
/** Batches in flight at once: a cold index build embeds every passage. */
const EMBED_CONCURRENCY = 4;

export class ComplianceProviderError extends Error {
  constructor(
    readonly stage: "embedding" | "rerank",
    readonly status: number | null,
    message: string
  ) {
    super(message);
    this.name = "ComplianceProviderError";
  }
}

function zdrProvider(provider: string) {
  return {
    only: [provider],
    zdr: true,
    data_collection: "deny",
    allow_fallbacks: false
  };
}

type Fetch = typeof fetch;

export interface ComplianceProviderDeps {
  fetch?: Fetch;
  apiKey?: string;
}

async function postJson(
  stage: "embedding" | "rerank",
  path: string,
  body: unknown,
  deadline: ProviderDeadline,
  signal: AbortSignal | undefined,
  deps: ComplianceProviderDeps
): Promise<unknown> {
  const apiKey = deps.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new ComplianceProviderError(stage, null, "OPENROUTER_API_KEY is not set");
  const doFetch = deps.fetch ?? fetch;
  let lastError: ComplianceProviderError | null = null;
  for (let attempt = 0; attempt <= deadline.maxRetries; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const timeout = AbortSignal.timeout(deadline.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await doFetch(`${OPENROUTER_BASE_URL}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: combined
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = new ComplianceProviderError(
        stage,
        null,
        `${stage} request failed: ${error instanceof Error ? error.name : "error"}`
      );
      continue;
    }
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: unknown } }
      | null;
    if (response.ok && payload && !payload.error) return payload;
    // Provider messages can echo input; keep only the status and code.
    lastError = new ComplianceProviderError(stage, response.status, `${stage} returned HTTP ${response.status}`);
    if (response.status < 500 && response.status !== 429) break;
  }
  throw lastError ?? new ComplianceProviderError(stage, null, `${stage} failed`);
}

export type ComplianceTextKind = "document" | "question";

function protect(text: string, kind: ComplianceTextKind): string {
  return kind === "question" ? protectProviderText(text).text : protectApprovedDocumentText(text);
}

/** Embed texts in order. Throws ComplianceProviderError on any failure. */
export async function embedComplianceTexts(
  texts: string[],
  kind: ComplianceTextKind,
  options: { signal?: AbortSignal; deadline?: ProviderDeadline } = {},
  deps: ComplianceProviderDeps = {}
): Promise<number[][]> {
  const deadline =
    options.deadline ??
    (kind === "question" ? getDeadlineConfig().queryEmbedding : getDeadlineConfig().ingestionEmbedding);
  const out: number[][] = new Array(texts.length);
  const embedBatch = async (offset: number, signal: AbortSignal): Promise<void> => {
    const batch = texts.slice(offset, offset + EMBED_BATCH_SIZE).map((text) => protect(text, kind));
    const payload = (await postJson(
      "embedding",
      "/embeddings",
      {
        model: COMPLIANCE_EMBEDDING_ROUTE.model,
        input: batch,
        provider: zdrProvider(COMPLIANCE_EMBEDDING_ROUTE.provider)
      },
      deadline,
      signal,
      deps
    )) as { data?: Array<{ index?: unknown; embedding?: unknown }> };
    const data = Array.isArray(payload.data) ? payload.data : [];
    for (const item of data) {
      const index = typeof item.index === "number" ? item.index : -1;
      if (
        index < 0 ||
        index >= batch.length ||
        !Array.isArray(item.embedding) ||
        !item.embedding.every((value) => typeof value === "number")
      ) {
        throw new ComplianceProviderError("embedding", null, "embedding response was malformed");
      }
      out[offset + index] = item.embedding as number[];
    }
    for (let i = offset; i < offset + batch.length; i += 1) {
      if (!out[i]) throw new ComplianceProviderError("embedding", null, "embedding response was incomplete");
    }
  };
  const offsets: number[] = [];
  for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) offsets.push(offset);
  // The first failure cancels the batches still in flight, and the call
  // returns only after every lane has stopped, so a failed build never leaves
  // requests running behind a replacement build.
  const lanes = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lanes.signal]) : lanes.signal;
  let next = 0;
  let failure: { error: unknown } | null = null;
  const lane = async (): Promise<void> => {
    while (failure === null && next < offsets.length) {
      const offset = offsets[next++]!;
      try {
        await embedBatch(offset, signal);
      } catch (error) {
        if (failure === null) {
          failure = { error };
          lanes.abort(error);
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, offsets.length) }, lane));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return out;
}

/** Rerank documents against the question. Results are sorted by score, highest first. */
export async function rerankComplianceTexts(
  question: string,
  documents: string[],
  topN: number,
  options: { signal?: AbortSignal } = {},
  deps: ComplianceProviderDeps = {}
): Promise<Array<{ index: number; score: number }>> {
  if (documents.length === 0) return [];
  const payload = (await postJson(
    "rerank",
    "/rerank",
    {
      model: COMPLIANCE_RERANK_ROUTE.model,
      query: protect(question, "question"),
      documents: documents.map((text) => protect(text, "document")),
      top_n: Math.min(topN, documents.length),
      provider: zdrProvider(COMPLIANCE_RERANK_ROUTE.provider)
    },
    getDeadlineConfig().rerank,
    options.signal,
    deps
  )) as { results?: Array<{ index?: unknown; relevance_score?: unknown }> };
  const results = Array.isArray(payload.results) ? payload.results : [];
  const out: Array<{ index: number; score: number }> = [];
  for (const item of results) {
    if (
      typeof item.index !== "number" ||
      item.index < 0 ||
      item.index >= documents.length ||
      typeof item.relevance_score !== "number" ||
      !Number.isFinite(item.relevance_score)
    ) {
      throw new ComplianceProviderError("rerank", null, "rerank response was malformed");
    }
    out.push({ index: item.index, score: item.relevance_score });
  }
  out.sort((left, right) => right.score - left.score);
  return out;
}
