# Truenote backup and restore runbook

**Status:** Proposed. No restore test has been run yet; the evidence table in section 9 is empty. RPO and RTO values are proposed targets, not measured results. Items marked `[CONFIRM: ...]` need an owner check before this runbook is relied on.
**Owner:** Truenote maintainer
**Related:** [`incident-response-plan.md`](./incident-response-plan.md), threat model entry TN-TM-024 in [`../compliance/pci/threat-model.md`](../compliance/pci/threat-model.md), evidence gaps in [`../compliance/pci/evidence-index.md`](../compliance/pci/evidence-index.md).

One person must be able to follow every step. Shell commands are written for bash or zsh: Git Bash on Windows, a macOS or Linux terminal running bash or zsh, or the Replit shell. Plain POSIX shells such as dash reject the `read -rs` form in the table below. The shell needs `psql`, `pg_dump`, and `pg_restore` (PostgreSQL 16 client tools) on its path. SQL blocks run inside `psql`. Steps that say to use the Replit or Neon web console need no shell.

PowerShell does not read the bash patterns these commands use. Each command that uses one has its PowerShell form beside it.

| Pattern | bash | PowerShell |
|---|---|---|
| Set a connection string for this session only (paste it at the prompt, so it stays out of shell history) | `read -rs PROD_DATABASE_URL && export PROD_DATABASE_URL` | `$env:PROD_DATABASE_URL = Read-Host 'Connection string'` |
| Read it in a command | `"$PROD_DATABASE_URL"` | `$env:PROD_DATABASE_URL` |
| Set variables before starting a server | `API_PORT=3001 pnpm ...` (applies to that one command) | `$env:API_PORT = '3001'; pnpm ...` (stays set until the PowerShell window closes) |
| Remove a variable for this session | `unset NAME` | `Remove-Item Env:NAME -ErrorAction SilentlyContinue` |

