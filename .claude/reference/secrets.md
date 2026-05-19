# Secrets & Environment Variables

Replit Secrets are the source of truth in production. `.env.example` documents what's needed locally.

## Required

| Var | Used for | Notes |
|---|---|---|
| `DATABASE_URL` | Neon Postgres (Replit-managed) | Must have `vector` and `pg_trgm` extensions enabled |
| `OPENAI_API_KEY` | Embeddings (`text-embedding-3-small`) and generation (`gpt-4o`) | One key, two uses |
| `MISTRAL_API_KEY` | Mistral OCR for document parsing | `mistral-ocr-latest` |
| `COHERE_API_KEY` | Rerank v3 | Cuts irrelevant chunks from final LLM context |
| `NEXTAUTH_SECRET` | Session signing | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | OAuth callback base | Replit deploy URL in prod |

## Optional

| Var | Used for | Default |
|---|---|---|
| `RERANK_CONFIDENCE_THRESHOLD` | Refusal gate — if top reranker score is below this, refuse | `0.3` |
| `RETRIEVAL_TOP_K` | Final chunks sent to LLM after reranking | `8` |
| `RETRIEVAL_CANDIDATE_K` | Candidates pulled from vector + BM25 before reranking | `40` each |
| `RAG_STORAGE_DRIVER` | Set to `memory` to use the in-memory adapter (local scripts / tests). Any other value (or unset) selects Replit Object Storage | unset → Replit SDK |

## Pitfalls

- Never log API keys. Never echo `process.env.*_KEY` in error responses.
- Embedding model is `text-embedding-3-small` (1536 dim). The `chunks.embedding VECTOR(1536)` column hardcodes that — changing models requires re-ingestion.
- Mistral OCR uses base64 file upload OR a URL. Prefer base64 for uploaded files to avoid signed-URL plumbing.
- Replit reserves port 5000 for the public webview, so on Replit `PORT=5000` (frontend) and `API_PORT=3001` (or any non-5000). The defaults in `.env.example` reflect this. Local-only dev can flip them back to the donor's `API_PORT=5000`/`PORT=5173` Express+Vite convention. See `.claude/reference/pitfalls.md`.
