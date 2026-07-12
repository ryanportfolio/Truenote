import OpenAI from "openai";
import { getDeadlineConfig } from "../deadlines.js";

/**
 * Vision-based image describer.
 *
 * Mistral OCR returns extracted image data alongside the parsed
 * markdown when we ask for it (`include_image_base64: true`). Those
 * images are typically embedded screenshots, diagrams, charts, or
 * scanned tables that lose their semantics in the text dump. Passing
 * each through GPT-4o vision and inserting the resulting description
 * as its own chunk makes the image content searchable.
 *
 * Cost note: ~$0.005 per image at gpt-4o vision pricing for typical
 * document screenshots. Bound to the OCR'd image set per document
 * version, so this is a one-shot cost at ingestion (never on query).
 * Failures are non-fatal — the document still ingests with its text
 * chunks; only image enrichment is lost.
 */
const VISION_MODEL = "gpt-4o";

const VISION_PROMPT = [
  "Describe this image in 1-3 sentences for a customer-service knowledge",
  "base search index. Focus on factual content: text shown, diagrams,",
  "charts, screenshots, policy tables. If the image contains text,",
  "transcribe key labels, headings, and any numeric values exactly as",
  "shown. Do not editorialize."
].join(" ");

export interface ImageDescriber {
  describe(imageBase64: string, mimeType: string): Promise<string>;
}

export interface OpenAIImageDescriberOptions {
  client?: OpenAI;
}

export class OpenAIImageDescriber implements ImageDescriber {
  private readonly client: OpenAI;

  constructor(options: OpenAIImageDescriberOptions = {}) {
    this.client = options.client ?? new OpenAI();
  }

  /**
   * `imageBase64` is bare base64 (no data: prefix). `mimeType` should
   * be the actual image type from the OCR response — we default to
   * `image/png` upstream because Mistral OCR returns PNG-encoded
   * extracts, but pass it explicitly here so a future change to that
   * encoding doesn't silently break.
   */
  async describe(imageBase64: string, mimeType: string): Promise<string> {
    const dataUri = `data:${mimeType};base64,${imageBase64}`;
    const { imageDescribe } = getDeadlineConfig();
    const response = await this.client.chat.completions.create(
      {
        model: VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: VISION_PROMPT },
              // detail:"low" is enough for our use case (KB image
              // descriptions, not detailed visual reasoning) and ~3x
              // cheaper than the default detail level.
              {
                type: "image_url",
                image_url: { url: dataUri, detail: "low" }
              }
            ]
          }
        ],
        max_tokens: 250
      },
      {
        timeout: imageDescribe.timeoutMs,
        maxRetries: imageDescribe.maxRetries
      }
    );
    return response.choices[0]?.message?.content?.trim() ?? "";
  }
}

/**
 * Noop describer for tests and the local-script fast path. Returns
 * empty so the ingestion pipeline simply produces no image chunks.
 */
export class NoopImageDescriber implements ImageDescriber {
  async describe(): Promise<string> {
    return "";
  }
}