`TARGET_DATABASE_URL` and `DATABASE_URL` follow the same pattern.

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
   - start only the API server (`pnpm --filter @workspace/api-server run dev`) and, for the smoke test, the Vite frontend dev server (section 5.4); do **not** start the background worker, which would process queued ingestion jobs, send files to LandingAI and OpenAI, and write to App Storage;
   - set `RAG_STORAGE_DRIVER=memory` so the instance cannot read or delete production App Storage objects;
   - leave `SIEM_WEBHOOK_URL` unset, so outbox rows copied from production are not re-sent to the SIEM;
   - leave `RESEND_API_KEY`, `BOOTSTRAP_SUPER_USER_*`, and `DEMO_LOGIN_ACCOUNTS` unset, and do not set `NODE_ENV=production`;
   - leave every `OIDC_*` variable unset and set `LOCAL_LOGIN_MODE=enabled`. `getOidcConfig()` (`artifacts/api-server/src/lib/auth/oidc.ts`) turns company SSO on when `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, and an `OIDC_STATE_SECRET` of at least 32 characters are set, and when `LOCAL_LOGIN_MODE` is unset it then defaults the password login to `break_glass`. In `break_glass` mode `POST /api/auth/login` (`artifacts/api-server/src/routes/auth.ts`) checks the password and then refuses every account except a `super_user` with HTTP 403 `Use company SSO to sign in.`; a super user's sign-in is recorded as `auth.break_glass.login`. In `disabled` mode it refuses every account and the sign-in page hides the password field. A shell that inherits production secrets, such as the Replit shell, therefore blocks the CSR password sign-in that section 5.4 needs. SSO from the test instance does not work either: `GET /api/auth/oidc/start` sends the browser to the identity provider with the production `OIDC_REDIRECT_URI`, so the provider returns it to the production deployment, whose callback rejects it because the state cookie was set on the test origin. Without the five SSO values SSO is off and every active account can use its password; `LOCAL_LOGIN_MODE=enabled` keeps the password field on the sign-in page even when the shell inherited `LOCAL_LOGIN_MODE=disabled`. Before starting the test servers, in each shell:

     ```
     unset OIDC_ISSUER_URL OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_REDIRECT_URI OIDC_STATE_SECRET OIDC_REQUIRED_ACR OIDC_REQUIRE_MFA OIDC_ALLOWED_DOMAINS && export LOCAL_LOGIN_MODE=enabled
     ```

     PowerShell:

     ```
     Remove-Item Env:OIDC_* -ErrorAction SilentlyContinue; $env:LOCAL_LOGIN_MODE = 'enabled'
     ```

     To test SSO itself, register a separate test client at the identity provider whose redirect URI is the test origin's callback (`http://localhost:5173/api/auth/oidc/callback`, which the Vite proxy forwards to the API), set the five `OIDC_*` values to that client, and still set `LOCAL_LOGIN_MODE=enabled` so the CSR password sign-in keeps working. Outside `NODE_ENV=production` the code accepts `http` issuer and redirect URLs. `[CONFIRM: whether the identity provider allows a separate client with a localhost redirect URI]` Never reuse the production client: its redirect URI points at production;
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
4. For an incident restore, export what the restore will remove or revert (store in the restricted evidence location, not in this repository):

   ```sql
   SELECT * FROM security_events WHERE occurred_at > '<restore point>' ORDER BY sequence;
   SELECT user_id, created_at FROM sessions WHERE created_at > '<restore point>';
   ```

   Also export a snapshot of every user's sign-in and authorization fields. The application does not record resulting user state in its audit events. The generic audit middleware (`artifacts/api-server/src/middleware/security-audit.ts`) writes one `http.security_mutation` event only for requests whose method is not GET, HEAD, or OPTIONS (in practice POST, PATCH, PUT, and DELETE) and whose path is `/api/admin`, `/api/documents`, or `/api/auth`, or starts with one of them followed by `/`. For each such request it stores the method and route path, the response status and outcome, the actor (user id, email, and role), the actor's program, the request id, the source IP, and the request duration. It does not store the request body or the resulting user state: the account's role, active flag, program, clearance, or password changes. The admin user routes write no event with the account's new role, active flag, or program. The exported `security_events` therefore cannot rebuild these fields, and this snapshot is the only record of them. Run in `psql` against production:

   ```
   \copy (SELECT id, email, role, program_id, is_active, must_reset_password, max_classification, password_hash FROM users ORDER BY id) TO 'truenote-users-before-restore-<UTC date>.csv' WITH (FORMAT csv, HEADER)
   ```

   `program_id` is the user's program assignment (the only one; NULL only for `super_user`), and `max_classification` is the user's clearance for document classification. The file holds password hashes: store it encrypted in the restricted evidence location, never in this repository, and delete local copies with the `pg_dump` file (section 4.6).

   When the cutover in section 4.4 stops writes, run both exports in this step again and use the later files for reconciliation, so changes made while the target was being verified are not lost.
