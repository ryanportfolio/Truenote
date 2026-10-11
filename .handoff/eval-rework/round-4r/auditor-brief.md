# Auditor brief: eval-rework round 4r (recovery for S4 Fixture API)

You are an independent auditor in a fresh context. Do not edit source files. Write scratch only under /home/user/Truenote/.tmp/long-horizon/eval-rework/round-4r/audit/. No git command that changes refs, the index or HEAD. Return your report as your final message.

Workspace root: /home/user/Truenote. Contract version: 1.

Requirement: the fixture's POST /api/admin/evaluations/questions/draft returns exactly `count` (1..10, default 5) items with distinct question text, each {question, expectedAnswer, expectedDocId, expectedDocTitle}, for every document of the default program; unknown document still 404 "Source not found in this program"; count 11 still 400. No other behavior of the fixture changes.

Write scope: scripts/preview/mock-api/evaluations.mjs only.
Baseline: manifest /home/user/Truenote/.tmp/long-horizon/eval-rework/round-4r/baseline.json, git ref refs/long-horizon/eval-rework/round-4r.

Procedure:
1. `cd /home/user/Truenote && node .claude/skills/long-horizon/scripts/manifest.mjs . .tmp/long-horizon/eval-rework/round-4r/audit/current.json scripts/preview && node .claude/skills/long-horizon/scripts/manifest.mjs --diff .tmp/long-horizon/eval-rework/round-4r/baseline.json .tmp/long-horizon/eval-rework/round-4r/audit/current.json` (no --ref), `git diff refs/long-horizon/eval-rework/round-4r --stat`, `git status --short`. Only evaluations.mjs may change, and only draft-related code.
2. `node --check scripts/preview/mock-api/evaluations.mjs`. Start the mock alone (`MOCK_PORT=5299 PORT=5298 node scripts/preview/mock-api/server.mjs`, background, record pid), persona super_user via /api/__mock/as/super_user cookie jar, header x-program-id 00000000-0000-4000-8000-000000000001. For every document the fixture lists for that program (find the documents endpoint in server.mjs), POST draft with count 1, 5, 10 and no count; check exact counts, distinct questions, field set. Check unknown doc 404 and count 11 400. Spot-check that GET /questions, GET /runs and POST /runs still respond as before (status codes and top-level keys). Kill by pid; confirm port free.
3. Report three verdicts with evidence: status complete/incomplete/blocked (incomplete adds repairable yes/no with your own diagnostic); integrity clean/suspect/violation; contract aligned/drifted (version 1).
