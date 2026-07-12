import OpenAI from "openai";

const EMBEDDING_MODEL = "text-embedding-3-small";

/** Batch size cap. OpenAI accepts up to 2048 inputs per request, but per
 * .claude/reference/ingestion.md we batch at 100 to bound retry blast radius
 * and stay well under per-request token caps. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * Fallback per-request bounds when a caller constructs the embedder without an
 * explicit deadline. Callers on the live query path pass a tighter timeout; see
 * lib/deadlines.ts. These defaults exist so even a bare `new OpenAIEmbedder()`
 * can never inherit the SDK's 10-minute default timeout.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

export interface EmbedCallOptions {
  /** Cancels the in-flight request (client disconnect or overall ask deadline). */
  signal?: AbortSignal;
}

export interface Embedder {
  embed(texts: string[], options?: EmbedCallOptions): Promise<number[][]>;
}

export interface OpenAIEmbedderOptions {
  client?: OpenAI;
  batchSize?: number;
  /** Per-request timeout in ms. Defaults to a bounded fallback, never the SDK default. */
  timeoutMs?: number;
  /** Retries after the first attempt. */
  maxRetries?: number;
}

export class OpenAIEmbedder implements Embedder {
  private readonly client: OpenAI;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: OpenAIEmbedderOptions = {}) {
    this.client = options.client ?? new OpenAI();
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async embed(texts: string[], options: EmbedCallOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
    const result = new Array<number[]>(texts.length);
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const response = await this.client.embeddings.create(
        {
          model: EMBEDDING_MODEL,
          input: batch
        },
        {
          timeout: this.timeoutMs,
          maxRetries: this.maxRetries,
          signal: options.signal
        }
      );
      // The OpenAI API guarantees response.data preserves input order via
      // the `index` field. We honor that instead of trusting array order.
      for (const item of response.data) {
        const slot = i + item.index;
        result[slot] = item.embedding;
      }
    }
    return result;
  }
}