5. Take a full logical export of production whenever path C (section 4.2) will be used, including scheduled tests, and for every incident restore as a last-resort rollback copy:

   When path C will be used, first run the baseline query from step 3 against production again, immediately before starting `pg_dump`, and record the result as the export-time counts. Writes made between step 3 and the export change production counts, so path C is checked against these export-time counts, not the step 3 baseline (section 5.2). `pg_dump` exports one consistent snapshot taken when it starts, so only writes made between this query and that start can still cause a difference.

   ```
   pg_dump --format=custom --no-owner --file=truenote-prod-before-restore-<UTC date>.dump "$PROD_DATABASE_URL"
   ```

   PowerShell:

   ```
   pg_dump --format=custom --no-owner --file=truenote-prod-before-restore-<UTC date>.dump $env:PROD_DATABASE_URL
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
Create an empty PostgreSQL 16 database that you control and that holds no other data, enable the extensions the schema uses, and restore the export taken in step 4.1.5:

```
psql "$TARGET_DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
pg_restore --no-owner --no-acl --dbname="$TARGET_DATABASE_URL" truenote-prod-before-restore-<UTC date>.dump
```

PowerShell:

```
psql $env:TARGET_DATABASE_URL -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
pg_restore --no-owner --no-acl "--dbname=$env:TARGET_DATABASE_URL" truenote-prod-before-restore-<UTC date>.dump
```

Path C tests Truenote's own export, not the provider's point-in-time restore. It restores the current production state as of the export time, not a past point, which is why it is the weaker path: it cannot show that a chosen restore point is recoverable or free of the damage, and during an incident the export contains the damage. Record which path you used. Until path A or B is available, the provider PITR path is untested.

### 4.3 Verify the target

Run every check in section 5 against the target. Stop and record the failure if any check fails.

### 4.4 Cut over (incident restores only)

Skip this section for a scheduled test.

1. Tell the customer security contact the planned downtime window.
2. Stop writes: stop the Replit deployment `[CONFIRM: exact Replit control]`. Then repeat the exports in step 4.1.4. The deployment stays stopped until step 6; do not publish or republish before then. The deployment command in `.replit` (`[deployment] run`) starts the API server and the background worker together, so a publish puts production in front of users and lets the worker process restored jobs before step 5 has reconciled authorization fields, removed restored sessions and reset tokens, and re-applied document revocations.
3. Restore production to the **same restore point** that passed section 5:
   - Replit: Database tool, production database, point-in-time restore to the chosen time ([Replit: data recovery](https://docs.replit.com/features/data-and-storage/data-recovery), accessed 2026-10-07). For a daily backup instead: Scheduled backups, View all backups, Restore, type `restore`, Continue. Replit states this "does not delete the current data, but connected services can briefly reconnect."
   - Neon, if used directly: instant restore of the production root branch to the timestamp. Neon keeps the pre-restore state as a backup branch named `<branch>_old_<timestamp>` ([Neon: instant restore](https://neon.com/docs/introduction/branch-restore), accessed 2026-10-07).
4. Bring the restored schema forward to the deployed code, with the deployment still stopped. Replit warns that restoring the database does not restore code ([Replit: data recovery](https://docs.replit.com/features/data-and-storage/data-recovery), accessed 2026-10-07), so the restored database has the schema of the restore point while step 6 starts the currently deployed commit. That code needs the tables and columns in `lib/db/src/schema.ts` plus the tables, columns, constraints, triggers, and functions in the SQL files under `docs/security/`. As of 2026-10-07 the last change to either was made on 2026-07-15, earlier than the longest PITR window (28 days), so a restore point inside the window needs no forward DDL today. Check again at every restore:
   - Run the section 5.1 query and [`../compliance/pci/production-control-verification.sql`](../compliance/pci/production-control-verification.sql) against production and compare the output with the last production run from before the incident. A missing table or a changed definition means forward DDL is needed. To find which change, list the commits after the restore point on the deployed branch: `git log --since='<restore point>' --format='%ad %h %s' -- lib/db/src/schema.ts docs/security/`. Commit dates only approximate when DDL reached production, so let the comparison decide.
   - Apply the missing DDL with `psql` against the stopped production database, for example `psql "$PROD_DATABASE_URL" -f docs/security/p1-siem-delivery-outbox.sql` (PowerShell: `psql $env:PROD_DATABASE_URL -f docs/security/p1-siem-delivery-outbox.sql`). Use the repository's canonical files under `docs/security/`, apply only the files whose objects the comparison shows missing or different, and keep the order they were added: `p0-p1-security-controls.sql`, `p1-siem-delivery-outbox.sql`, `malware-scanning-control.sql`, `review-approval-control.sql`, then any later file. Later files redefine constraints that earlier ones create. Read each file before running it: besides DDL, some also write rows, for example `p0-p1-security-controls.sql` backfills content sources, document version sources, and user clearances, and `p1-siem-delivery-outbox.sql` queues every existing security event that has no outbox row for SIEM delivery. A change that exists only in `lib/db/src/schema.ts` has no canonical SQL file; under the normal schema-change process its DDL was applied to the development database by the Replit Agent and reached production through Publish `[CONFIRM: where the reviewed DDL for each schema.ts change is recorded, so it can be applied with psql]`. Do not use Publish for this step: it starts the deployment, and Replit Publish has been seen to leave constraint bodies and database functions out ([`.claude/reference/environment.md`](../../.claude/reference/environment.md), entry of 2026-07-15).
   - Run the comparison again. Continue only when the output matches the last production run.
   - Do not republish an older commit to match the restored schema. Once the schema is current, the deployed commit runs against it, and publishing starts the deployment before step 5. If forward DDL cannot be found or applied, keep the deployment stopped and record the blocker; republishing an older commit is a fallback only if Replit can publish it without serving traffic `[CONFIRM: with Replit support whether a commit can be published with the deployment kept stopped]`.
5. Reconcile changes the restore removed. Do every part of this step while the deployment is still stopped.
   - Restore user sign-in and authorization fields from the user snapshot exported after writes stopped (step 4.1.4), and remove every session and reset token, in one `psql` session against production. The snapshot was taken after the damage, so it can hold the attacker's changes: a raised role, a password the attacker set, a reactivated account, or an account moved into another program. Copying it without review would put that damage back, including access to another program's documents. The operator therefore reviews every changed account before the copy and excludes the ones the incident explains or that nobody can explain.

     Load the snapshot and list every account whose authorization fields differ between the snapshot and the restored database:

     ```
     BEGIN;
     CREATE TEMP TABLE users_snapshot (
       id uuid PRIMARY KEY, email text, role user_role, program_id uuid,
       is_active boolean, must_reset_password boolean,
       max_classification text, password_hash text
     ) ON COMMIT DROP;
     \copy users_snapshot FROM 'truenote-users-before-restore-<UTC date>.csv' WITH (FORMAT csv, HEADER)
     -- Review list: accounts present in both, with any authorization field changed after the restore point.
     SELECT u.id, s.email,
            u.role AS restored_role, s.role AS snapshot_role,
            u.program_id AS restored_program_id, s.program_id AS snapshot_program_id,
            u.is_active AS restored_is_active, s.is_active AS snapshot_is_active,
            u.must_reset_password AS restored_must_reset, s.must_reset_password AS snapshot_must_reset,
            u.max_classification AS restored_clearance, s.max_classification AS snapshot_clearance,
            u.password_hash IS DISTINCT FROM s.password_hash AS password_changed
     FROM users u JOIN users_snapshot s ON s.id = u.id
     WHERE (u.role, u.program_id, u.is_active, u.must_reset_password, u.max_classification, u.password_hash)
       IS DISTINCT FROM
           (s.role, s.program_id, s.is_active, s.must_reset_password, s.max_classification, s.password_hash)
     ORDER BY s.email;
     -- Accounts created after the restore point (absent from the restored database).
     SELECT s.id, s.email, s.role, s.program_id, s.is_active
     FROM users_snapshot s
     WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.id)
     ORDER BY s.email;
     ```

     Review each row of both lists against the incident's scope and timeline, and record the decision for each account in the evidence record. To explain a change, match it to the `security_events` exported in step 4.1.4: admin changes to an account appear as `http.security_mutation` events whose `resource_id` is `PATCH /api/admin/users/<id>`, `POST /api/admin/users/<id>/reset-password`, or `DELETE /api/admin/users/<id>`, with the actor and `occurred_at`. These events show who acted and when, not the new values. A signed-in password change appears as `POST /api/auth/change-password` with the account as actor. A reset-link password change appears as `POST /api/auth/reset-password` with no actor and no account id, so it cannot be tied to an account; treat a password change with no matching event as unexplained unless the account's owner confirms it. A change is legitimate only if a known, uncompromised actor made it outside the incident's window or scope, or its owner confirms it. Exclude from the copy every account whose change is attributable to the incident or cannot be explained, still inside the same transaction:

     ```
     CREATE TEMP TABLE reconcile_exclusions (
       id uuid PRIMARY KEY,
       action text NOT NULL CHECK (action IN ('keep_restored', 'deactivate'))
     ) ON COMMIT DROP;
     -- One row per excluded account, for example:
     -- INSERT INTO reconcile_exclusions VALUES ('<user id>', 'keep_restored');
     -- INSERT INTO reconcile_exclusions VALUES ('<user id>', 'deactivate');
     ```

     Use `keep_restored` when the incident explains the change and the restored, pre-damage values are known to be correct. Use `deactivate` when the change cannot be explained or the account itself may be under the attacker's control; the account stays blocked until its owner and an admin confirm it. For an account in the second list (created after the restore point), do not recreate it unless its creation is explained and legitimate. Account creation appears as `POST /api/admin/users` or `POST /api/admin/users/bulk` without the new account's id, so match it by actor and time.

     If a scheduled restore test rehearses this step, or a restore has no incident behind it, the review still runs, but every legitimate change is kept: `reconcile_exclusions` stays empty unless a change cannot be explained.

     Then apply the snapshot to every account that was not excluded, block the rest, remove sessions and reset tokens, and check the result:

     ```
     -- Users that existed when writes stopped and were not excluded: take every field from the snapshot.
     UPDATE users u
     SET role = s.role, program_id = s.program_id, is_active = s.is_active,
         must_reset_password = s.must_reset_password,
         max_classification = s.max_classification, password_hash = s.password_hash
     FROM users_snapshot s
     WHERE u.id = s.id
       AND NOT EXISTS (SELECT 1 FROM reconcile_exclusions x WHERE x.id = u.id)
       AND (s.program_id IS NULL OR EXISTS (SELECT 1 FROM programs p WHERE p.id = s.program_id));
     -- Users whose program was created after the restore point: block sign-in.
     UPDATE users u SET is_active = false
     FROM users_snapshot s
     WHERE u.id = s.id AND s.program_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM reconcile_exclusions x WHERE x.id = u.id)
       AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.id = s.program_id);
     -- Users deleted after the restore point came back: block sign-in.
     UPDATE users u SET is_active = false
     WHERE NOT EXISTS (SELECT 1 FROM users_snapshot s WHERE s.id = u.id);
     -- Excluded accounts marked deactivate: block sign-in, keep the other restored values.
     UPDATE users u SET is_active = false
     FROM reconcile_exclusions x
     WHERE x.id = u.id AND x.action = 'deactivate';
     DELETE FROM password_reset_tokens;
     DELETE FROM sessions;
     SELECT count(*) AS active_users_differing_from_snapshot
     FROM users u JOIN users_snapshot s ON s.id = u.id
     WHERE u.is_active
       AND NOT EXISTS (SELECT 1 FROM reconcile_exclusions x WHERE x.id = u.id)
       AND (u.role, u.program_id, u.is_active, u.must_reset_password, u.max_classification, u.password_hash)
       IS DISTINCT FROM
           (s.role, s.program_id, s.is_active, s.must_reset_password, s.max_classification, s.password_hash);
     ```

     If `active_users_differing_from_snapshot` is 0, run `COMMIT;`. Otherwise run `ROLLBACK;`, find the cause, and do not reopen production. A rollback discards the exclusions too; enter them again on the next attempt.

     Why each part is needed:
     - The restore brings back each user's role, active flag, program assignment, clearance, and password hash as of the restore point. Without the snapshot, a user deactivated, demoted, or moved out of a program after that point regains the withdrawn access, including another program's documents (program scoping is a security boundary), and a password changed after a compromise reverts to the known one. The exported `security_events` cannot replace the snapshot, because they do not record the resulting user state.
     - `DELETE FROM password_reset_tokens;` invalidates every reset and invitation link. The restore makes tokens that were consumed after the restore point unused again, and `POST /api/auth/reset-password` accepts any unused, unexpired token, sets a new password, and signs the holder in. An old link could then take over the account. No route re-sends an invitation link to an existing account. A user who still needs to set a password has two options: request a new reset link from the sign-in page's forgot-password form (`POST /api/auth/forgot-password`, which emails a link only to an active account and only when `APP_BASE_URL`, `RESEND_API_KEY`, and `RESEND_FROM_EMAIL` are set), or ask an admin to reset the password from the admin Users page (`POST /api/admin/users/<id>/reset-password`). The admin reset returns a temporary password once, which the admin passes to the user outside Truenote, and forces a password change at the next sign-in.
     - `DELETE FROM sessions;` stops sessions revoked after the restore point from coming back. Everyone signs in again.
     - Users created after the restore point are missing from the restored database. Recreate only the accounts the review kept, through the admin Users page. Creating one user (`POST /api/admin/users`) sends no email: the admin sets a password or receives a generated temporary password once, passes it to the user outside Truenote, and the user must change it at the first sign-in. Bulk import (`POST /api/admin/users/bulk`) creates CSR accounts only, in the admin's current program, and emails each new account an invitation link to set its password; it creates nothing unless `APP_BASE_URL` is set and, in production, `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are set. Recreate managers and other non-CSR accounts one at a time.
     - Programs created after the restore point are missing too. Recreate them, then reassign and reactivate the users the second `UPDATE` blocked.
   - Using the exported `security_events`, re-apply every document revocation and retirement made after the restore point. The `document.lifecycle.*` events carry the document version, the previous and new lifecycle state, and the actor in their `details`. The deployment is stopped, so use a local instance: from a repository checkout, start the API server and the Vite frontend as in section 5.4, with every section 3 isolation setting but `DATABASE_URL` set to production (`$PROD_DATABASE_URL`), sign in as a super user, and revoke or retire each version from the admin Documents page. Revocation (`POST /api/documents/<versionId>/revoke`) and retirement (`DELETE /api/documents/<id>`) change only database rows and write their audit events; neither touches App Storage. Sign out when done, which deletes the session this created, and stop both servers.
   - Documents purged after the restore point come back as rows, but their files were deleted from App Storage. Revoke or retire them again the same way.
   - Documents uploaded after the restore point are gone from the database but their files are still in App Storage. After step 6, ask program owners to re-upload them. Do not run `sweep-orphans` until this is done.
