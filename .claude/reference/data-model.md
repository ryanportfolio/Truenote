# Data Model

> Postgres on Replit (Neon). `vector` and `pg_trgm` extensions required.

## Core tables

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID REFERENCES programs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  current_version_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  source_url TEXT,
  mime_type TEXT,
  file_sha256 TEXT,
  parse_status TEXT DEFAULT 'pending',  -- pending|parsing|ready|failed
  parsed_markdown TEXT,
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true
);
CREATE INDEX document_versions_sha_idx ON document_versions(file_sha256);

CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id UUID REFERENCES document_versions(id) ON DELETE CASCADE,
  program_id UUID NOT NULL,  -- DENORMALIZED for fast scoping
  ordinal INT,
  content TEXT NOT NULL,
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding VECTOR(1536),
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_tsv_idx ON chunks USING gin (content_tsv);
CREATE INDEX chunks_program_idx ON chunks (program_id);

-- Chat session grouping for CSR history (added 2026-07-05). Auto-named
-- (gpt-4o-mini) server-side from the opening exchange; title NULL until named.
CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL,
  user_id TEXT NOT NULL,          -- matches query_log.user_id (app user id as text)
  title TEXT,                     -- NULL until the auto-namer runs
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()  -- bumped per exchange; history sorts on this
);
CREATE INDEX chat_sessions_user_program_idx ON chat_sessions (user_id, program_id);

CREATE TABLE query_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID,
  user_id TEXT,
  question TEXT NOT NULL,
  answer TEXT,
  cited_chunk_ids UUID[],
  refused BOOLEAN DEFAULT false,
  latency_ms INT,
  feedback INT,  -- -1, 0, +1
  flagged_missing BOOLEAN DEFAULT false,  -- CSR flagged a refusal as missing content (added 2026-07-04)
  session_id UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,  -- groups a conversation (added 2026-07-05); SET NULL preserves ops rows
  citation_snapshots JSONB NOT NULL DEFAULT '[]'::jsonb,  -- immutable ordered source receipts (added 2026-07-11)
  timing_breakdown JSONB,  -- versioned per-stage/provider ask timing; super-user observability (added 2026-07-11)
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX query_log_session_idx ON query_log (session_id);

CREATE TABLE error_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity TEXT NOT NULL CHECK (severity IN ('warning','error','fatal')),
  source TEXT NOT NULL,
  operation TEXT NOT NULL,
  message TEXT NOT NULL,
  name TEXT,
  stack TEXT,
  code TEXT,
  status INT,
  provider TEXT,
  model TEXT,
  route_id TEXT,
  request_id TEXT,
  correlation_id TEXT,
  method TEXT,
  path TEXT,
  user_id TEXT,
  program_id UUID,
  query_log_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX error_log_occurred_idx ON error_log (occurred_at DESC);
CREATE INDEX error_log_source_occurred_idx ON error_log (source, occurred_at DESC);

CREATE TABLE eval_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID,
  question TEXT NOT NULL,
  expected_doc_id UUID,
  expected_answer_contains TEXT[],
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

```

## Auth tables (Phase 2A)

```sql
CREATE TYPE user_role AS ENUM ('super_user', 'senior_manager', 'manager', 'csr');

CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 TEXT NOT NULL UNIQUE,                        -- normalized lowercase at app layer
  password_hash         TEXT NOT NULL,                              -- argon2id
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
CREATE INDEX users_program_id_idx ON users(program_id);
CREATE INDEX users_role_idx ON users(role);

CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,                               -- SHA-256 of cookie token
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE password_reset_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,                                -- SHA-256 of emailed token
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,                                         -- NULL = unused
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens(user_id);
CREATE INDEX password_reset_tokens_expires_at_idx ON password_reset_tokens(expires_at);

-- Global operator settings. Values remain JSONB so new allowlisted settings
-- do not require one table per setting; the application owns validation.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Durable super-user Evaluation Center jobs. Created after users because
-- requested_by is an auth-table FK. Full EvalReport lives in report; list
-- queries project report->'summary' so history stays lightweight.
CREATE TABLE eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  question_id UUID REFERENCES eval_questions(id) ON DELETE SET NULL,
  judge BOOLEAN NOT NULL DEFAULT false,
  question_count INT NOT NULL DEFAULT 0,
  completed_questions INT NOT NULL DEFAULT 0,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  report JSONB,
  error TEXT,
  is_baseline BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX eval_runs_program_created_idx ON eval_runs (program_id, created_at DESC);
CREATE UNIQUE INDEX eval_runs_program_active_uidx ON eval_runs (program_id)
  WHERE status IN ('queued','running');
CREATE UNIQUE INDEX eval_runs_program_baseline_uidx ON eval_runs (program_id)
  WHERE is_baseline = true;
