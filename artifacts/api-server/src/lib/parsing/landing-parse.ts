/**
 * LandingAI ADE (Agentic Document Extraction) — Parse v2 client.
 *
 * Reference: .claude/reference/landingai-ade.md
 * Endpoint: POST https://api.ade.landing.ai/v2/parse (direct HTTP, no SDK)
 *
 * One Parse call replaces BOTH the former Mistral OCR step AND the separate
 * gpt-4o image-captioning step: Parse v2 returns reading-order markdown with
 * figures described inline as <figure>…<description>…</description></figure>,
 * so downstream chunking/embedding sees image content as text. That closes two
 * Zero-Data-Retention gaps with one component.
 *
 * ZDR note: ZDR here is an ACCOUNT-LEVEL guarantee (Team/Enterprise plan +
 * an Org-Settings toggle), NOT a per-request parameter. This client sends no
 * ZDR field; the request body is orthogonal to whether ZDR is enabled. See the
 * reference doc.
 *
 * Request (multipart/form-data):
 *   document = <file bytes>          # PDF or image (PNG/JPEG/JPG/WebP)
 *   model    = dpt-3-pro-latest
 *
 * Response (only the fields we consume):
 *   {
 *     markdown:  "reading-order CommonMark string",   // this is what we chunk
 *     metadata:  { page_count, model_version, ... }
 *   }
 * The structure/grounding trees are ignored for now (grounding-based citation
 * receipts and Section-based chunking are documented follow-ons, not this path).
 *
 * Sync limits: 50 MiB, 100 pages/PDF. Truenote's 20 MB upload cap fits the size
 * bound; a >100-page PDF exceeds the sync page bound and would need async Parse
 * Jobs (submit + poll) — not implemented here, so an over-limit PDF surfaces as
 * an ingestion failure with the LandingAI error. Documented as a follow-on.
 */

const LANDING_PARSE_URL = "https://api.ade.landing.ai/v2/parse";
const LANDING_PARSE_MODEL = "dpt-3-pro-latest";

/** Backoff base for retryable responses (429 / 5xx); doubles per attempt. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

export interface LandingParseResult {
  /** Reading-order markdown across the whole document; RAG-ready, what we chunk. */
  markdown: string;
  /** Pages processed, from response metadata (0 when absent). */
  pageCount: number;
  /** Model version echoed by the API, for observability. */
  model: string;
}

export interface LandingParseOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Cancels the in-flight parse (overall ingestion abort). */
  signal?: AbortSignal;
  /** Per-attempt timeout in ms. A timeout is retryable; a caller abort is not. */
  timeoutMs?: number;
  /** Retries AFTER the first attempt (0 = single attempt). */
  maxRetries?: number;
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

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi,
    (match, entity: string) => {
      const normalized = entity.toLowerCase();
      if (normalized.startsWith("#x")) {
        const codePoint = Number.parseInt(normalized.slice(2), 16);
        return Number.isInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      }
      if (normalized.startsWith("#")) {
        const codePoint = Number.parseInt(normalized.slice(1), 10);
        return Number.isInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      }
      return named[normalized] ?? match;
    }
  );
}

function markdownTableCell(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

function colspan(attributes: string): number {
  const match = attributes.match(
    /\bcolspan\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i
  );
  const parsed = Number.parseInt(match?.[1] ?? match?.[2] ?? match?.[3] ?? "1", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 20) : 1;
}

function htmlTableToMarkdown(table: string): string {
  const rows = Array.from(table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi))
    .map((rowMatch) => {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[1]?.matchAll(
        /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi
      ) ?? []) {
        cells.push(markdownTableCell(cellMatch[3] ?? ""));
        for (let index = 1; index < colspan(cellMatch[2] ?? ""); index += 1) {
          cells.push("");
        }
      }
      return cells;
    })
    .filter((row) => row.length > 0);

  if (rows.length === 0) return table;
  const width = Math.max(...rows.map((row) => row.length));
  const padded = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => "")
  ]);
  const header = padded[0]!.map((cell, index) => cell || `Column ${index + 1}`);
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(header),
    line(Array.from({ length: width }, () => "---")),
    ...padded.slice(1).map(line)
  ].join("\n");
}

