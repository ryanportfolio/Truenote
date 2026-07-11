# Replit Handoff — Vite + Express pnpm Workspace

Four steps to bring the app alive on Replit, in order. Each section is a
**copy/paste prompt** for the Replit Agent.

> Per the project's CLAUDE.md, none of this can run in the Claude Code
> sandbox. Schema changes are raw DDL only — no `drizzle-kit push`, no
> production-migration language.

---

## Workspace layout (informational)

```
/                              ← pnpm workspace root
├── pnpm-workspace.yaml        ← packages + version catalog
├── package.json               ← workspace coordinator
├── tsconfig.base.json
├── .replit                    ← Replit run config (proxies, env)
├── artifacts/
│   ├── rag-app/               ← Vite + React frontend
│   └── api-server/            ← Express backend (routes, lib, db client)
├── lib/
│   └── db/                    ← Drizzle schema (shared types)
├── scripts/                   ← worker + seed (tsx)
└── .migration-backup/         ← frozen Next.js code (do not modify)
```

---

## A. Replit Agent install prompt

```
Please install dependencies for this pnpm workspace.

Run at the workspace root:

  pnpm install

This will install for every package in the workspace, including:

  artifacts/api-server/    — Express, drizzle-orm, pg, pg-boss, openai,
                             cohere-ai, mammoth, multer, zod, js-tiktoken,
                             @replit/object-storage
  artifacts/rag-app/       — react, react-dom, wouter, tailwindcss,
                             @vitejs/plugin-react, vite, lucide-react,
                             clsx, tailwind-merge, class-variance-authority,
                             tailwindcss-animate
  lib/db/                  — drizzle-orm
  scripts/                 — tsx, workspace deps

Do NOT run drizzle-kit push. The schema source-of-truth is the DDL below.
```

---

## B. Replit Agent DDL prompt

```
Ask the Replit agent to run this against the dev database (NOT prod —
Replit's publish flow will diff and promote on republish).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID REFERENCES programs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  current_version_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  source_url TEXT,
  mime_type TEXT,
  file_sha256 TEXT,
  parse_status TEXT DEFAULT 'pending',
  parsed_markdown TEXT,
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true
);
CREATE INDEX IF NOT EXISTS document_versions_sha_idx
  ON document_versions(file_sha256);

CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id UUID REFERENCES document_versions(id) ON DELETE CASCADE,
  program_id UUID NOT NULL,
  ordinal INT,
  content TEXT NOT NULL,
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding VECTOR(1536),
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx
  ON chunks USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS chunks_program_idx
  ON chunks (program_id);

CREATE TABLE IF NOT EXISTS query_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID,
  user_id TEXT,
  question TEXT NOT NULL,
  answer TEXT,
  cited_chunk_ids UUID[],
  refused BOOLEAN DEFAULT false,
  latency_ms INT,
  feedback INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eval_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID,
  question TEXT NOT NULL,
  expected_doc_id UUID,
  expected_answer_contains TEXT[],
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

After this completes successfully, do NOT run drizzle-kit. The schema
file under lib/db/src/schema.ts is for type-safe queries only — the DDL
above is canonical.
```

---

## B2. Replit Agent DDL prompt — Phase 2A (auth)

```
Ask the Replit agent to run this against the dev database. Idempotent;
safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('super_user', 'senior_manager', 'manager', 'csr');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 TEXT NOT NULL UNIQUE,
  password_hash         TEXT NOT NULL,
  role                  user_role NOT NULL,
  program_id            UUID REFERENCES programs(id) ON DELETE RESTRICT,
  name                  TEXT NOT NULL,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  must_reset_password   BOOLEAN NOT NULL DEFAULT true,
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT users_role_program_check CHECK (
    (role = 'super_user' AND program_id IS NULL)
    OR (role <> 'super_user' AND program_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS users_program_id_idx ON users(program_id);
CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);

CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
```

Notes on what this enforces:
- The `users_role_program_check` constraint is the security spine: a
  `super_user` MUST have `program_id IS NULL`; every other role MUST have
  a non-null `program_id`. The app code relies on this — if the constraint
  is missing, a manager row could be created with NULL program_id and
  silently pass scope checks.
