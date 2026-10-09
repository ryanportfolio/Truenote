-- One-time data cleanup for the history title rule (routes/sessions.ts).
-- History now releases a session title when the opening exchange is
-- authorized and every other withheld exchange is an uncited refusal.
-- Before this rule, session naming (routes/ask.ts) ran after every exchange
-- and only checked that the title was unset, so a later refusal could name
-- the session from a question history withholds. Naming now uses only the
-- opening exchange, but titles stored before that change carry no record of
-- which exchange produced them.
--
-- Clear the title of every session that has an uncited refusal after its
-- opening exchange. Before this change those titles were already hidden,
-- because any withheld exchange hid the title. The namer never renames a
-- session from a later exchange, so cleared titles stay empty.
--
-- Data only: no DDL. Apply right after deploying the code that adds the
-- opening-exchange namer. Sessions created between that deploy and this
-- run may also lose a title; that is accepted.

UPDATE chat_sessions s
SET title = NULL
WHERE s.title IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM query_log q
    WHERE q.session_id = s.id
      AND q.refused = true
      AND coalesce(cardinality(q.cited_chunk_ids), 0) = 0
      AND q.id <> (
        SELECT o.id
        FROM query_log o
        WHERE o.session_id = s.id
        ORDER BY o.created_at, o.id
        LIMIT 1
      )
  );
