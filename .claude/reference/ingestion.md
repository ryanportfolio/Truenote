# Ingestion Pipeline

> Admin uploads a document → it becomes searchable chunks. This pipeline runs **once per document version**, never on query.

## Flow

1. **Upload** — admin POSTs file to `/api/admin/documents` with `program_id` and `title`. Server stores raw file in Replit Object Storage, computes SHA-256, creates `document_versions` row with `parse_status='pending'`.
2. **Hash dedupe** — if `file_sha256` matches an existing version, reuse its `parsed_markdown` instead of re-parsing. Saves cost on accidental re-uploads.
3. **Parse** — call LandingAI ADE Parse v2 (`dpt-3-pro-latest`, `lib/parsing/landing-parse.ts`) for PDFs and images; `mammoth` for DOCX; passthrough for text/markdown. Parse returns reading-order markdown with any figures/screenshots **described inline** (`<figure><description>…</description></figure>`), so OCR text and image content arrive in one call — there is no separate vision step. Store the markdown in `document_versions.parsed_markdown`. Update `parse_status='ready'`.
4. **Chunk** — semantic chunker over the markdown. Target ~500 tokens. Hard rules: never split inside a markdown table, never split mid-list, prefer header boundaries. Each chunk then gets a **contextual header** (2026-07): `[Doc Title > Heading > Subheading]` prepended to `content` before storage — so both the embedding AND `content_tsv` (generated from `content`) carry the chunk's provenance (the no-LLM core of Anthropic's contextual retrieval). Header recorded in `metadata.context_header`; helpers in `lib/ingestion/contextual.ts`. **Existing docs need re-ingestion to pick this up**: `pnpm --filter @workspace/scripts run reingest` (re-chunks + re-embeds active versions from stored `parsed_markdown`, no parse cost).
5. **Embed** — `text-embedding-3-small` for each chunk. Insert into `chunks` with `embedding`, `content_tsv` (auto-generated), and denormalized `program_id`. Inline figure descriptions ride along as ordinary text chunks.
6. **Activate** — set `document_versions.is_active=true`. Previous active version for this `document_id` becomes inactive (NOT deleted).

## Why LandingAI ADE (not LlamaParse / a Python microservice)

LandingAI ADE Parse v2 handles PDFs + images + scanned docs + tables uniformly via REST, describes embedded figures inline (so no separate captioner), and — on a Team/Enterprise plan with the Org ZDR toggle ON — runs under Zero Data Retention, which the product requires. That single ZDR-capable call replaced the former Mistral OCR + `gpt-4o` captioner pair (2026-07). PyMuPDF4LLM is faster and free but mangles complex tables and cannot describe figures — not worth running a Python service next to Node for a CSR-scale KB. Full vendor detail: `.claude/reference/landingai-ade.md`.

## Admin preview is mandatory

After parse completes, render the parsed markdown side-by-side with chunk boundaries highlighted. Admin must visually confirm before the doc goes live. **Most KB quality bugs are bad parses caught too late.**

## Pitfalls

- LandingAI Parse v2 returns tables as HTML and page breaks as `<!-- PAGE BREAK -->` comments; both flow into chunks as text. Section-based chunking + grounding-based citation coordinates are documented follow-ons in `landingai-ade.md`, not wired up yet.
- Sync Parse is capped at **50 MiB / 100 pages per PDF**. Truenote's 20 MB upload cap fits the size bound; a >100-page PDF exceeds the page bound and currently surfaces as an ingestion failure (async Parse Jobs = submit+poll, deferred). Watch for it if long scanned manuals get uploaded.
- Don't run ingestion synchronously in the request handler. Use a background job (a simple `pg-boss` queue). LandingAI Parse can take 30s+ on a long PDF; `DOCUMENT_PARSE_TIMEOUT_MS` bounds it (default 120s, 2 retries with 429 backoff).
- Re-uploading a document creates a NEW version. Do not overwrite. The old version stays for audit / rollback.
- Embedding cost is trivial but the OpenAI rate limit isn't — batch embed up to 100 chunks per request.