- `email` is stored as lowercase `TEXT`; the application layer normalises
  all email values to lowercase before insert and lookup, so `Alice@foo.com`
  and `alice@foo.com` resolve to the same account without needing the
  `citext` extension.
- `sessions.token_hash` stores SHA-256 of the cookie token — a DB leak
  does not yield active sessions on its own.

---

## B3. Replit Agent DDL prompt — Phase 2C.1 (programs)

Ask the Replit agent to run this against the dev database (NOT prod —
Replit's publish flow will diff and promote on republish).

```sql
-- Phase 2C.1: enforce case-insensitive uniqueness on program names.
-- The api-server has an application-level pre-flight check too, but
-- two concurrent POSTs could race past it; this index makes the
-- duplicate impossible at the DB level. The route catches 23505 and
-- maps it to a 409 response.

CREATE UNIQUE INDEX IF NOT EXISTS programs_name_lower_uidx
  ON programs (lower(name));
```

After applying, restart `api-server`. The route still works without
the index (falls back to the pre-flight check, which has a narrow
TOCTOU window) — index landing is what closes the race.

---

## B4. Replit Agent DDL prompt — Phase 2.5 (password reset)

Ask the Replit agent to run this against the dev database. Idempotent;
safe to re-run.

```sql
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx
  ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_at_idx
  ON password_reset_tokens(expires_at);
```

After applying, install the `resend` npm package (see A2 below) and
restart `api-server`. Without the package OR without the
`RESEND_API_KEY` / `RESEND_FROM_EMAIL` env vars, the email layer
falls back to a console logger — fine for dev, useless in prod.

---

## A2. Replit Agent install prompt — Phase 2.5

```
Please install the following package in the api-server workspace:

  pnpm add -F @workspace/api-server resend@^4.0.0
```

The Resend SDK is dynamic-imported, so the api-server still boots
without the package — the failure only surfaces the first time an
email is dispatched. This keeps tests and the Claude Code sandbox
unblocked.

---

## A3. Replit Agent install prompt — Phase 1.5 (multer v2)

The api-server's `package.json` was bumped to `multer: ^2.0.0` and
`@types/multer: ^2.0.0`. The lockfile still pins the 1.x line, so a
`--frozen-lockfile` install would silently keep 1.x — explicitly
update both packages so the lockfile picks up 2.x:

```
At the workspace root, run:

  pnpm update -F @workspace/api-server multer @types/multer

Then commit the refreshed pnpm-lock.yaml.
```

Multer 2.x is API-compatible for our use case (`upload.single`
+ `memoryStorage` + `limits.fileSize`). The Replit deploy log is the
authoritative type-check — watch for any `tsc` errors after the
install completes.

---

## B5. Replit Agent DDL prompt — Phase 1.5 (storage cleanup index)

Ask the Replit agent to run this against the dev database. Idempotent;
safe to re-run.

```sql
-- The eager blob cleanup in DELETE /api/documents/:id runs a
-- "still-referenced?" lookup on document_versions.source_url for
-- every blob it considers deleting. Without this index the lookup
-- is a sequential scan once the table grows beyond a few hundred
-- versions. Adding it now is cheap (the column is sparse-cardinality
-- since most versions have distinct keys) and avoids surprise
-- degradation in delete latency.

CREATE INDEX IF NOT EXISTS document_versions_source_url_idx
  ON document_versions (source_url);
```

---

## B6. Replit Agent DDL prompt — model routing settings

Ask the Replit agent to run this against the dev database. Idempotent;
safe to re-run.

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value)
VALUES (
  'primary_generation_route',
  '{"selectedId":"gpt-5.6-luna-openai"}'::jsonb
)
ON CONFLICT (key) DO NOTHING;
```

After applying, restart `api-server`. Until this table exists, answer
generation safely uses GPT-5.6 Luna on OpenAI at low reasoning, but the
super-user Model routing page cannot persist changes.

---

## C. Replit Secrets checklist

Set these in Replit Secrets (Tools → Secrets). The app reads them via
`process.env.*` at runtime.

| Secret | How to obtain |
|---|---|
| `DATABASE_URL` | Replit's database tab (Neon-backed Postgres). Must be the same DB the DDL above ran against. |
| `OPENROUTER_API_KEY` | openrouter.ai → API keys. Used by the approved primary routes selected on the super-user Model routing page; assign the key to the ZDR guardrail shown in OpenRouter. Requests also enforce ZDR explicitly. |
| `OPENAI_API_KEY` | platform.openai.com → API keys. Used for embeddings (`text-embedding-3-small`), vision/utility calls, and backup answer generation (`gpt-5.6-luna` with low reasoning). OpenRouter's ZDR guardrail does not cover this direct fallback; configure required retention controls on the OpenAI organization too. |
| `MISTRAL_API_KEY` | console.mistral.ai → API keys. Used for `mistral-ocr-latest`. |
| `COHERE_API_KEY` | dashboard.cohere.com → API keys. Trial key works for Phase 1. Used for `rerank-english-v3.0`. |
| `BOOTSTRAP_SUPER_USER_EMAIL` | Email for the first super_user. Read once at startup; if no active super_user exists in the DB, one is created with these credentials. Idempotent — leaving the value in place after first login has no effect (existing super_user is left as-is). |
| `BOOTSTRAP_SUPER_USER_PASSWORD` | Password for the first super_user. The user is forced to change it on first login. After the change, this env var is unused. |
| `BOOTSTRAP_SUPER_USER_NAME` | *(optional)* Display name. Defaults to `Super User`. |
| `REPLIT_OBJECT_STORAGE_BUCKET` | Replit auto-injects this when you provision Object Storage from the tools panel. If you skip provisioning, the upload form will fail at runtime with a clear error. |

Optional tunables (defaults shown):

| Secret | Default | Effect |
|---|---|---|
| `RERANK_CONFIDENCE_THRESHOLD` | `0.3` | Top reranker score below this → refusal without LLM call. |
| `RETRIEVAL_TOP_K` | `8` | Chunks passed to the LLM after reranking. |
| `RETRIEVAL_CANDIDATE_K` | `40` | Candidates pulled from each of vector + BM25 before reranking. |
| `API_PORT` | `5000` | Express server port (also set in `.replit`). |
| `PORT` | `5173` | Vite dev server port. |
| `CORS_ALLOWED_ORIGINS` | unset | Comma-separated origin allowlist for cross-origin requests with credentials. Leave unset in the standard Replit topology (same-origin) — only set if running the SPA on a separate origin (e.g., dev tooling). |
| `RESEND_API_KEY` | unset | Transactional email key for password resets. Both this and `RESEND_FROM_EMAIL` must be set; otherwise the email layer logs to stdout instead of sending. |
| `RESEND_FROM_EMAIL` | unset | Sender address (must be a verified Resend domain, or `onboarding@resend.dev` for testing). |
| `APP_BASE_URL` | unset → infer | Public origin embedded in outgoing email links. Set explicitly for production; falls back to `X-Forwarded-Proto` / `X-Forwarded-Host` when unset. |

---

## D. After install + DDL + secrets

```
Optional: seed the demo program (idempotent).
  pnpm --filter @workspace/scripts run seed

Start the Express api-server:
  pnpm --filter @workspace/api-server run dev

In a second process, start the Vite frontend (proxies /api → api-server):
  pnpm --filter @workspace/rag-app run dev

In a third process (separate Replit run target or background slot),
start the ingestion worker:
  pnpm --filter @workspace/scripts run worker

Then in the browser:
  /chat              → CSR ask UI (uses the seeded demo program scope)
  /admin/documents   → admin upload UI

The api-server listens on API_PORT (default 5000). The Vite dev server
listens on PORT (default 5173) and proxies /api/* to API_PORT. In a
production deploy, the same /api paths are served by Replit's reverse
proxy — no front-end env var needed.
```

Watch the Replit deploy log for any `tsc` errors — they're the
authoritative type-check for this codebase. See `.migration-backup/PHASE_1_STATUS.md`
for the Phase 1 risk register from the Next.js era.
