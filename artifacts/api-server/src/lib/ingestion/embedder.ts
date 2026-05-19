import OpenAI from "openai";

const EMBEDDING_MODEL = "text-embedding-3-small";

/** Batch size cap. OpenAI accepts up to 2048 inputs per request, but per
 * .claude/reference/ingestion.md we batch at 100 to bound retry blast radius
 * and stay well under per-request token caps. */
const DEFAULT_BATCH_SIZE = 100;

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface OpenAIEmbedderOptions {
  client?: OpenAI;
  batchSize?: number;
}

export class OpenAIEmbedder implements Embedder {
  private readonly client: OpenAI;
  private readonly batchSize: number;

  constructor(options: OpenAIEmbedderOptions = {}) {
    this.client = options.client ?? new OpenAI();
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const result = new Array<number[]>(texts.length);
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const response = await this.client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch
      });
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
