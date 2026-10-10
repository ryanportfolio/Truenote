# Data Model

> Postgres 18 on Railway (`pgvector` service). `vector`, `pg_trgm` and `pgcrypto` extensions required.

## Core tables

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Ledger of applied lib/db/sql files (lib/db/sql/0001_schema_migrations.sql,
-- applied 2026-10-07). scripts/railway-apply-sql.mjs writes one row per file
-- and refuses a file already recorded.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

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
-- (Mercury 2.5 via the OpenRouter ZDR utility) server-side from the
-- opening exchange; title NULL until named.
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
  created_at TIMESTAMPTZ DEFAULT now(),
  -- Held-out flag, lib/db/sql/0002_eval_questions_is_protected.sql (applied
  -- 2026-10-08). See eval.md, "Protected (held-out) questions".
  is_protected BOOLEAN NOT NULL DEFAULT false
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

## Sign-in tables (0011-0013)

Lockout columns, SSO identity bindings and emergency-login second factors, from `lib/db/sql/0011_login_lockout.sql`, `0012_user_identities.sql` and `0013_break_glass_mfa.sql` (apply order and release steps: `deployment.md`, "SSO and emergency sign-in release (2026-10-10)"). `sessions.auth_method` (`'local'` or `'oidc'`, CHECK `sessions_auth_method_check`) and `sessions.auth_time` came earlier, from the P0/P1 DDL in the baseline.

```sql
-- 0011. Consecutive failed local sign-in attempts since the last success or
-- lock; reset to 0 when the account locks. locked_until is NULL for an
-- account that was never locked.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0
    CONSTRAINT users_failed_login_count_check CHECK (failed_login_count >= 0);
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS locked_until timestamp with time zone;

-- 0012. One row ties a user to an IdP account (token iss + sub).
CREATE TABLE user_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  tenant_id text,          -- Entra `tid`, kept for investigation only
  object_id text,          -- Entra `oid`, kept for investigation only
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  CONSTRAINT user_identities_issuer_subject_key UNIQUE (issuer, subject),
  CONSTRAINT user_identities_user_issuer_key UNIQUE (user_id, issuer)
);

-- 0013. Passkeys, recovery codes and pending WebAuthn challenges.
CREATE TABLE user_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL,           -- base64url credential ID
  public_key bytea NOT NULL,             -- COSE public key
  sign_count bigint NOT NULL DEFAULT 0,  -- CHECK (sign_count >= 0)
  transports text[],
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT user_passkeys_credential_id_key UNIQUE (credential_id)
);
CREATE INDEX user_passkeys_user_id_idx ON user_passkeys (user_id);

CREATE TABLE user_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,               -- SHA-256 hex of the normalized code
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,                   -- NULL = unused
  CONSTRAINT user_recovery_codes_code_hash_key UNIQUE (code_hash)
);
CREATE INDEX user_recovery_codes_user_id_idx ON user_recovery_codes (user_id);

CREATE TABLE mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL,                 -- CHECK purpose IN ('login', 'register')
  challenge text NOT NULL,
  token_hash text,                       -- login rows: SHA-256 of the MFA cookie token
  expires_at timestamptz NOT NULL,       -- 5 minutes after creation
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mfa_challenges_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX mfa_challenges_user_id_idx ON mfa_challenges (user_id);
CREATE INDEX mfa_challenges_expires_at_idx ON mfa_challenges (expires_at);
```

Who reads and writes them (all under `artifacts/api-server/src/`):

