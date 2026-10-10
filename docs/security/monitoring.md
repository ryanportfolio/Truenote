# Security monitoring, alerts and log retention

Truenote's log review, alerting and availability monitoring. It addresses NIST SP 800-53 Rev. 5 Moderate AU-5, AU-6, AU-6(1), AU-6(3) and SI-4, and the readiness part of CA-7 (POA&M items POAM-2026-012 and POAM-2026-013).

Status, 2026-10-10: the code is in the repository but not deployed. The steps under "Turning it on" need the owner's go. The off-Railway log copy and the uptime check live in the private repository `ryanportfolio/truenote-ops` (created 2026-10-10). Its uptime check runs against `/health` until `/health/ready` is deployed; its log export waits for the `RAILWAY_TOKEN` secret.

## Design decisions

The owner's decisions on 2026-10-10:

- No new log vendor. Railway keeps logs for 30 days on the Pro plan. A daily job in the private repository `ryanportfolio/truenote-ops` exports them and commits them there, so a copy exists outside Railway.
- Alerts are sent from Truenote itself, by email through Resend, which the app already uses.
- An uptime check in the same private repository opens an issue there when Truenote is down. GitHub emails the owner about the new issue. The Truenote repository is public, so outage issues do not go there.
- The SIEM delivery outbox is retired. Its code and `docs/security/p1-siem-delivery-outbox.sql` were removed; `lib/db/sql/0013_drop_siem_delivery_outbox.sql` drops its empty table. Security events reach the log through the security monitor below.
- The retention period (AU-11) stays open until the employer names the framework it assesses against. NIST 800-53 Moderate leaves the period to the organization; FedRAMP Moderate (OMB M-21-31) and PCI DSS 10.5.1 require 12 months. Until then, nothing deletes the exported logs.

## Where records live

| Record | Where | How long |
|---|---|---|
| `security_events` (hash-chained) | `pgvector`, table `security_events` | Indefinitely. Triggers refuse UPDATE, DELETE and TRUNCATE from every role (`lib/db/sql/0008_security_events_append_only.sql`) |
| web and worker output, including one `[security-event]` line per security event | Railway logs | 30 days (Pro plan) |
| Railway HTTP logs (method, path, status, client IP; no query string) | Railway logs | 30 days |
| `pgvector` connection logs | Railway logs | 30 days |
| Daily export of the four log streams above, every deployment of each service (`railway logs` returns one deployment at a time) | Private repository `ryanportfolio/truenote-ops`, `logs/YYYY/MM/DD/` | Until the AU-11 decision; nothing deletes them |

On 2026-10-10 the four Railway log streams added up to about 0.9 MB a day, mostly `pgvector` connection lines.

## Security monitor

`artifacts/api-server/src/lib/monitoring/security-monitor.ts` runs in the `worker` once a minute:

1. It reads `security_events` rows with a `sequence` above its cursor (table `security_monitor_state`, `lib/db/sql/0011_monitoring_state.sql`), at most 200 a pass, and prints each as one `[security-event] {json}` line. `append_security_event` takes a transaction-scoped advisory lock before inserting, so rows commit in sequence order and the cursor cannot pass a row that commits later. The cursor starts at 0, so the first passes print the whole existing chain.
2. It checks those rows and the last 15 minutes against the rules below, prints one `[security-alert] {json}` line per alert, and emails all alerts from the pass as one message to `SECURITY_ALERT_EMAIL`.
3. It advances the cursor only after the email was sent. If sending fails, the next pass prints and checks the same rows again; the event `id` identifies the repeated lines.

A session advisory lock keeps two workers (old and new, during a deploy) from processing the same batch. A pass that has not finished after 2 minutes is abandoned and counted as failed; while it still holds the lock, later passes fail too, so a stalled database or email call ends in the `security_monitor_failing` alert. Email sends time out after 30 seconds.

Rows that occurred more than one hour before the cursor last advanced are printed but not alerted on. On the first pass that means rows older than one hour, so the history catch-up does not email the whole chain. Because the reference point is the cursor, a batch whose email keeps failing stays alertable, and events written while the worker was down are alerted when it comes back.

## Alert rules

| Rule | Fires on | Delivery |
|---|---|---|
| `break_glass_login` | Any `auth.break_glass.login` event | Email within about a minute |
| `super_user_login` | A successful `auth.local.login` or `auth.oidc.login` by a `super_user` | Email within about a minute |
| `account_change` | A successful `POST`, `PUT`, `PATCH` or `DELETE` under `/api/admin/users` (create, role or status change, password reset), or any `admin.user.*` event | Email within about a minute |
| `security_setting_change` | Any `security.*` event (malware scanning and demo limit switches) | Email within about a minute |
| `error_log_cleared` | `error_log.clear` | Email within about a minute |
| `failed_logins_ip` | 10 or more denied `POST /api/auth/login` from one IP address in 15 minutes | Email; at most once an hour per address |
| `failed_logins_total` | 25 or more denied logins in 15 minutes, all addresses together | Email; at most once an hour |
| `denied_spike` | 50 or more security events with outcome `denied` in 15 minutes | Email; at most once an hour |
| `audit_write_failure` | `append_security_event` failed in `web` or `worker` | Email at once from the failing process, without the database; later failures in the next 15 minutes are counted into the next email |
| `security_monitor_failing` | Five passes in a row failed | Email once until a pass succeeds |
| Health failure | `GET /health/ready` did not return 200 with the JSON body `{"ok":true}` on two attempts 60 seconds apart; checked at :07 and :37 each hour | Issue labeled `outage` in `ryanportfolio/truenote-ops`, which GitHub emails to the owner; comment and close on recovery |

