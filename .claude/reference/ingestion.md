# Ingestion Pipeline

> Admin uploads a document → it becomes searchable chunks. This pipeline runs **once per document version**, never on query.

## Flow

1. **Upload** — admin POSTs file to `/api/admin/documents` with `program_id` and `title`. Server stores raw file in Replit Object Storage, computes SHA-256, creates `document_versions` row with `parse_status='pending'`.
2. **Hash dedupe** — if `file_sha256` matches an existing version, reuse its `parsed_markdown` instead of calling OCR. Saves cost on accidental re-uploads.
3. **Parse** — call Mistral OCR (`mistral-ocr-latest`). Store returned markdown in `document_versions.parsed_markdown`. Update `parse_status='ready'`.
4. **Chunk** — semantic chunker over the markdown. Target ~500 tokens. Hard rules: never split inside a markdown table, never split mid-list, prefer header boundaries. Each chunk then gets a **contextual header** (2026-07): `[Doc Title > Heading > Subheading]` prepended to `content` before storage — so both the embedding AND `content_tsv` (generated from `content`) carry the chunk's provenance (the no-LLM core of Anthropic's contextual retrieval). Header recorded in `metadata.context_header`; helpers in `lib/ingestion/contextual.ts`. **Existing docs need re-ingestion to pick this up**: `pnpm --filter @workspace/scripts run reingest` (re-chunks + re-embeds active versions from stored `parsed_markdown`, preserves image-description chunks, no OCR cost).
5. **Image describe** — for each base64 image returned by Mistral OCR (`include_image_base64: true`), call `gpt-4o` vision (`detail: low`) to generate a 1–3 sentence description. Each description becomes its own `chunks` row with `metadata.has_image=true` and `metadata.image_url`. Per-image failures are non-fatal — the rest of the document still ingests. Implemented in `lib/ingestion/image-describer.ts`; the dedupe path skips this step (re-uploads keep the original ingestion's image enrichment by not re-running OCR).
6. **Embed** — `text-embedding-3-small` for each chunk. Insert into `chunks` with `embedding`, `content_tsv` (auto-generated), and denormalized `program_id`.
7. **Activate** — set `document_versions.is_active=true`. Previous active version for this `document_id` becomes inactive (NOT deleted).

## Why no LlamaParse

Mistral OCR is ~$0.001/page, handles PDFs + images + scanned docs + tables uniformly via REST, and avoids running a Python microservice next to Next.js. PyMuPDF4LLM is faster and free but mangles complex tables — not worth the operational overhead for the cost saved on a CSR-scale KB. If cost ever matters, add PyMuPDF as a "try first, fall back to Mistral if output looks bad" path.

## Admin preview is mandatory

After parse completes, render the parsed markdown side-by-side with chunk boundaries highlighted. Admin must visually confirm before the doc goes live. **Most KB quality bugs are bad parses caught too late.**

## Pitfalls

- Mistral OCR's response is markdown but sometimes wraps tables in code fences. Strip the fences before chunking, or the table becomes one giant indivisible blob.
- Don't run ingestion synchronously in the request handler. Use a background job (BullMQ + Redis, or a simple `pg-boss` queue). Mistral OCR can take 30s+ on a long PDF.
- Re-uploading a document creates a NEW version. Do not overwrite. The old version stays for audit / rollback.
- Embedding cost is trivial but the OpenAI rate limit isn't — batch embed up to 100 chunks per request.
