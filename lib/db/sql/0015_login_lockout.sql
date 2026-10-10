-- Per-account lockout for local password login
-- (artifacts/api-server/src/lib/auth/lockout.ts). Until now the only brake on
-- password guessing was the per-IP limiter (2000 attempts per 10 minutes), so
-- a distributed guesser could try one account without limit.
--
-- failed_login_count counts consecutive wrong passwords since the last
-- success or lock. When it reaches LOGIN_LOCKOUT_THRESHOLD (default 5) one
-- UPDATE resets it to 0 and sets locked_until to now() plus
-- LOGIN_LOCKOUT_MINUTES (default 30). A successful login clears both.
-- locked_until stays NULL for an account that was never locked.
--
-- No new grants: truenote_app holds table-level SELECT, INSERT, UPDATE, DELETE
-- on users (0007_app_runtime_role.sql), which covers new columns. Adding a
-- column with a constant default does not rewrite the table.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0
    CONSTRAINT users_failed_login_count_check CHECK (failed_login_count >= 0);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS locked_until timestamp with time zone;
