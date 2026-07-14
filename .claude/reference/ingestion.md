# Ingestion Pipeline

> Admin uploads a document → it is scanned, parsed, reviewed, then becomes searchable chunks. This pipeline runs **once per document version**, never on query.

## Flow

1. **Upload + provenance** — manager POSTs to `/api/documents` with title, approved `source_id`, original source URI, and classification. Server stores raw bytes, computes SHA-256, and creates an inactive `submitted` version.
2. **Boundary + malware scan** — validate magic bytes and EICAR, then call the organization-approved scanner. Missing, failed, infected, or insecure scanner results quarantine the version before any parser receives bytes.
3. **Hash dedupe** — if `file_sha256` matches an existing ready version, reuse its `parsed_markdown` instead of re-parsing. Saves cost on accidental re-uploads.
4. **Parse** — call LandingAI ADE Parse v2 (`dpt-3-pro-latest`, `lib/parsing/landing-parse.ts`) for PDFs and images; `mammoth` for DOCX; passthrough for text/markdown. Parse returns reading-order markdown with any figures/screenshots **described inline** (`<figure><description>…</description></figure>`), so OCR text and image content arrive in one call.
5. **Content DLP** — scan parsed text for private keys, API-key patterns, SSNs, payment cards, and prompt-injection markers. Blocking PII/secret findings quarantine before embedding. Findings store rule/count only, never matched content.
6. **Chunk** — semantic chunker over the markdown. Target ~500 tokens. Hard rules: never split inside a markdown table, never split mid-list, prefer header boundaries. Each chunk gets a contextual `[Doc Title > Heading > Subheading]` header before storage, so embedding and `content_tsv` carry provenance.
7. **Embed** — `text-embedding-3-small` for each clean chunk. Insert into `chunks` with `embedding`, `content_tsv`, and denormalized `program_id`.
8. **Pending review** — atomically store chunks, set `parse_status='ready'`, `lifecycle_state='pending_review'`, and keep `is_active=false`.
9. **Approve + activate** — a different senior manager or super user reviews provenance, parsed text, classification, and findings. Approval transaction retires the prior active version and activates the reviewed version. No ingestion worker activates content.

## Why LandingAI ADE (not LlamaParse / a Python microservice)

LandingAI ADE Parse v2 handles PDFs + images + scanned docs + tables uniformly via REST, describes embedded figures inline (so no separate captioner), and — on a Team/Enterprise plan with the Org ZDR toggle ON — runs under Zero Data Retention, which the product requires. That single ZDR-capable call replaced the former Mistral OCR + `gpt-4o` captioner pair (2026-07). PyMuPDF4LLM is faster and free but mangles complex tables and cannot describe figures — not worth running a Python service next to Node for a CSR-scale KB. Full vendor detail: `.claude/reference/landingai-ade.md`.

## Admin preview is mandatory

After parse completes, render provenance, scanner findings, classification, and parsed markdown. A different authorized reviewer must explicitly approve before the document goes live. **Most KB quality bugs are bad parses caught too late.**

## Pitfalls

- LandingAI Parse v2 returns tables as HTML and page breaks as `<!-- PAGE BREAK -->` comments; both flow into chunks as text. Section-based chunking + grounding-based citation coordinates are documented follow-ons in `landingai-ade.md`, not wired up yet.
- Sync Parse is capped at **50 MiB / 100 pages per PDF**. Truenote's 20 MB upload cap fits the size bound; a >100-page PDF exceeds the page bound and currently surfaces as an ingestion failure (async Parse Jobs = submit+poll, deferred). Watch for it if long scanned manuals get uploaded.
- Don't run ingestion synchronously in the request handler. Use a background job (a simple `pg-boss` queue). LandingAI Parse can take 30s+ on a long PDF; `DOCUMENT_PARSE_TIMEOUT_MS` bounds it (default 120s, 2 retries with 429 backoff).
- Re-uploading a document creates a NEW version. Do not overwrite. The old version stays for audit / rollback.
- Scanner absence is never treated as clean. It intentionally quarantines every new upload until an approved scanner is configured.
- Blocking PII/secret findings stop before embeddings. Prompt-injection findings are non-blocking but require explicit reviewer acknowledgment; the generation prompt treats excerpts as untrusted data.
- Normal removal retires and preserves evidence. Revocation removes retrieval/citation access immediately. Permanent purge is super-user-only and retention-gated.
- Embedding cost is trivial but the OpenAI rate limit isn't — batch embed up to 100 chunks per request.