- `users.failed_login_count`, `users.locked_until`: `lib/auth/lockout.ts`. A failure is one `UPDATE ... RETURNING` that either adds 1 or, on reaching `LOGIN_LOCKOUT_THRESHOLD`, resets the count to 0 and sets `locked_until`; it skips accounts whose lock is still in force. A success clears both. `routes/auth.ts` (`POST /login`) and `routes/mfa.ts` read `locked_until` and refuse a locked account before checking the credential. Demo accounts are never counted or locked.
- `user_identities`: `lib/auth/identities.ts`, called from the OIDC callback in `routes/oidc.ts`. The first SSO login of an active user matches the account by email and inserts the row and its `auth.oidc.identity_linked` security event in one transaction (`ON CONFLICT DO NOTHING`; either unique key already held → refused). Later logins find the user by `(issuer, subject)` only, ignore the token's email, and update `last_login_at`.
- `user_passkeys`: `lib/auth/mfa.ts` lists a user's passkeys after a correct password at `POST /api/auth/login`; any passkey starts the second step. `routes/mfa.ts` inserts and deletes rows (a signed-in `super_user`, own account, current password required) and updates `sign_count` and `last_used_at` after each verified assertion.
- `user_recovery_codes`: `lib/auth/recovery-codes.ts`. Generating a set deletes the user's old rows and inserts 10 new hashes in one transaction; the plaintext is returned once. Using a code sets `used_at` in the same transaction that consumes the login challenge, so a code is spent only if the challenge is.
- `mfa_challenges`: `lib/auth/mfa.ts`. A `login` row is created after the password verifies and found by `token_hash` from the httpOnly `truenote_mfa` cookie (path `/api/auth/mfa`); a `register` row (no `token_hash`) belongs to a super user adding a passkey. Both are consumed once with `UPDATE ... SET consumed_at = now() WHERE consumed_at IS NULL AND expires_at > now()`. Nothing deletes consumed or expired rows; they stay until the user is deleted.

Only `users.failed_login_count`, `users.locked_until`, `sessions.auth_method` and `sessions.auth_time` are bound in `lib/db/src/schema.ts`. The four new tables are not; the code above queries them with raw SQL. Every new table cascades on user delete, and 0012 and 0013 grant `truenote_app` SELECT, INSERT, UPDATE, DELETE.

## Invariants

- **`chunks.program_id` is denormalized** from `document_versions → documents → programs`. This is intentional. Retrieval queries filter on it directly to avoid joining at query time.
- **A document has many versions.** Re-uploading does NOT update the existing row. It creates a `submitted` version. Senior-manager and super-user uploads activate after ingestion controls pass; other uploads require authorized review. Activation retires the predecessor.
- **Search requires three controls.** Retrieval and KB reads require `is_active=true`, `lifecycle_state='active'`, and classification at or below the server-resolved user's `max_classification`. Inactive/retired versions stay for audit and citation receipts; revoked/rejected versions cannot be served through history.
- **P0/P1 controlled-ingestion columns live in reviewed raw DDL.** `docs/security/p0-p1-security-controls.sql` adds `content_sources`, document/version lifecycle, classification, provenance, scan evidence, approval/revocation/retention, user clearance, session auth evidence, distributed rate limits, and hash-chained `security_events`. This DDL (with `append_security_event` and its constraints) is present on Railway through the 2026-10-07 copy of the Replit database. The copy lacked the file's append-only guard and its document-version and content-source audit triggers; `lib/db/sql/0008` and `0009` installed them on 2026-10-09 (0008 also blocks TRUNCATE). The application connects as `truenote_app`, which can read `security_events` and write it only through `append_security_event` (`0007`, `deployment.md` "Database roles"). Full production verification of the remaining controls is still pending (`docs/security/README.md`). The columns are not bound in `lib/db/src/schema.ts`, and routes intentionally use parameterized raw SQL for them. Do not add them to `schema.ts` as a side task.
- **SIEM delivery is designed as a database-triggered outbox, and only half of it is on Railway.** `docs/security/p1-siem-delivery-outbox.sql` creates one `siem_delivery_outbox` row for every `security_events` insert in the same transaction and backfills existing events. Claims use `FOR UPDATE SKIP LOCKED`, bounded leases, and per-claim tokens; only the matching token may complete or retry a row. On Railway (checked 2026-10-07) the `siem_delivery_outbox` table exists with 0 rows against 179 `security_events`, but the functions (`enqueue_security_event_for_siem`, `claim_siem_deliveries`, `complete_siem_delivery`, `fail_siem_delivery`, `get_siem_delivery_health`) and the `security_events_siem_enqueue` trigger are absent. Railway inherited this state from Replit, whose Publish step omitted them. `SIEM_WEBHOOK_URL` is unset, so nothing fails today, but the control is not in place and enabling SIEM delivery would fail until the rest of the file is applied.

  **Deferred until a SIEM receiver exists (owner decision, 2026-10-08).** Applying the rest without a receiver delivers nothing and costs:
  - The trigger backfills every existing event and then queues one row per new event, and nothing drains or deletes them.
  - The outbox's `ON DELETE RESTRICT` foreign key blocks deleting `security_events` (a demo-data wipe) until the outbox is emptied first.
  - Every security event write gains a second insert in the same transaction; if that insert fails, the event is not recorded.
  - `get_siem_delivery_health()` would report a backlog that only ages.
  - An installed trigger reads as SIEM delivery being in place, which PCI or FedRAMP evidence must not claim without a receiver.

  Apply it in the same change that sets `SIEM_WEBHOOK_URL`, as one transaction. The source file grants EXECUTE on the four delivery functions `TO CURRENT_USER`, which under `scripts/railway-apply-sql.mjs` is `postgres`; the numbered copy grants them to `truenote_app`, the role `web` and `worker` connect as (`deployment.md`, "Database roles"). The file is about 10 KB, more than `scripts/railway-apply-sql.mjs` sends in one call (6,500 base64 characters, about 2.7 KB of SQL). Do not split it into several files: a failure partway would leave the trigger without its functions. It ships as one `lib/db/sql/NNNN` file with the source file's own `BEGIN`/`COMMIT` removed, so the apply script owns the transaction, and it waits for the script change described in `deployment.md` ("Schema changes") that applies a file over the size cap without losing the checksum check, lock or ledger row.