/** Convert parser-only output into readable, chunk-safe Markdown. */
export function normalizeLandingMarkdown(markdown: string): string {
  return markdown
    .replace(/<!--\s*doc_id\s*=[\s\S]*?-->/gi, "")
    .replace(/<!--\s*PAGE BREAK\s*-->/gi, "\n\n")
    .replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, htmlTableToMarkdown)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseLandingResponse(json: unknown): LandingParseResult {
  if (!isRecord(json)) {
    throw new Error("LandingAI parse response: body is not an object");
  }
  const markdown = normalizeLandingMarkdown(asString(json.markdown, ""));
  if (markdown.length === 0) {
    throw new Error("LandingAI parse response: missing or empty markdown");
  }
  const metadata = isRecord(json.metadata) ? json.metadata : {};
  return {
    markdown,
    pageCount: asNumber(metadata.page_count, 0),
    model: asString(metadata.model_version, LANDING_PARSE_MODEL)
  };
}

/** Extension the API uses to sniff the document type; keep in sync with OCR_MIMES. */
function filenameForMime(mimeType: string): string {
  const map: Record<string, string> = {
    "application/pdf": "document.pdf",
    "image/png": "document.png",
    "image/jpeg": "document.jpg",
    "image/jpg": "document.jpg",
    "image/webp": "document.webp"
  };
  return map[mimeType.toLowerCase()] ?? "document";
}

function backoffDelayMs(attempt: number, response?: Response): number {
  const computed = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(computed, seconds * 1_000);
    }
  }
  return computed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One fetch attempt with a per-attempt timeout. The timeout aborts via a local
 * controller so we can tell it apart from a caller abort: on timeout the caller
 * signal is NOT aborted (retryable), on a real caller abort it IS (fatal).
 */
async function fetchOnce(
  fetchImpl: typeof fetch,
  form: FormData,
  apiKey: string,
  timeoutMs: number,
  callerSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new Error(`LandingAI parse timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await fetchImpl(LANDING_PARSE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Parse a document with LandingAI ADE Parse v2 and return its markdown.
 *
 * Retries on 429 and 5xx (and on per-attempt timeouts / transient network
 * errors) with exponential backoff up to `maxRetries`; honors a 429
 * `Retry-After` header. A caller abort (overall ingestion cancellation) is
 * rethrown immediately and never retried.
 */
export async function callLandingParse(
  file: Buffer,
  mimeType: string,
  options: LandingParseOptions = {}
): Promise<LandingParseResult> {
  const apiKey = options.apiKey ?? process.env.VISION_AGENT_API_KEY;
  if (!apiKey) {
    throw new Error("VISION_AGENT_API_KEY is not set");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxRetries = options.maxRetries ?? 0;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("LandingAI parse aborted");
    }
    // Rebuild the multipart body per attempt — a FormData/Blob can be consumed
    // by the first send, so a retry needs a fresh instance.
    const form = new FormData();
    form.append(
      "document",
      new Blob([new Uint8Array(file)], { type: mimeType }),
      filenameForMime(mimeType)
    );
    form.append("model", LANDING_PARSE_MODEL);

    let response: Response;
    try {
      response = await fetchOnce(fetchImpl, form, apiKey, timeoutMs, options.signal);
    } catch (err) {
      // A real caller abort is fatal; our per-attempt timeout leaves the caller
      // signal un-aborted and is treated as a retryable transient error.
      if (options.signal?.aborted) throw err;
      lastError = err;
      if (attempt < maxRetries) {
        await sleep(backoffDelayMs(attempt));
        continue;
      }
      throw err;
    }

    if (response.ok) {
      const json: unknown = await response.json();
      return parseLandingResponse(json);
    }

    const bodyText = await response.text().catch(() => "");
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxRetries) {
      await sleep(backoffDelayMs(attempt, response));
      continue;
    }
    throw new Error(
      `LandingAI parse HTTP ${response.status}: ${bodyText.slice(0, 500) || response.statusText}`
    );
  }
  throw lastError ?? new Error("LandingAI parse failed");
}
