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

## C. Replit Secrets checklist

Set these in Replit Secrets (Tools → Secrets). The app reads them via
`process.env.*` at runtime.

| Secret | How to obtain |
|---|---|
| `DATABASE_URL` | Replit's database tab (Neon-backed Postgres). Must be the same DB the DDL above ran against. |
| `OPENAI_API_KEY` | platform.openai.com → API keys. One key, used for both embeddings (`text-embedding-3-small`) and generation (`gpt-4o`). |
| `MISTRAL_API_KEY` | console.mistral.ai → API keys. Used for `mistral-ocr-latest`. |
| `COHERE_API_KEY` | dashboard.cohere.com → API keys. Trial key works for Phase 1. Used for `rerank-english-v3.0`. |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32`. Phase 2 (auth not wired yet in Phase 1, but set this now to avoid a surprise later). |
| `NEXTAUTH_URL` | Your Replit deploy URL (e.g. `https://<replname>.<owner>.repl.co`). |
| `REPLIT_OBJECT_STORAGE_BUCKET` | Replit auto-injects this when you provision Object Storage from the tools panel. If you skip provisioning, the upload form will fail at runtime with a clear error. |

Optional tunables (defaults shown):

| Secret | Default | Effect |
|---|---|---|
| `RERANK_CONFIDENCE_THRESHOLD` | `0.3` | Top reranker score below this → refusal without LLM call. |
| `RETRIEVAL_TOP_K` | `8` | Chunks passed to the LLM after reranking. |
| `RETRIEVAL_CANDIDATE_K` | `40` | Candidates pulled from each of vector + BM25 before reranking. |
| `API_PORT` | `5000` | Express server port (also set in `.replit`). |
| `PORT` | `5173` | Vite dev server port. |

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
