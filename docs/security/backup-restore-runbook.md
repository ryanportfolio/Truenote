# Truenote backup and restore runbook

**Status:** Proposed. No restore test has been run yet; the evidence table in section 9 is empty. RPO and RTO values are proposed targets, not measured results. Items marked `[CONFIRM: ...]` need an owner check before this runbook is relied on.
**Owner:** Truenote maintainer
**Related:** [`incident-response-plan.md`](./incident-response-plan.md), threat model entry TN-TM-024 in [`../compliance/pci/threat-model.md`](../compliance/pci/threat-model.md), evidence gaps in [`../compliance/pci/evidence-index.md`](../compliance/pci/evidence-index.md).

One person must be able to follow every step. Commands are written for a shell with `psql` and `pg_dump` (PostgreSQL 16 client tools) unless a step says to use the Replit or Neon web console.

## 1. What holds data and what backs it up

Provider statements below were read on 2026-10-07. Re-read the cited page before each restore test; providers change these features.

| Data | Where it lives | What backs it up | Gaps |
|---|---|---|---|
| All application rows: programs, users, sessions, documents, document versions, parsed text, chunks and embeddings, query log, security events, SIEM outbox, settings, job queue | Replit production Postgres database. Replit bills production databases "through Neon" ([Replit: development and production databases](https://docs.replit.com/features/data-and-storage/development-and-production), accessed 2026-10-07). | **Point-in-time restore (PITR).** Replit: "For production databases, you can restore to a specific moment using point-in-time restore." Core plans keep up to 7 days of history; Pro and Enterprise up to 28 days; "Every plan starts at 7 days, and you can change the window in your production database's settings." **Scheduled backups:** "one full restore point each day", retained up to 7 days (Core) or 28 days (Pro and Enterprise), off until a retention period is chosen. ([Replit: data recovery](https://docs.replit.com/features/data-and-storage/data-recovery), accessed 2026-10-07.) | `[CONFIRM: Truenote's Replit plan, the current PITR window, and whether scheduled backups are on]`. Replit documents restore only for the production database itself, not into a separate database `[CONFIRM: with Replit support whether a production restore can target a separate database]`. |
| Same database, if the maintainer can reach the underlying Neon project | Neon | Neon can create a branch "from a current or past state" ([Neon: branching](https://neon.com/docs/introduction/branching), accessed 2026-10-07). The history window controls how far back restore and branching from the past can reach; Neon defaults are 6 hours (Free) and 1 day (Launch, Scale), up to 7 days (Launch) or 30 days (Scale) ([Neon: history window](https://neon.com/docs/postgres/backup-restore/history-window), accessed 2026-10-07). Instant restore overwrites all databases on a root branch and saves the prior state as a backup branch ([Neon: instant restore](https://neon.com/docs/introduction/branch-restore), accessed 2026-10-07). | `[CONFIRM: whether the maintainer has Neon console or API access to the Replit-managed production database]`. If not, the Neon steps in this runbook are unavailable. |
| Uploaded source files (PDF, DOCX, images, text) | Replit App Storage bucket. Each document version's storage key is in `document_versions.source_url`. | **None from the provider.** Replit: "App Storage doesn't support lifecycle rules, object versioning, or retention policies", and object deletion "is irreversible." App Storage runs on Google Cloud Storage. ([Replit: App Storage](https://docs.replit.com/features/data-and-storage/object-storage), accessed 2026-10-07.) Because App Storage has no versioning and deletes are irreversible, a database restore cannot bring back deleted files; this is an inference from the App Storage page, not a Replit statement `[CONFIRM: with Replit support that no database restore or checkpoint restores App Storage objects]`. | Truenote reads the original file only during ingestion and rescan. Answers, citations, and previews use the parsed text and chunks in the database. Losing a file blocks rescans of that version; it does not break existing answers. `[CONFIRM: a periodic export of the bucket to owner-controlled storage; no export tool exists in the repository]` |
| Secrets (provider keys, OIDC settings, signing keys, scanner settings, bootstrap login) | Replit Secrets, production app secrets ([Replit: secrets](https://docs.replit.com/core-concepts/project-editor/app-setup/secrets), accessed 2026-10-07) | Not backed up by Truenote. Each value can be re-issued from its provider, or regenerated in the case of the database credentials. | `[CONFIRM: whether secret values are also kept in a password manager]`. Keep a list of secret names and where each is issued, not the values. Secret names used by the code are listed in the incident response plan, section 5.2. |
| Application code and database DDL | GitHub repository; DDL files under `docs/security/` | Git history on GitHub | Replit checkpoints also exist. A database restore does not roll back code, and a code rollback does not restore the database ([Replit: data recovery](https://docs.replit.com/features/data-and-storage/data-recovery), accessed 2026-10-07). |

## 2. Recovery targets (proposed)

These are proposed targets for one maintainer. They are not measured. Replace "proposed" with "approved" only after the owner agrees and a restore test meets them.

| Data | RPO (most data that may be lost) | RTO (time from the decision to restore until CSRs get cited answers again) |
|---|---|---|
| Production database, restore point inside the PITR window | 1 hour (proposed) | 8 hours (proposed) |
| Production database, restore point older than the PITR window, from a daily scheduled backup | 24 hours (proposed) | 8 hours (proposed) |
| Uploaded source files | Time since the last bucket export `[CONFIRM: export schedule; proposed weekly]` | 2 business days to collect missing files from program owners and re-upload (proposed) |
| Secrets | Not applicable (re-issue) | 4 hours to re-issue and republish all secrets (proposed) |

Measure RPO as the gap between the chosen restore point and the last good write that the restore discarded. Measure RTO from the recorded decision time to the first passing smoke test against production after cutover.

## 3. Safety rules for any restore

1. **Restore to a non-production target first.** Never restore over production until the same restore point has passed section 5 on a separate database. If no separate target is available (section 4.2, path C), say so in the evidence record.
2. **Isolate the test app instance.** When running Truenote against a restored target:
   - start only the API server (`pnpm --filter @workspace/api-server run dev`); do **not** start the background worker, which would process queued ingestion jobs, send files to LandingAI and OpenAI, and write to App Storage;
   - set `RAG_STORAGE_DRIVER=memory` so the instance cannot read or delete production App Storage objects;
   - leave `SIEM_WEBHOOK_URL` unset, so outbox rows copied from production are not re-sent to the SIEM;
   - leave `RESEND_API_KEY`, `BOOTSTRAP_SUPER_USER_*`, and `DEMO_LOGIN_ACCOUNTS` unset, and do not set `NODE_ENV=production`;
   - never run `sweep-orphans` or the document purge against a restored target. `sweep-orphans` deletes every App Storage object that the connected database does not reference, which after a restore includes files that production still needs.
3. **Keep connection strings out of shell history and out of this repository.** Paste them into an environment variable from the console for the session only.
4. **Record times in UTC** as you go. The evidence table needs them.

## 4. Restore procedure

### 4.1 Prepare

1. Write down the start time (UTC) and why you are restoring: scheduled test, or incident id.
2. Choose the restore point.
   - Incident: the last time before the damage. Use `security_events.occurred_at`, `query_log.created_at`, and the document lifecycle events (`document.lifecycle.*`) to find it. If Neon access exists, Neon's Time Travel Assist runs read-only queries against a past moment to confirm the point ([Neon: instant restore](https://neon.com/docs/introduction/branch-restore), accessed 2026-10-07).
   - Scheduled test: any point at least one hour old inside the PITR window.
3. Capture a production baseline (read-only), so the restored target can be compared with it:

   ```sql
   SELECT now() AS captured_at,
     (SELECT count(*) FROM programs) AS programs,
     (SELECT count(*) FROM users) AS users,
     (SELECT count(*) FROM documents) AS documents,
     (SELECT count(*) FROM document_versions) AS document_versions,
     (SELECT count(*) FROM chunks) AS chunks,
     (SELECT count(*) FROM query_log) AS query_log,
     (SELECT count(*) FROM security_events) AS security_events,
     (SELECT max(sequence) FROM security_events) AS last_event_sequence;
   ```

   Also record the same counts as of the restore point where the table has a timestamp, for example `SELECT count(*) FROM query_log WHERE created_at <= '<restore point>';`.
4. For an incident restore, export what the restore will remove (store in the restricted evidence location, not in this repository):

   ```sql
   SELECT * FROM security_events WHERE occurred_at > '<restore point>' ORDER BY sequence;
   SELECT user_id, created_at FROM sessions WHERE created_at > '<restore point>';
   ```

   Also take a full logical export of production as a last-resort rollback copy:

   ```
   pg_dump --format=custom --no-owner --file=truenote-prod-before-restore-<UTC date>.dump "$PROD_DATABASE_URL"
   ```

   `[CONFIRM: how to obtain a production connection string for pg_dump from the Replit database tool, and that the export file is stored encrypted outside the repository]`

### 4.2 Create the non-production target

Use the first path that is available.

**Path A: Neon branch from the restore point** (needs Neon access).
In the Neon console, create a branch from the production branch at the restore timestamp, or with the Neon CLI:

```
neon branches create --name restore-test-<UTC date> --parent <restore point, RFC 3339>
```

The Neon CLI accepts a timestamp for `--parent` to create a branch from a past state ([Neon CLI: branches](https://neon.com/docs/cli/branches), accessed 2026-10-07). Copy the new branch's connection string from the console. This is the target for section 5.

**Path B: Replit restore into a separate database.** Use only if Replit support confirms it exists `[CONFIRM]`.

**Path C: logical export restored into a scratch database** (always available, weaker).
Create an empty PostgreSQL 16 database that you control and that holds no other data, enable the extensions the schema uses, and restore the export:

```
psql "$TARGET_DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
pg_restore --no-owner --no-acl --dbname="$TARGET_DATABASE_URL" truenote-prod-before-restore-<UTC date>.dump
```

Path C tests Truenote's own export, not the provider's point-in-time restore, and its restore point is the export time. Record which path you used. Until path A or B is available, the provider PITR path is untested.

### 4.3 Verify the target

Run every check in section 5 against the target. Stop and record the failure if any check fails.

### 4.4 Cut over (incident restores only)

Skip this section for a scheduled test.

1. Tell the customer security contact the planned downtime window.
2. Stop writes: stop the Replit deployment `[CONFIRM: exact Replit control]`.
3. Restore production to the **same restore point** that passed section 5:
   - Replit: Database tool, production database, point-in-time restore to the chosen time ([Replit: data recovery](https://docs.replit.com/features/data-and-storage/data-recovery), accessed 2026-10-07). For a daily backup instead: Scheduled backups, View all backups, Restore, type `restore`, Continue. Replit states this "does not delete the current data, but connected services can briefly reconnect."
   - Neon, if used directly: instant restore of the production root branch to the timestamp. Neon keeps the pre-restore state as a backup branch named `<branch>_old_<timestamp>` ([Neon: instant restore](https://neon.com/docs/introduction/branch-restore), accessed 2026-10-07).
4. If the restore point is older than the deployed code's schema, republish the commit that matches the restore point, then apply forward DDL through the normal schema-change process. Replit warns that restoring the database does not restore code ([Replit: data recovery](https://docs.replit.com/features/data-and-storage/data-recovery), accessed 2026-10-07).
5. Reconcile changes the restore removed:
   - Run `DELETE FROM sessions;` so that sessions revoked after the restore point cannot come back. Everyone signs in again.
   - Using the exported `security_events`, re-apply every deactivation, password reset, role change, document revocation, and retirement made after the restore point.
   - Documents uploaded after the restore point are gone from the database but their files are still in App Storage. Ask program owners to re-upload them. Do not run `sweep-orphans` until this is done.
   - Documents purged after the restore point come back as rows, but their files were deleted from App Storage. Revoke or retire them again.
6. Start the deployment, including the worker, and run the section 5.4 smoke test against production.
7. Record the end time. RTO is end time minus decision time.

### 4.5 Roll back a cutover

If production fails the smoke test after cutover:

1. Neon: run instant restore again, using the backup branch `<branch>_old_<timestamp>` as the source ([Neon: instant restore](https://neon.com/docs/introduction/branch-restore), accessed 2026-10-07).
2. Replit: `[CONFIRM: whether Replit's point-in-time restore keeps the pre-restore state and how to return to it]`. A scheduled-backup restore "does not delete the current data" per Replit; ask Replit support how to switch back.
3. Last resort: restore the `pg_dump` taken in step 4.1.4 into an empty production database `[CONFIRM: procedure with Replit support]`.
4. Record the rollback in the evidence table and open an incident if one is not already open.

### 4.6 Clean up

1. Delete the test branch or scratch database once the evidence is recorded. Neon backup branches count toward storage until deleted, and some cannot be deleted ([Neon: instant restore](https://neon.com/docs/introduction/branch-restore), accessed 2026-10-07).
2. Delete local copies of the `pg_dump` file once it is stored in the restricted location.
3. Stop the test API server.

## 5. Verification checks

### 5.1 Schema present

```sql
SELECT t AS missing_table
FROM unnest(ARRAY[
  'programs', 'users', 'sessions', 'documents', 'document_versions', 'chunks',
  'query_log', 'content_sources', 'security_events', 'security_rate_limits',
  'siem_delivery_outbox'
]) AS t
WHERE to_regclass('public.' || t) IS NULL;
```

Pass: no rows. For a deeper check, run [`../compliance/pci/production-control-verification.sql`](../compliance/pci/production-control-verification.sql) against the target and compare its output with the last production run; it reads catalog definitions only.

### 5.2 Row counts in the expected range

Run the baseline query from step 4.1.3 against the target.

Pass, for a restore point in the past:

- each count is no higher than the production baseline;
- tables with timestamps match the "as of restore point" counts recorded in 4.1.3, or differ only by rows explained in the record;
- tables that only grow (`security_events`, `query_log`) are within 10% of their restore-point counts (proposed tolerance);
- `users`, `programs`, and `documents` are not zero unless production is also zero.

Pass, for path C: counts equal the production counts captured at export time.

### 5.3 Security-event hash chain

No verifier for the hash chain exists in the repository. Until one is written, run these two read-only queries and record the results.

Link check (each event names the previous event's hash):

```sql
SELECT count(*) AS broken_links
FROM (
  SELECT sequence, previous_hash,
         lag(event_hash) OVER (ORDER BY sequence) AS prior_hash,
         min(sequence) OVER () AS first_sequence
  FROM security_events
) chain
WHERE sequence <> first_sequence
  AND previous_hash IS DISTINCT FROM prior_hash;
```

Pass: `broken_links = 0`.

Hash recompute (repeats the formula used by the `append_security_event` function in [`p0-p1-security-controls.sql`](./p0-p1-security-controls.sql)):

```sql
SET TimeZone = 'UTC';
SELECT count(*) AS hash_mismatches
FROM security_events se
WHERE se.event_hash <> encode(digest(concat_ws('|',
  COALESCE(se.previous_hash, ''), se.id::text, se.occurred_at::text,
  se.action, se.outcome,
  COALESCE(se.actor_user_id::text, ''), COALESCE(se.actor_email, ''),
  COALESCE(se.actor_role, ''), COALESCE(se.program_id::text, ''),
  COALESCE(se.resource_type, ''), COALESCE(se.resource_id, ''),
  COALESCE(se.request_id, ''), COALESCE(se.source_ip, ''),
  se.details::text), 'sha256'), 'hex');
```

Pass: `hash_mismatches = 0`. The hash covers `occurred_at` as text, so the result depends on the session time zone matching the one used when events were written. `[CONFIRM: run once on known-good production data and confirm it returns 0 with TimeZone set to UTC; if not, find the time zone the application's connections use]`

Also confirm that the target's last event sequence matches the restore point: no event later than the restore point should exist on the target.

### 5.4 Application smoke test

Against the target, with the isolation settings from section 3:

1. Start the API server with `DATABASE_URL` set to the target. Startup must log `[api-server] listening`.
2. `GET /health` returns `{"ok":true}`.
3. Sign in as a super user. The admin Documents, Users, and Security pages load.
4. Sign in as a CSR test account in a test program `[CONFIRM: a synthetic test program, its documents, and a CSR test account exist in production]` and ask a question whose answer is in that program's documents. The answer has at least one citation, and opening it shows the cited excerpt.
5. Ask a question that only another program's documents can answer. The answer is a refusal.
6. Optional, costs provider tokens: `pnpm --filter @workspace/scripts run eval -- --limit 5` with `DATABASE_URL` set to the target. No new failures compared with the last production eval run.

`GET /api/admin/observability/security-audit` on the test instance reports `deliveryConfigured: false`; that is expected with the SIEM webhook unset.

After cutover, repeat steps 2 to 5 against production with the worker running, and check that `GET /api/admin/observability/security-audit` shows the SIEM backlog draining.

## 6. Object storage recovery

App Storage has no provider backup (section 1). If files are lost:

1. List affected versions: `SELECT dv.id, d.title, d.program_id, dv.source_url FROM document_versions dv JOIN documents d ON d.id = dv.document_id;` then check each key in the Replit App Storage tool or from the last export.
2. Existing answers keep working, because they read parsed text and chunks from the database.
3. Restore missing files from the last bucket export `[CONFIRM: export location]`, or ask program owners for the originals and upload them as new versions.

## 7. Secrets recovery

1. For each secret name, re-issue the value at its provider, set it in Replit production app secrets, and republish.
2. For the production database credentials, use Regenerate credentials in the Replit database tool ([Replit: connection details](https://docs.replit.com/features/data-and-storage/connection-details), accessed 2026-10-07).
3. Run the smoke test in section 5.4 against production.

## 8. Test schedule (proposed)

- Run a restore test (sections 4.1 to 4.3, 4.6, and 5) every 3 months and after any change to the database plan, PITR window, or schema-migration process.
- Run the object-storage and secrets checks (sections 6 and 7, without changing production values) every 6 months, together with an incident-response tabletop exercise.

## 9. Restore test evidence record

Add one row per restore test or real restore. Keep raw query output in the restricted evidence location `[CONFIRM: location]`; put only the summary here.

| Date (UTC) | Operator | Reason (test / incident id) | Path (A / B / C) | Restore point (UTC) | Measured RPO | Measured RTO | Checks passed (5.1 / 5.2 / 5.3 link / 5.3 recompute / 5.4) | Issues and follow-up |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
