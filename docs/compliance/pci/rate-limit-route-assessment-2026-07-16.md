# Rate-limit route assessment — 2026-07-16

**Status:** Engineering assessment and local remediation; owner approval,
capacity evidence, integrated CI, and runtime proof remain incomplete  
**SARIF source:** Actions run `29468537629`, commit `32d0b1b754753b3d7fe1cc057c3394105fe44eac`  
**Register group:** TN-VULN-2026-004 (`js/missing-rate-limiting`, 40 results)

This document classifies every reported route group. It does not close or accept
any alert. CodeQL may not recognize custom controls, and a route being
authenticated or inexpensive does not by itself prove availability protection.

## Control design added locally

The existing `security_rate_limits` table now supports separate Postgres-backed,
per-user workload buckets. Denials return `429`, set `Retry-After`, and create a
best-effort `workload.rate_limited` security receipt. Missing P0/P1 rate-limit DDL
fails through the existing security-readiness error rather than silently allowing
the expensive operation.

Default one-hour buckets:

| Workload | Routes | Default per user |
|---|---|---:|
| Document processing | `POST /api/documents/upload`, `POST /api/documents/:versionId/rescan` | 60 |
| Evaluation runs | `POST /api/admin/evaluations/runs` | 10 |
| Bulk invitations | `POST /api/admin/users/bulk` | 5 requests, each already capped at 100 users |
| Credential administration | `POST /api/admin/users`, `POST /api/admin/users/:id/reset-password` | 60 combined |
| Password rotation | `POST /api/auth/change-password` | 10 |

These counters use authenticated user IDs, not source IPs. That choice prevents
one employee from consuming another employee's allowance when a call center uses
one shared egress address. Login and forgot-password retain their specialized
IP/email controls; answer generation retains per-user and per-program distributed
limits.

The defaults are provisional engineering bounds, not proven production capacity.
They are configurable only through named positive-integer environment settings.

## All SARIF route groups

| Reported location(s) | Method/path | Existing or local control | Engineering disposition | Remaining evidence/action |
|---|---|---|---|---|
| `app.ts:64` | `GET /assets/*` compressed static asset | Flat filename allowlist, fixed root, immutable cache; no app request limiter | Edge/static capacity class | Verify CDN/edge abuse control and load behavior; application DB limiter would add needless cost to static delivery |
| `auth.ts:118` | `POST /api/auth/login` | Existing generous per-IP sliding window before Argon2 | Specialized limiter exists | Verify trusted proxy/IP behavior and shared-office load threshold |
| `auth.ts:269` | `POST /api/auth/change-password` | Authenticated; local distributed per-user password-change bucket | Locally remediated | Integrated CI/CodeQL and runtime 429/audit receipt |
| `ask.ts:566,638` | `POST /api/ask`, `/api/ask/stream` | Existing Postgres per-user and per-program limits before model work | Specialized limiter exists | Multi-replica/runtime receipt and hosted CodeQL disposition |
| `ask.ts:775,805` | Feedback and missing-content flags | Authenticated CSR; bounded validation and one-row updates | Low-amplification mutation | Owner decides whether general authenticated mutation/edge policy covers it |
| `documents.ts:347,845` | Upload and rescan | Manager+, demo writes blocked; local shared document-processing bucket before multipart parsing/queue work | Locally remediated | Capacity test with maximum files, 429/audit receipt, hosted scan |
| `documents.ts:143,558` | List and preview | Manager+, scoped/classified reads; bounded result/file response | Authenticated read class | Load-test and cover with approved edge/read policy if required |
| `documents.ts:303,699,800,901,965,1051` | Source creation, approve, reject, revoke, retire, purge | Manager+ or senior/super-user gates, lifecycle checks, CSRF, demo-write denial, audit; no route limiter | Privileged bounded mutation class | Owner reviews request cost and decides general privileged-mutation or edge control; purge needs explicit resilience test |
| `evaluations.ts:393` | `POST /api/admin/evaluations/runs` | Super-user, one active run/program, max 250 questions; local distributed run bucket | Locally remediated | Capacity/provider-budget test, runtime 429/audit receipt, hosted scan |
| `users.ts:219,358,775` | Create, bulk invite, reset password | Manager+, role/program checks; local credential/bulk buckets before Argon2 loops | Locally remediated | Shared-office admin load test, runtime receipt, hosted scan |
| `users.ts:133,589,864` | List, patch, delete users | Manager+, target/role/program/TOCTOU controls, demo-write denial | Bounded admin read/mutation class | Owner decides general admin/edge limit; verify large user-list and deletion load |
| `errors.ts:165` | Delete retained error rows | Super-user, bounded request schema, mutation audit | Privileged maintenance class | Add operational maintenance limit if load test shows lock/IO risk |
| `model-routing.ts:47` | Update approved route order | Super-user, server allowlist, demo-write denial | Low-frequency privileged mutation | Edge/admin policy or written owner rationale |
| `security.ts:160` | Toggle malware-scanning policy | Super-user, audited explicit state, demo-write denial | Low-frequency privileged mutation | Edge/admin policy or written owner rationale |
| `insights.ts:70`, `queries.ts:63`, `programs.ts:47` | Admin reads | Manager+, program scope, bounded query/list behavior | Authenticated reporting/read class | Load-test expensive aggregates; define edge/read threshold |
| `kb.ts:113,163,275` | KB list/document/highlight reads | Authenticated CSR, program/classification/lifecycle filters | Authenticated read class | Load-test and define user/edge read policy |
| `kb.ts:325,473,526` | Create/update/delete personal highlights | Authenticated CSR, ownership/scope checks, bounded payload | Low-amplification personal mutation | Owner decides general authenticated mutation/edge policy |
| `sessions.ts:67,101`, `me.ts:12` | Session history/current-user reads | Authenticated, user/program scoped, bounded | Authenticated read class | Edge/read capacity decision |
| `oidc.ts:69` | OIDC callback | Signed short-lived state cookie, PKCE, issuer/token/JWKS checks | Public identity callback class | IdP/edge rate protection and invalid-callback abuse test required |

The table groups identical control classes for repository readability. The
restricted finding system must retain all 40 exact SARIF locations and one final
disposition per result.

## Threshold acceptance plan

Security/Platform should approve thresholds only after a staged test that proves:

1. expected shift-change, admin onboarding, document-import, and evaluation bursts
   complete without unintended `429` responses;
2. one authenticated actor crossing each threshold receives `429` and a correct
   `Retry-After` without starting multipart parsing, Argon2, queue, or provider work;
3. two users behind one IP have independent allowances;
4. counters remain consistent across at least two API replicas;
5. a denial creates a redacted audit/outbox receipt and the SIEM alert path works;
6. expired windows no longer deny work and stale counter cleanup is operational;
7. public/static/OIDC and authenticated read traffic have an approved edge or
   application capacity control; and
8. every SARIF result has an approved disposition, evidence link, reviewer, and
   expiry where an exception is used.

## Current claim boundary

Repository logic and tests establish the local control design. They do not prove
production thresholds, deployed DDL, multi-replica behavior, edge protection,
alert delivery, hosted CodeQL closure, or PCI control effectiveness.