```

## Invariants

- **`chunks.program_id` is denormalized** from `document_versions → documents → programs`. This is intentional. Retrieval queries filter on it directly to avoid joining at query time.
- **A document has many versions.** Re-uploading does NOT update the existing row — it creates a new `document_versions` row and flips `is_active`.
- **Only chunks from `is_active=true` versions are searched.** Inactive versions stay for audit / rollback.
- **`embedding VECTOR(1536)` is locked to `text-embedding-3-small`.** Changing embedding model = re-ingest everything.
- **`users.role` + `users.program_id` are jointly constrained.** The DB CHECK enforces: `super_user` MUST have `program_id IS NULL`; every other role MUST have a non-null `program_id`. The app's program-scoping helpers (`canAccessProgram`, `requireRole`) rely on this. Bypassing the constraint at the SQL level (e.g., manual inserts) breaks the assumption that a manager always has a program scope.
- **`sessions.token_hash` stores SHA-256 of the cookie value, not the cookie itself.** A leak of the sessions table does not yield active sessions on its own. Plaintext tokens are only ever in transit (cookie header) and in the cookie store on the user's browser.
- **`chat_sessions` groups a CSR's `query_log` rows into a named conversation.** `query_log.session_id` is nullable with `ON DELETE SET NULL` — deleting a session must never drop ops/gap analytics rows. Sessions are scoped by `(user_id, program_id)`; the ask pipeline honors a client-supplied session id only when both match, so a leaked id can't stitch one user's ask into another's conversation or cross program scope. `title` is auto-generated (gpt-4o-mini) from the opening exchange, detached from the response path, guarded by `title IS NULL` so it fires once.
- **`query_log.citation_snapshots` freezes source receipts.** New answers best-effort persist the ordered document id, document-version id/number, clean excerpt, and raw parsed-Markdown offsets after logging. History prefers this snapshot over live chunks, so a re-ingest cannot silently rewrite an old answer's evidence. Missing DDL degrades to legacy live-chunk reconstruction; it never fails an ask.
- **`query_log.timing_breakdown` is versioned best-effort telemetry.** New asks persist end-to-end, retrieval sub-stage, finalization, and provider-attempt timings as JSONB for the super-user `/admin/observability` surface. Missing DDL never fails an ask; the dashboard shows setup-required and `latency_ms` continues to update.
- **`error_log` stores redacted operator diagnostics, not raw secrets.** Provider/API/worker failures retain exact status, code, request id, message, stack, provider response, and structured context after recursive credential redaction. Writes are best-effort so a missing table or database outage never replaces the original failure; the super-user `/admin/errors` API is the only read surface.
- **`eval_runs` is the durable job + report boundary.** At most one queued/running row exists per program; the shared pg-boss worker consumes evaluation jobs sequentially. The row is also the queue outbox: its UUID is a time-windowed pg-boss singleton key and queued rows are reconciled after insert/send crashes. `configuration` privately retains the immutable question snapshot and current lease token (both stripped from list responses), while the public configuration records effective model/retrieval settings; every worker write is lease-fenced. `report` freezes per-question results. Only completed rows may be baselines; cancellation fences work by moving an active row to `failed` with an explicit cancellation reason.
- **`users.email` is normalized to lowercase at the application layer**, stored as plain `TEXT`. Every write and lookup calls `.toLowerCase()` before touching the DB. The original Phase 2A design used `citext` for case-insensitive comparison, but the `citext` extension isn't available in all managed Postgres environments (specifically: Replit's production publish flow does not run `CREATE EXTENSION`, only DDL diff). The app-layer normalization preserves the case-insensitive contract without the extension dependency. **Detection rule:** any new code path that writes or compares `users.email` MUST lowercase first — otherwise duplicate accounts can be created (`Alice@foo.com` vs `alice@foo.com`) and logins will silently mismatch.
- **Bulk CSV user import creates CSR accounts only.** Emails are normalized and deduplicated, existing accounts are skipped without mutation, and the effective program is enforced server-side. Each new user is stored with a separately salted hash of an *unguessable random throwaway* password (never revealed to anyone) and `must_reset_password=true`, then emailed a one-time invite link (a `password_reset_tokens` row with the 7-day `INVITE_TOKEN_DURATION_MS` lifetime) to set their own password via the existing `/reset-password` page. No plaintext password is returned to the admin. The bulk route refuses up-front (creating nothing) if delivery is unconfigured in production (`APP_BASE_URL` unset, or `RESEND_API_KEY`/`RESEND_FROM_EMAIL` unset), so it never mints accounts no one can reach. Single-user create + admin password-reset still return a one-time temp password in-response (shown once in the admin UI) — only bulk uses the invite-email path.
- **`app_settings` never authorizes arbitrary model ids or providers.** The model-routing API accepts only ids from the server-owned allowlist; the JSONB row stores an ordered list of approved preset ids (the fallback chain, `{"order":[...]}`), not an executable request body. Unknown or removed ids are dropped and missing approved routes appended on read, so the resolved chain is always a permutation of the ZDR allowlist. The legacy single-id shape (`{"selectedId":"..."}`) is still read-compatible. Missing table/row/invalid value falls back to the default order (Nemotron 3 Super primary).

## Schema change protocol

Claude Code cannot run migrations. For any schema change: write raw DDL only, hand it to the user for the Replit Agent. No `drizzle-kit push`, no `shared/schema.ts` edits in the same task. See CLAUDE.md → "Database Schema Changes."
