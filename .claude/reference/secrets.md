# Secrets & Environment Variables

Replit Secrets are the source of truth in production. `.env.example` documents what's needed locally.

## Required

| Var | Used for | Notes |
|---|---|---|
| `DATABASE_URL` | Neon Postgres (Replit-managed) | Must have `vector` and `pg_trgm` extensions enabled |
| `OPENROUTER_API_KEY` | Plain-text answer generation through the approved model-routing presets | Assign key to the ZDR guardrail. Every request pins one provider, sends `provider.zdr=true`, denies data collection, and disables provider fallback. No direct answer-generation escape hatch exists. |
| `OPENAI_API_KEY` | Embeddings (`text-embedding-3-small`), follow-up rewrite, session naming, and the opt-in eval judge | These direct utilities are outside OpenRouter's ZDR boundary; configure required retention controls on the OpenAI organization. They are never used as an answer-generation fallback. |
| `VISION_AGENT_API_KEY` | LandingAI ADE Parse v2 for document parsing (OCR + inline figure description) | Model `dpt-3-pro-latest`. ZDR is account-level (Team/Enterprise plan + Org-Settings toggle), NOT a request parameter — the key alone does not guarantee ZDR. |
| `COHERE_API_KEY` | Rerank v3 | Cuts irrelevant chunks from final LLM context |
| `BOOTSTRAP_SUPER_USER_EMAIL` | First-login seed | Used once on api-server startup to create the initial super_user if none exists. Idempotent. |
| `BOOTSTRAP_SUPER_USER_PASSWORD` | First-login seed | Forced reset on first login; env var unused thereafter. |

## Optional

| Var | Used for | Default |
|---|---|---|
| `DEMO_LOGIN_ACCOUNTS` | Demo deployments only: JSON account list the login page pre-fills. PUBLISHED via unauthenticated /api/config (deliberate); users bootstrapped at startup with must_reset_password=false; roles capped at manager. Never set where real content lives. | unset → no demo mode |
| `RERANK_CONFIDENCE_THRESHOLD` | Refusal gate — if top reranker score is below this, refuse. MUST be retuned (via eval) whenever `COHERE_RERANK_MODEL` changes | `0.3` |
| `COHERE_RERANK_MODEL` | Cohere rerank model. Upgrade (e.g. `rerank-v3.5`) is eval-gated — see retrieval.md | `rerank-english-v3.0` |
| `RETRIEVAL_TOP_K` | Final chunks sent to LLM after reranking | `8` |
| `RETRIEVAL_CANDIDATE_K` | Candidates pulled from vector + BM25 before reranking | `40` each |
| `RETRIEVAL_NEIGHBOR_ANCHORS` | Top reranked chunks whose ordinal ±1 siblings are appended as unscored context. `0` disables neighbor expansion | `3` |
| `RAG_STORAGE_DRIVER` | Set to `memory` to use the in-memory adapter (local scripts / tests). Any other value (or unset) selects Replit Object Storage | unset → Replit SDK |
| `BOOTSTRAP_SUPER_USER_NAME` | Display name for the bootstrap super_user | `Super User` |
| `CORS_ALLOWED_ORIGINS` | Comma-separated origin allowlist for cross-origin credentialed requests. Leave unset for same-origin Replit deploys. | unset → no cross-origin |
| `MIN_PASSWORD_LENGTH` | Floor enforced by the change-password form (server-side zod + client UI mirror via `/api/config`). Read once at api-server startup; restart to apply. Clamped to `[1, 1024]`; out-of-range falls back to default. | `3` (dev-friendly; tighten for prod) |
| `RESEND_API_KEY` | Transactional email API key (resend.com). Used to send self-service password-reset links. **Both** this and `RESEND_FROM_EMAIL` must be set — otherwise the email layer falls back to a console logger that prints the link to stdout (useful for local dev, useless in production). | unset → console fallback |
| `RESEND_FROM_EMAIL` | Sender address for outgoing emails. Must be a verified Resend domain or `onboarding@resend.dev` for testing. | unset → console fallback |
| `APP_BASE_URL` | Public base URL used when constructing links in outgoing emails (e.g. `https://kbase.replit.app`). When unset we infer from `X-Forwarded-Proto` / `X-Forwarded-Host`, which works on Replit but is spoofable in unusual proxy setups. Set this explicitly for production. | unset → inferred from request headers |

## Pitfalls

- Never log API keys. Never echo `process.env.*_KEY` in error responses.
- Embedding model is `text-embedding-3-small` (1536 dim). The `chunks.embedding VECTOR(1536)` column hardcodes that — changing models requires re-ingestion.
- LandingAI ADE Parse v2 takes a `multipart/form-data` upload (`document` field) via direct HTTP — no SDK, Node's global `fetch`/`FormData`/`Blob`. See `lib/parsing/landing-parse.ts` and `.claude/reference/landingai-ade.md`.
- Replit reserves port 5000 for the public webview, so on Replit `PORT=5000` (frontend) and `API_PORT=3001` (or any non-5000). The defaults in `.env.example` reflect this. Local-only dev can flip them back to the donor's `API_PORT=5000`/`PORT=5173` Express+Vite convention. See `.claude/reference/pitfalls.md`.
