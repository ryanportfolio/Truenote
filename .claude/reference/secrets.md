# Secrets & Environment Variables

Replit Secrets are the source of truth in production. `.env.example` documents what's needed locally.

## Required

| Var | Used for | Notes |
|---|---|---|
| `DATABASE_URL` | Neon Postgres (Replit-managed) | Must have `vector` and `pg_trgm` extensions enabled |
| `OPENROUTER_API_KEY` | Answer generation through the approved model-routing presets, plus the auxiliary utility calls (follow-up rewrite, session naming) pinned to the Granite 4.1 8B ZDR route | Assign key to the ZDR guardrail. Every request pins one provider, sends `provider.zdr=true`, denies data collection, and disables provider fallback. No direct answer-generation escape hatch exists. |
| `OPENAI_API_KEY` | Embeddings (`text-embedding-3-small`) and the opt-in eval judge | These direct utilities are outside OpenRouter's ZDR boundary; configure required retention controls on the OpenAI organization. They are never used as an answer-generation fallback. Follow-up rewrite and session naming moved to the OpenRouter ZDR utility (2026-07) and no longer touch this key. |
| `VISION_AGENT_API_KEY` | LandingAI ADE Parse v2 for document parsing (OCR + inline figure description) | Model `dpt-3-pro-latest`. ZDR is account-level (Team/Enterprise plan + Org-Settings toggle), NOT a request parameter — the key alone does not guarantee ZDR. |
| `COHERE_API_KEY` | Rerank v3 | Cuts irrelevant chunks from final LLM context |
| `BOOTSTRAP_SUPER_USER_EMAIL` | First-login seed | Used once on api-server startup to create the initial super_user if none exists. Idempotent. |
| `BOOTSTRAP_SUPER_USER_PASSWORD` | First-login seed | Forced reset on first login; env var unused thereafter. |

## P0/P1 production controls

| Var | Used for | Security behavior |
|---|---|---|
| `MALWARE_SCANNER_URL` | Organization-approved raw-byte malware scan | Operationally required for new ingestion. Unset/unavailable/insecure production URL quarantines; it never becomes an implicit clean verdict. |
| `MALWARE_SCANNER_TOKEN` / `MALWARE_SCANNER_HMAC_KEY` | Scanner request authentication | Configure the mechanism approved by the scanner owner. Never put either value in source or the review HTML. |
| `SIEM_WEBHOOK_URL` / `SIEM_WEBHOOK_SIGNING_KEY` | Signed one-way security-event export | Database event is written first. Production URL must be HTTPS. Current delivery is best-effort; durable outbox/retry is follow-on work. |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `OIDC_STATE_SECRET` | Enterprise OpenID Connect Authorization Code + PKCE | Configure all together. State secret is at least 32 characters. In production, issuer, redirect, discovery, token, and JWKS URLs must use HTTPS. |
| `OIDC_REQUIRE_MFA` / `OIDC_REQUIRED_ACR` / `OIDC_ALLOWED_DOMAINS` | IdP assurance and identity restrictions | MFA defaults on when OIDC is configured; verify the IdP emits `amr: ["mfa"]` or set an approved exact ACR. |
| `LOCAL_LOGIN_MODE` | `enabled`, `break_glass`, or `disabled` | Keep `enabled` through SSO smoke testing. Recommended steady state is `break_glass`, which permits local login only for super users. |
| `ASK_RATE_LIMIT_WINDOW_SECONDS`, `ASK_RATE_LIMIT_PER_USER`, `ASK_RATE_LIMIT_PER_PROGRAM` | Distributed Postgres-backed ask limits | Defaults: 60 seconds, 30/user, 300/program. Requires the reviewed P0/P1 DDL. |
| `ALLOW_RETENTION_OVERRIDE` | Emergency/legal purge before retention expiry | Default false. Do not enable without an approved process. |

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
| `MIN_PASSWORD_LENGTH` | Floor enforced by bootstrap and the change-password form (server-side zod + client UI mirror via `/api/config`). Read once at api-server startup; restart to apply. Enforced within `[15, 1024]`; out-of-range falls back to 15. | `15` |
| `RESEND_API_KEY` | Transactional email API key (resend.com). Used to send self-service password-reset links. **Both** this and `RESEND_FROM_EMAIL` must be set — otherwise the email layer falls back to a console logger that prints the link to stdout (useful for local dev, useless in production). | unset → console fallback |
| `RESEND_FROM_EMAIL` | Sender address for outgoing emails. Must be a verified Resend domain or `onboarding@resend.dev` for testing. | unset → console fallback |
| `APP_BASE_URL` | Public base URL used when constructing links in outgoing emails (e.g. `https://kbase.replit.app`). When unset we infer from `X-Forwarded-Proto` / `X-Forwarded-Host`, which works on Replit but is spoofable in unusual proxy setups. Set this explicitly for production. | unset → inferred from request headers |

## Pitfalls

- Never log API keys. Never echo `process.env.*_KEY` in error responses.
- Do not switch `LOCAL_LOGIN_MODE` to `break_glass` or `disabled` until OIDC and MFA claims pass a staged smoke test. The server refuses local lockout when OIDC is incomplete, but bad IdP claim mapping can still deny SSO.
- The scanner receives raw source bytes and the SIEM receives security-event metadata. Both endpoints and contracts require Security/vendor review before configuration.
- Embedding model is `text-embedding-3-small` (1536 dim). The `chunks.embedding VECTOR(1536)` column hardcodes that — changing models requires re-ingestion.
- LandingAI ADE Parse v2 takes a `multipart/form-data` upload (`document` field) via direct HTTP — no SDK, Node's global `fetch`/`FormData`/`Blob`. See `lib/parsing/landing-parse.ts` and `.claude/reference/landingai-ade.md`.
- Replit reserves port 5000 for the public webview, so on Replit `PORT=5000` (frontend) and `API_PORT=3001` (or any non-5000). The defaults in `.env.example` reflect this. Local-only dev can flip them back to the donor's `API_PORT=5000`/`PORT=5173` Express+Vite convention. See `.claude/reference/pitfalls.md`.