- **`embedding VECTOR(1536)` is locked to `text-embedding-3-small`.** Changing embedding model = re-ingest everything.
- **`users.role` + `users.program_id` are jointly constrained.** The DB CHECK enforces: `super_user` MUST have `program_id IS NULL`; every other role MUST have a non-null `program_id`. The app's program-scoping helpers (`canAccessProgram`, `requireRole`) rely on this. Bypassing the constraint at the SQL level (e.g., manual inserts) breaks the assumption that a manager always has a program scope.
- **`sessions.token_hash` stores SHA-256 of the cookie value, not the cookie itself.** A leak of the sessions table does not yield active sessions on its own. Plaintext tokens are only ever in transit (cookie header) and in the cookie store on the user's browser.
- **`chat_sessions` groups a CSR's `query_log` rows into a named conversation.** `query_log.session_id` is nullable with `ON DELETE SET NULL`: deleting a session must never drop ops/gap analytics rows. Sessions are scoped by `(user_id, program_id)`; the ask pipeline honors a client-supplied session id only when both match, so a leaked id can't stitch one user's ask into another's conversation or cross program scope. `title` is auto-generated (Mercury 2.5 via the OpenRouter ZDR utility, `lib/generation/name-session.ts`) from the opening exchange, detached from the response path, guarded by `title IS NULL` so it fires once.
- **`query_log.citation_snapshots` freezes source receipts.** New answers best-effort persist the ordered document id, document-version id/number, clean excerpt, and raw parsed-Markdown offsets after logging. History prefers this snapshot over live chunks, so a re-ingest cannot silently rewrite an old answer's evidence. Missing snapshot DDL permits legacy live-chunk reconstruction; snapshot persistence failure never fails an ask. History reads require complete current authorization before releasing an exchange: current clearance, matching document/source program, active document and approved active source, no source retirement or version revocation, and an eligible version state. Every citation must resolve through complete ordered receipts or authorized current legacy chunks; partial evidence withholds the whole question, answer, and sources. Only active/current versions or explicitly retired/inactive durable receipts qualify, with retired receipts marked superseded. Zero-citation exchanges, including refusals, are withheld because their question/title provenance cannot be established. Titles are generated from the opening exchange, so a title is null unless that exchange is released and every other withheld exchange is an uncited refusal (fixed refusal text only). The session list leaves out sessions with no released exchange. Lookup failures return no protected history; this read policy does not erase stored question/answer text. These October 9 fixes have local focused verification, not Railway release evidence: `docs/security/security-access-fix-verification-2026-10-09.md`.
- **`query_log.timing_breakdown` is versioned best-effort telemetry.** New asks persist end-to-end, retrieval sub-stage, finalization, and provider-attempt timings as JSONB for the super-user `/admin/observability` surface. Missing DDL never fails an ask; the dashboard shows setup-required and `latency_ms` continues to update.
- **`error_log` stores redacted operator diagnostics, not raw secrets.** Provider/API/worker failures retain exact status, code, request id, message, stack, provider response, and structured context after recursive credential redaction. Writes are best-effort so a missing table or database outage never replaces the original failure; the super-user `/admin/errors` API is the only read surface.
- **`eval_runs` is the durable job + report boundary.** At most one queued/running row exists per program; the shared pg-boss worker consumes evaluation jobs sequentially. The row is also the queue outbox: its UUID is a time-windowed pg-boss singleton key and queued rows are reconciled after insert/send crashes. `configuration` privately retains the immutable question snapshot and current lease token (both stripped from list responses), while the public configuration records effective model/retrieval settings; every worker write is lease-fenced. `report` freezes per-question results. Only completed rows may be baselines; cancellation fences work by moving an active row to `failed` with an explicit cancellation reason.
- **`users.email` is normalized to lowercase at the application layer**, stored as plain `TEXT`. Every write and lookup calls `.toLowerCase()` before touching the DB. The original Phase 2A design used `citext` for case-insensitive comparison, but the `citext` extension isn't available in all managed Postgres environments (the earlier host's deploy-time migration ran only a DDL diff, never `CREATE EXTENSION`, so `citext` broke production). The app-layer normalization preserves the case-insensitive contract without the extension dependency. **Detection rule:** any new code path that writes or compares `users.email` MUST lowercase first — otherwise duplicate accounts can be created (`Alice@foo.com` vs `alice@foo.com`) and logins will silently mismatch.
- **Bulk CSV user import creates CSR accounts only.** Emails are normalized and deduplicated, existing accounts are skipped without mutation, and the effective program is enforced server-side. Each new user is stored with a separately salted hash of an *unguessable random throwaway* password (never revealed to anyone) and `must_reset_password=true`, then emailed a one-time invite link (a `password_reset_tokens` row with the 7-day `INVITE_TOKEN_DURATION_MS` lifetime) to set their own password via the existing `/reset-password` page. No plaintext password is returned to the admin. The bulk route refuses up-front (creating nothing) if delivery is unconfigured in production (`APP_BASE_URL` unset, or `RESEND_API_KEY`/`RESEND_FROM_EMAIL` unset), so it never mints accounts no one can reach. Single-user create + admin password-reset still return a one-time temp password in-response (shown once in the admin UI) — only bulk uses the invite-email path.
- **`app_settings` never authorizes arbitrary model ids or providers.** The model-routing API accepts only ids from the server-owned allowlist; the JSONB row stores an ordered list of approved preset ids (the fallback chain, `{"order":[...]}`), not an executable request body. Retired ids map to their replacement route, unknown or removed ids are dropped, and missing approved routes are appended on read, so the resolved chain is always a permutation of the ZDR allowlist. The legacy single-id shape (`{"selectedId":"..."}`) is still read-compatible. Missing table/row/invalid value falls back to the default order (Nemotron 3 Super primary).

## Schema change protocol

One schema change = one raw SQL file in `lib/db/sql/` plus the matching `lib/db/src/schema.ts` edit, applied to production with `scripts/railway-apply-sql.mjs` after the owner's go. No `drizzle-kit`. See CLAUDE.md → "Database schema changes" and `deployment.md`.
