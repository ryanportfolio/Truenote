-- Expected answer for an eval question: one or two sentences an admin writes
-- (or accepts from a drafted suggestion) as the reference answer. The question
-- routes read and write it with tolerant raw queries, so it needs no Drizzle
-- binding in lib/db/src/schema.ts. Nullable with no default: adding it does
-- not rewrite the table.
ALTER TABLE eval_questions
  ADD COLUMN IF NOT EXISTS expected_answer text;
