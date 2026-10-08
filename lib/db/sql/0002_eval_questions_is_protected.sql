-- Held-out eval questions: a protected question is never edited and never
-- used for tuning (.claude/reference/eval.md). The runner reads the flag with
-- a tolerant raw query, so it needs no Drizzle binding. A constant default
-- adds the column without rewriting the table.
ALTER TABLE eval_questions
  ADD COLUMN IF NOT EXISTS is_protected boolean NOT NULL DEFAULT false;
