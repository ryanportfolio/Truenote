# Executor brief: eval-rework round 4r (recovery for S4 Fixture API)

You are an executor in a fresh context in /home/user/Truenote. Do not commit; no git command that changes refs, the index or HEAD. Never run pnpm/npm install.

## Context
scripts/preview/mock-api/evaluations.mjs (fixture API for /api/admin/evaluations, registered in server.mjs) passed every check except one. Contract: POST /questions/draft { documentId, count? 1..10 default 5 } returns exactly `count` items `{ question, expectedAnswer, expectedDocId, expectedDocTitle }` after ~1.5 s.

Auditor diagnostic (round 4): `draftFrom()` (evaluations.mjs, roughly lines 788-829) builds candidates only from table rows, "> " notes, numbered steps and doc.questions, dedupes, then `.slice(0, count)` with no fill. Over all 29 documents of the default program, count=5 returned 3-4 items on 4 docs and count=10 returned fewer than 10 on 20 docs. Suggested fix: top up from the active version's passages/headings with distinct questions until `count` is reached (short docs have 5-6 passages; e.g. "Executive escalations contact list" has 5 passages and 1 doc question).

## Step
Make draftFrom always return exactly `count` distinct, plausible items for every fixture document (top up from passages/headings; if a document truly has too little text, generate distinct generic-but-grounded questions from its title and passage sentences, still distinct by question text). Change nothing else.

Write scope: scripts/preview/mock-api/evaluations.mjs (draftFrom and helpers it alone uses).

## Verify
- `node --check scripts/preview/mock-api/evaluations.mjs`.
- Start `MOCK_PORT=5199 PORT=5198 node scripts/preview/mock-api/server.mjs &` (append "pid 5199 command" to /home/user/Truenote/.tmp/long-horizon/eval-rework/processes.log), persona via GET /api/__mock/as/super_user with a curl cookie jar, header x-program-id 00000000-0000-4000-8000-000000000001; for every document listed by the fixture for that program, POST /questions/draft with count 5 and 10 and record returned counts and distinctness to /home/user/Truenote/.tmp/long-horizon/eval-rework/round-4r/exec/draft-counts.txt. Kill the server by pid; confirm port free.
Report as your final message.