6. Start the deployment, including the worker, only after steps 4 and 5 are complete `[CONFIRM: exact Replit control, and whether starting a stopped deployment requires Publish]`. Replit's Publish compares the development database with production ([`.claude/reference/environment.md`](../../.claude/reference/environment.md)); if it proposes a schema change, stop and compare it with step 4, because production should already match the deployed code. Then run the section 5.4 smoke test against production.
7. Record the end time. RTO is end time minus decision time.

### 4.5 Roll back a cutover

If production fails the smoke test after cutover:

1. Stop the deployment again `[CONFIRM: exact Replit control]` and keep it stopped through this section.
2. Neon: run instant restore again, using the backup branch `<branch>_old_<timestamp>` as the source ([Neon: instant restore](https://neon.com/docs/introduction/branch-restore), accessed 2026-10-07).
3. Replit: `[CONFIRM: whether Replit's point-in-time restore keeps the pre-restore state and how to return to it]`. A scheduled-backup restore "does not delete the current data" per Replit; ask Replit support how to switch back.
4. Last resort: restore the `pg_dump` taken in step 4.1.5 into an empty production database `[CONFIRM: procedure with Replit support]`.
5. Before starting the deployment on the rolled-back database, get the incident lead's decision. That database holds the pre-restore state, including the damage the restore was meant to remove and the sessions and reset tokens that existed then. Remove those in one `psql` session against production (`DELETE FROM password_reset_tokens; DELETE FROM sessions;`), contain the damage under the incident response plan, and only then start the deployment.
6. Record the rollback in the evidence table and open an incident if one is not already open.

### 4.6 Clean up

1. Delete the test branch or scratch database once the evidence is recorded. Neon backup branches count toward storage until deleted, and some cannot be deleted ([Neon: instant restore](https://neon.com/docs/introduction/branch-restore), accessed 2026-10-07).
2. Delete local copies of the `pg_dump` file and the user snapshot once they are stored in the restricted location.
3. Stop the test API server and the Vite frontend dev server.

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

- each count is no higher than the production baseline, unless the record explains the excess by rows deleted after the restore point. A correct restore brings those rows back, so it can hold more rows than production holds now. Deletions that raise restored counts: users removed through `DELETE /api/admin/users/<id>`, and documents removed by a purge, which also removes their versions and chunks. Find them in the `security_events` exported in step 4.1.4, or for a scheduled test run against production: `SELECT occurred_at, action, resource_id FROM security_events WHERE occurred_at > '<restore point>' AND outcome = 'success' AND (action = 'document.purge' OR resource_id LIKE 'DELETE /api/admin/users/%') ORDER BY sequence;`. Count only rows with `outcome = 'success'`. The audit middleware also records refused and failed requests, with `outcome` set to `denied` (HTTP status 400 to 499) or `failure` (500 and above), and those deleted nothing. A purge writes its `document.purge` event in the same transaction as the delete, so that event exists only for a completed purge. A higher count that no recorded deletion explains fails;
- `chunks` can also differ because a version's chunks were replaced after the restore point. A rescan (`POST /api/documents/<versionId>/rescan`, allowed only for a quarantined or failed version) queues the version for ingestion again, and ingestion deletes the version's chunks and inserts a new set in one transaction (`artifacts/api-server/src/lib/ingestion/run.ts`). The re-ingest script (`scripts/src/reingest.ts`) does the same for every active, ready version, or one program's with `--program`, and the new set can have a different number of chunks. The target then holds the chunk set from before the replacement, which can be larger or smaller than production's, with no purge or user delete behind it. A rescan appears in `security_events` as an `http.security_mutation` event with `resource_id` `POST /api/documents/<versionId>/rescan` and `outcome = 'success'`. The re-ingest script writes no security event. Find both from the chunk timestamps instead: replaced chunks get a new `created_at`. Run against production:

  ```sql
  SELECT c.document_version_id, count(*) AS production_chunks,
         min(c.created_at) AS chunks_written_at
  FROM chunks c
  JOIN document_versions dv ON dv.id = c.document_version_id
  WHERE dv.uploaded_at <= '<restore point>'
  GROUP BY c.document_version_id
  HAVING min(c.created_at) > '<restore point>'
  ORDER BY chunks_written_at;
  ```

  Each row is a version that existed at the restore point and whose current chunks were all written after it: a rescan, a re-ingest, or a first ingestion that finished after the restore point. Run `SELECT document_version_id, count(*) FROM chunks WHERE document_version_id IN (<listed ids>) GROUP BY document_version_id;` on the target and record the per-version difference. The `chunks` count difference passes when these per-version differences, together with recorded deletions and uploads after the restore point, account for it. The same rows explain why the target holds more chunks than the "as of restore point" `chunks` count from step 4.1.3, which leaves out every replaced chunk;
- tables with timestamps match the "as of restore point" counts recorded in 4.1.3, or differ only by rows explained in the record;
- tables that only grow (`security_events`, `query_log`) are within 10% of their restore-point counts (proposed tolerance);
- `users`, `programs`, and `documents` are not zero unless production is also zero.

Pass, for path C: counts equal the export-time counts captured immediately before the `pg_dump` in step 4.1.5, not the step 4.1.3 baseline, which was taken earlier and can differ because of writes made in between. Any difference is explained in the record by writes made between that count query and the start of `pg_dump`.

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

Against the target, with the isolation settings from section 3. The API server serves the built frontend only when `NODE_ENV=production`, which section 3 forbids, so the test runs the Vite dev server in front of the API, as in local development. Run both from a repository checkout on a machine whose firewall does not expose these ports: the Vite dev server listens on all interfaces and accepts any host name, and it will serve restored production data.

1. In one shell, with `DATABASE_URL` set to the target, `RAG_STORAGE_DRIVER=memory`, `LOCAL_LOGIN_MODE=enabled`, and no `OIDC_*` variable set (section 3), start the API server on port 3001:

   ```
   API_PORT=3001 pnpm --filter @workspace/api-server run dev
   ```

   PowerShell:

   ```
   $env:API_PORT = '3001'; pnpm --filter @workspace/api-server run dev
   ```

   Startup must log `[api-server] listening on http://0.0.0.0:3001`.
2. In a second shell, start the frontend on port 5173, pointed at that API:

   ```
   API_PORT=3001 PORT=5173 pnpm --filter @workspace/rag-app run dev
   ```

   PowerShell:

   ```
   $env:API_PORT = '3001'; $env:PORT = '5173'; pnpm --filter @workspace/rag-app run dev
   ```

   `artifacts/rag-app/vite.config.ts` reads `API_PORT` to proxy `/api` to `http://localhost:3001` and `PORT` for its own port. Set both explicitly: each defaults to a different port when unset (API 5000, frontend 5173). The frontend needs no `DATABASE_URL`.
3. Use two origins:
   - API origin, `http://localhost:3001`: `GET http://localhost:3001/health` returns `{"ok":true}`. The Vite proxy forwards only `/api`, so `/health` on the frontend origin does not reach the API.
   - Browser origin, `http://localhost:5173`: every browser step below. Outside production the session cookie is not marked Secure, so plain HTTP works, and the API accepts sign-in and other mutations from the origin the Vite proxy forwards.
4. In the browser, sign in as a super user. The admin Documents, Users, and Security pages load.
5. Sign in as a CSR test account in a test program `[CONFIRM: a synthetic test program, its documents, and a CSR test account exist in production]` and ask a question whose answer is in that program's documents. The answer has at least one citation, and opening it shows the cited excerpt.
6. Ask a question that only another program's documents can answer. The answer is a refusal.
7. Optional, costs provider tokens: `pnpm --filter @workspace/scripts run eval -- --limit 5` with `DATABASE_URL` set to the target. No new failures compared with the last production eval run.

`GET /api/admin/observability/security-audit` on the test instance reports `deliveryConfigured: false`; that is expected with the SIEM webhook unset.

After cutover, repeat the health check and steps 4 to 6 against production, at its deployment URL and with the worker running, and check that `GET /api/admin/observability/security-audit` shows the SIEM backlog draining.

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
