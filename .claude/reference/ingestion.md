# Ingestion Pipeline

> Admin uploads a document → it becomes searchable chunks. This pipeline runs **once per document version**, never on query.

## Flow

1. **Upload** — admin POSTs file to `/api/admin/documents` with `program_id` and `title`. Server stores raw file in Replit Object Storage, computes SHA-256, creates `document_versions` row with `parse_status='pending'`.
2. **Hash dedupe** — if `file_sha256` matches an existing version, reuse its `parsed_markdown` instead of calling OCR. Saves cost on accidental re-uploads.
3. **Parse** — call Mistral OCR (`mistral-ocr-latest`). Store returned markdown in `document_versions.parsed_markdown`. Update `parse_status='ready'`.
4. **Chunk** — semantic chunker over the markdown. Target ~500 tokens. Hard rules: never split inside a markdown table, never split mid-list, prefer header boundaries.
5. **Image describe** — for embedded images in the parsed markdown, call `gpt-4o` (vision) to generate a textual description. Store the description as a chunk with `metadata.has_image=true` and `metadata.image_url`.
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
