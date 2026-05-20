/**
 * Mistral OCR client.
 *
 * Reference: https://docs.mistral.ai/capabilities/OCR/basic_ocr
 * Endpoint: POST https://api.mistral.ai/v1/ocr
 *
 * Request shape (base64 data URI is recommended for uploaded files — avoids
 * signed-URL plumbing per .claude/reference/secrets.md):
 *
 *   {
 *     model: "mistral-ocr-latest",
 *     document:
 *       { type: "document_url", document_url: "data:application/pdf;base64,..." }
 *     | { type: "image_url",    image_url:    "data:image/png;base64,..." },
 *     include_image_base64?: boolean
 *   }
 *
 * Response shape:
 *   {
 *     pages: [{ index, markdown, images: [...], dimensions: {...} }],
 *     model: string,
 *     document_annotation: object | null,
 *     usage_info: { pages_processed: number, doc_size_bytes: number }
 *   }
 *
 * Per .claude/reference/ingestion.md, OCR markdown sometimes wraps tables in
 * code fences which would otherwise make them one indivisible blob during
 * chunking — we strip those fences during parsing.
 */

const OCR_URL = "https://api.mistral.ai/v1/ocr";
const OCR_MODEL = "mistral-ocr-latest";

export interface OcrPageImage {
  id?: string;
  top_left_x?: number;
  top_left_y?: number;
  bottom_right_x?: number;
  bottom_right_y?: number;
  image_base64?: string;
}

export interface OcrPage {
  index: number;
  markdown: string;
  images: OcrPageImage[];
  dimensions?: { dpi?: number; width?: number; height?: number };
}

export interface OcrResult {
  /** Joined markdown across all pages, with table-fence cleanup applied. */
  markdown: string;
  /** Per-page detail; callers needing image data or page boundaries use this. */
  pages: OcrPage[];
  model: string;
  pagesProcessed: number;
  docSizeBytes: number;
}

export interface MistralOcrClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Ask Mistral to return base64-encoded extracts for each detected
   * image. Defaults to false to keep response payloads small for
   * callers that only need the parsed markdown. The ingestion
   * pipeline (run.ts) sets this true so the image-describer can
   * generate per-image chunks downstream.
   */
  includeImageBase64?: boolean;
}

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

function pickDocumentField(
  mimeType: string,
  dataUri: string
): { type: "document_url"; document_url: string } | { type: "image_url"; image_url: string } {
  if (IMAGE_MIMES.has(mimeType.toLowerCase())) {
    return { type: "image_url", image_url: dataUri };
  }
  return { type: "document_url", document_url: dataUri };
}

function toDataUri(file: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${file.toString("base64")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parsePageImage(raw: unknown): OcrPageImage {
  if (!isRecord(raw)) return {};
  const image: OcrPageImage = {};
  if (typeof raw.id === "string") image.id = raw.id;
  if (typeof raw.top_left_x === "number") image.top_left_x = raw.top_left_x;
  if (typeof raw.top_left_y === "number") image.top_left_y = raw.top_left_y;
  if (typeof raw.bottom_right_x === "number") image.bottom_right_x = raw.bottom_right_x;
  if (typeof raw.bottom_right_y === "number") image.bottom_right_y = raw.bottom_right_y;
  if (typeof raw.image_base64 === "string") image.image_base64 = raw.image_base64;
  return image;
}

function parsePage(raw: unknown): OcrPage {
  if (!isRecord(raw)) {
    throw new Error("Mistral OCR response: page is not an object");
  }
  const images = Array.isArray(raw.images) ? raw.images.map(parsePageImage) : [];
  const dimensions = isRecord(raw.dimensions)
    ? {
        dpi: typeof raw.dimensions.dpi === "number" ? raw.dimensions.dpi : undefined,
        width: typeof raw.dimensions.width === "number" ? raw.dimensions.width : undefined,
        height: typeof raw.dimensions.height === "number" ? raw.dimensions.height : undefined
      }
    : undefined;
  return {
    index: asNumber(raw.index, 0),
    markdown: asString(raw.markdown, ""),
    images,
    dimensions
  };
}

/**
 * Strip ``` fences that wrap markdown tables. Mistral OCR occasionally wraps
 * a whole table in a code fence, which would prevent the chunker from
 * splitting on row boundaries OR keep the table intact as a chunk (we want
 * the latter, but the fence corrupts the rendered output for the admin
 * preview). See ingestion.md → Pitfalls.
 */
export function stripTableCodeFences(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fenceMatch = /^```(\s*(markdown|md|))?\s*$/i.exec(line);
    if (fenceMatch) {
      // Look ahead for the closing fence and check if the contents look like
      // a markdown table (first non-empty line starts with "|").
      let j = i + 1;
      while (j < lines.length && !/^```\s*$/.test(lines[j] ?? "")) j++;
      const inner = lines.slice(i + 1, j);
      const firstNonEmpty = inner.find((l) => l.trim().length > 0) ?? "";
      const looksLikeTable = firstNonEmpty.trimStart().startsWith("|");
      if (looksLikeTable && j < lines.length) {
        // Drop the opening and closing fence, keep inner lines.
        out.push(...inner);
        i = j + 1;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

export function parseMistralOcrResponse(json: unknown): OcrResult {
  if (!isRecord(json)) {
    throw new Error("Mistral OCR response: body is not an object");
  }
  if (!Array.isArray(json.pages)) {
    throw new Error("Mistral OCR response: missing pages array");
  }
  const pages = json.pages.map(parsePage);
  const joined = pages.map((p) => p.markdown).join("\n\n");
  const markdown = stripTableCodeFences(joined);

  const usageInfo = isRecord(json.usage_info) ? json.usage_info : {};
  return {
    markdown,
    pages,
    model: asString(json.model, OCR_MODEL),
    pagesProcessed: asNumber(usageInfo.pages_processed, pages.length),
    docSizeBytes: asNumber(usageInfo.doc_size_bytes, 0)
  };
}

export async function callMistralOcr(
  file: Buffer,
  mimeType: string,
  options: MistralOcrClientOptions = {}
): Promise<OcrResult> {
  const apiKey = options.apiKey ?? process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is not set");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const dataUri = toDataUri(file, mimeType);
  const body = {
    model: OCR_MODEL,
    document: pickDocumentField(mimeType, dataUri),
    include_image_base64: options.includeImageBase64 ?? false
  };

  const response = await fetchImpl(OCR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: options.signal
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Mistral OCR HTTP ${response.status}: ${errText.slice(0, 500) || response.statusText}`
    );
  }

  const json: unknown = await response.json();
  return parseMistralOcrResponse(json);
}
