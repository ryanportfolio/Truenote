# Current CodeQL alert review

**Date:** October 9, 2026  
**Source:** Authenticated GitHub code-scanning API and analysis `1920497333`  
**Reviewed main:** `e63293ca7d9da75d9749a7aef109364acfe47423`  
**Scope:** All 31 open main-branch alerts, their reported source locations, relevant callers, middleware and data flow. Source review only; no production load or adversarial tests.

## Current status

GitHub reports **31 open, eight fixed and nine dismissed alerts** on main. Its latest
successful main analysis reports 36 SARIF results across 103 rules. Raw results
and open alerts count different sets, including results that have been dismissed.
The [safe API receipt](../../security/evidence/github-codeql-status-2026-10-09.json)
retains IDs, states, rule groups, commit and analysis identity without raw messages,
source snippets or exploit details.

The July 51-result baseline is historical evidence, not today's open-alert count.
It still drives the existing management validator because individual fingerprint
reconciliation and approved dispositions have not been imported. Neither that
validator's failure nor a successful CodeQL job proves 51 present vulnerabilities.
Likewise, a passing PR check does not establish that main has no open alerts.

The application owner clarified during this review that the missing application
rate limits are intentional during the demo phase. Record this as a phase-specific
design decision, rather than an unexpected regression. This statement supplies
neither a customer-production exception nor a new launch approval. No risk expiry,
assigned person or assessor approval was invented.

## Findings checked against current source

| Alert IDs | Count | Source assessment | Evidence and limit |
|---|---:|---|---|
| 16 | 1 | False positive for the claim that login has no rate limit | `routes/auth.ts` checks `loginIpLimiter.hit` before account lookup and Argon2. The custom limiter is bounded. Its generous threshold and proxy/IP behavior still need separate operating evidence. |
| 19, 21 | 2 | False positives for the claim that answer routes have no rate limit | Both JSON and streaming handlers call `allowAskRequest`, which checks Postgres per-user and per-program counters and returns 429 before session creation or model work. This does not rate-limit feedback routes. |
| 36 | 1 | False positive for the claim that upload has no rate limit | `workloadRateLimitMiddleware("document_ingestion")` precedes multipart parsing and the upload handler. The middleware denies unauthenticated requests, returns 429 on an exhausted bucket, and forwards enforcement errors instead of proceeding. |
| 43 | 1 | False positive for the reported path-traversal flow | `compressedAssetFileName` accepts a single conservative asset basename; separators, absolute paths and encoded traversal cannot reach `existsSync`. The suffix is server-selected, and `sendFile` also uses a fixed root. This addresses traversal, not static-file abuse capacity. |
| 44, 45 | 2 | False positives for the reported authorization bypass | Missing/invalid receipt parameters leave `citationAuthorized=false`. `canServeKbVersion` then denies retired history. A successful receipt lookup binds the current user, program, query, source index, document and version; revoked/rejected versions remain denied. Active documents have a separate authorized browsing path. |
| 68 | 1 | Expected credential transmission by operator tooling, within its stated trust boundary | The SARIF flow follows local seed-account credentials into login/password-change request bodies. The seed intentionally authenticates to the configured Truenote service, uses HTTPS by default, and disables redirect following. It is not a web route or a web/worker startup job. The operator-controlled `SHOWCASE_BASE_URL` is not restricted to approved origins; validate the destination before any formal dismissal or use outside the trusted demo workflow. |
| 9, 46 | 2 | Intentional demo-phase absence of an application limiter; static delivery needs a capacity decision | The compressed-asset and PCI HTML handlers run before API authentication and have no application request limiter. Caching and a fixed root do not prove edge abuse protection. Check the intended edge/static controls before customer use. |
| 33 | 1 | Intentional demo-phase absence of an application limiter; assess before enabling SSO | The OIDC callback validates signed state, PKCE and identity before login, but has no callback request limiter. Current web OIDC configuration is absent, so this is a prerequisite for the future SSO path, not proof of a currently exposed login bypass. |
| 10, 11, 12, 13, 14, 15, 17 | 7 | Intentional demo-phase absence of application rate limits | Admin error deletion, model routing, KB-gap reporting, program/query/user reads and malware-policy changes have authorization but no applicable request limiter. New limiters on team/source-usage reads and demo-setting writes do not cover these older handlers. |
| 22, 23, 24, 30, 31 | 5 | Intentional demo-phase absence of application rate limits | Feedback, missing-content flags, current-user and session-history reads have authorization but no applicable limiter. The answer-generation counter does not cover these requests. |
| 34, 35, 37, 38, 39, 40, 41, 42 | 8 | Intentional demo-phase absence of application rate limits | Document list, source creation, preview, approve, reject, revoke, retire and purge have role/scope/lifecycle controls but no applicable limiter. The ingestion counter covers upload/rescan, not these handlers. |

Totals: **seven source-level false positives, one expected operator-tool flow,
and 23 accurate observations of missing application rate limits**. Of the 23,
20 concern authenticated API routes, one the OIDC callback and two static handlers.
Missing a limiter does not establish an exploitable denial of service or its
severity. It does mean the absence cannot be dismissed as a scanner model error.

## Keeping resolved findings out of current counts

### Release review follow-up

PR [#200](https://github.com/ryanportfolio/Truenote/pull/200) makes history
reauthorization explicit. Its separate CodeQL code-scanning check reports two
high-severity missing-rate-limiting annotations on the session list and detail
handlers. Authenticated API comparison confirms these are the same alert IDs
30 and 31 reviewed above, not two additional findings or confirmed authorization
bypasses. The four required Actions jobs passed,
but the separate scanning check did not. The owner's intentional demo-phase
decision applies to these unthrottled reads; no limiter or alert disposition was
changed. The released main scan must establish current alert IDs and counts before
combining this PR result with the earlier main snapshot.

GitHub already excludes the 21 fixed/dismissed alerts from its open list. A
verified fix followed by a current scan, or a justified dismissal, can close the
remaining applicable alerts. Closed review history should remain available.
GitHub documents [dismissal and stale-configuration removal](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts).

The seven source-level false positives are candidates for evidence-backed
dismissal. The seed flow needs its operator/destination boundary accepted. The
23 intentional demo limitations require a scoped decision, rather than a false
positive label. Before customer use, define application or verified edge coverage
and retain appropriate capacity/denial evidence for the selected release.

No GitHub alert was changed, scan disabled, rule suppressed, or historical record
deleted in this review. Updating the safe baseline must use the existing
[intake and reconciliation procedure](codeql-intake-runbook.md), which preserves
historical IDs and dispositions. Today's API receipt alone does not supply the
fingerprint-level closure approvals required by that importer.

## Verification limits

The latest-main CI ran the existing tests. Their source includes compressed-asset,
citation-access and workload-limit checks. Those tests were inspected but were
not rerun locally; this review adds no tests or runtime changes. No live login,
load test, provider call or production write was performed. No independent review
or formal PCI acceptance is claimed.