A denied login is any 4xx answer to `POST /api/auth/login`: wrong password, unknown account, blocked role, or the per-IP limit. These rows record the source address but not the attempted account. Route ids are compared without regard to case or a trailing slash, because Express routes `/api/auth/LOGIN` and `/api/auth/login/` to the same handler and the audit row keeps the request's spelling.

## Readiness

- `GET /health` stays static (`{"ok":true}`). Railway's deploy healthcheck uses it, and a database or worker outage should not make Railway restart a healthy web process.
- `GET /health/ready` answers 200 `{"ok":true,"database":"ok","worker":"ok"}` when the database answers within 2 seconds and the worker wrote a heartbeat (table `service_heartbeats`) in the last 3 minutes; otherwise 503 with `database` `error`, or `worker` `stale`, `missing` or `unknown`. The worker writes the heartbeat every 30 seconds. The result is cached for 5 seconds, so a flood of requests costs at most one primary-key lookup per 5 seconds.

## What the logs must not contain

Passwords, session or reset tokens, API keys, other secrets, uploaded document content, and CSR questions stay out of every log stream.

- Railway HTTP logs record the path without the query string. A request to `/health?logprobe=qs-check-20261010` on 2026-10-10 was logged as `/health`, so `/reset-password?token=...` links do not reach the log.
- Security event `details` hold counts, rule ids, settings and identifiers, never request bodies (`artifacts/api-server/src/middleware/security-audit.ts`). One free-text field exists: the reason an administrator types when purging a document (`document.purge`).
- Event lines carry the actor's email, role, user id, program id and source IP. These are needed to answer who did what, from where (AU-3).

## Review

AU-6 needs a dated record that someone reviewed the alerts and logs. The proposal is a weekly review recorded as an attestation in the evidence harness, which another change builds.

## Known limits

- One person administers the application, the database, Railway and the log repository. AU-9(4) asks that a subset of privileged users manage audit logging; with one owner that is an accepted risk to record.
- Window-rule cooldowns live in worker memory. A worker restart can repeat a window alert within the hour.
- The off-Railway copy is at most one day behind. The last 30 days are always also in Railway.
- Outage detection depends on GitHub's scheduler, which can start a 30-minute job late. Expect 30 to 60 minutes.

## Turning it on

Each step needs the owner's go.

1. Apply the schema change: `node scripts/railway-apply-sql.mjs lib/db/sql/0011_monitoring_state.sql`, then the same with `--apply`.
2. Set `SECURITY_ALERT_EMAIL` on `web` and `worker` (`railway variable set SECURITY_ALERT_EMAIL --stdin --skip-deploys ...`).
3. Deploy `web` and `worker` from the same commit (`.claude/reference/deployment.md`).
4. Check: `/health/ready` returns 200; `railway logs -s worker` shows `[security-event]` lines; `security_monitor_state.last_sequence` reaches `max(security_events.sequence)`.
5. Test each alert once and record the result below.

## Alert test record

| Rule | Test | Date | Result |
|---|---|---|---|
| `break_glass_login` | Requires `LOCAL_LOGIN_MODE=break_glass`; test when SSO is enabled | | Pending |
| `super_user_login` | Agent account logs in | | Pending |
| `account_change` | Agent account resets a test user's password | | Pending |
| `security_setting_change` | Toggle the demo limit switch off and back on | | Pending |
| `error_log_cleared` | Clear the error log when it holds no needed entries | | Pending |
| `failed_logins_ip` | 10 wrong passwords for a nonexistent account from one address | | Pending |
| `failed_logins_total` | Covered by a 25-attempt run of the test above | | Pending |
| `denied_spike` | Covered by a 50-attempt run of the test above | | Pending |
| `audit_write_failure` | Needs a failing append; method to be agreed with the owner | | Pending |
| `security_monitor_failing` | Needs five failed passes; method to be agreed with the owner | | Pending |
| Health failure | Uptime check pointed at `https://truenote.org/health/ready` before that route was deployed, then back at `/health` | 2026-10-10 | Passed after one fix. The first run counted the URL as up because the SPA fallback answers unknown paths with 200 and HTML; the check now requires the JSON body `{"ok":true}`. The rerun opened `ryanportfolio/truenote-ops` issue 1; the recovery run commented and closed it at 04:53 UTC |
