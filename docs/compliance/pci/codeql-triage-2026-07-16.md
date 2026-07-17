# CodeQL technical triage — 2026-07-16

**Evidence grade:** Implemented, unverified  
**Source commit:** `32d0b1b754753b3d7fe1cc057c3394105fe44eac`  
**Actions run:** `29468537629`  
**Artifact:** `truenote-codeql-sarif` / `javascript.sarif`  
**Artifact SHA-256:**
`E2A19E1B4D0DBEDA2787BA1D38C53E261085562D957A652962D70C70DACD2ABD`
**Safe finding baseline:**
[`codeql-baseline-2026-07-16.json`](codeql-baseline-2026-07-16.json)  
**Artifact availability:** ID `8363921874` verified available at
`2026-07-16T20:52:20.2196104Z`; reported expiry `2026-08-15T03:17:21Z`

This is an engineering applicability review of the retained SARIF. It is not an
approved risk acceptance, independent test, hosted CodeQL retest, or closure
record. A named Security/PCI owner must approve every final disposition, and
changed findings require a clean scan tied to the reviewed commit.

The safe baseline structurally reconciles all 51 results to the eight groups
below without exposing source locations or finding text. Its CodeQL portion of
the strict managed-release check currently fails on 51 missing owners, 51
missing due dates, and 51 pending dispositions. The broader release gate also
checks the required vulnerability-source register. This document does not supply
or infer those operational decisions.
Repeat scans use the fail-closed procedure in
[`codeql-intake-runbook.md`](codeql-intake-runbook.md); disappearance from SARIF
does not itself establish remediation or closure.

## Result summary

| Register ID | Rule / results | Technical assessment | Current action |
|---|---|---|---|
| TN-VULN-2026-001 | `js/missing-token-validation` / 1 | Likely analyzer mismatch; formal disposition pending | Independently review the application-level CSRF controls and run browser/API negative tests |
| TN-VULN-2026-002 | `js/incomplete-sanitization` / 1 | Affected | Markdown escape-order fix and regression test implemented locally; hosted retest pending |
| TN-VULN-2026-003 | `js/incomplete-multi-character-sanitization` / 2 | Test-only affected code | Risky tag-stripping regex removed locally; frontend tests pass; hosted retest pending |
| TN-VULN-2026-004 | `js/missing-rate-limiting` / 40 | Mixed: existing controls, local high-amplification remediation, analyzer mismatch, and remaining capacity/edge gaps | Approve thresholds, complete individual dispositions, verify runtime behavior, and implement approved edge/read controls |
| TN-VULN-2026-005 | `js/clear-text-logging` / 2 | Affected defense-in-depth paths | Redacted error output and non-echoing configuration warning implemented locally; hosted retest pending |
| TN-VULN-2026-006 | `js/path-injection` / 2 | Mixed: one request-derived path hardened locally; one fixed-root static handler likely analyzer mismatch | Integrate the basename/root fix, independently review build-asset assumptions, and rerun CodeQL |
| TN-VULN-2026-007 | `js/user-controlled-bypass` / 2 | Likely analyzer mismatch; formal disposition pending | Add route/database authorization tests and obtain independent review |
| TN-VULN-2026-008 | `js/log-injection` / 1 | Development-only affected path | Production fallback fails closed and development payload is now JSON-escaped to one log line; hosted retest pending |

No result is closed by this document.

## TN-VULN-2026-001 — CSRF/token validation

The alert points to the centralized Express error handler, not to a single
state-changing business route. Before route registration, `createApp()` mounts
`trustedMutationOriginMiddleware()` on `/api`. That middleware rejects untrusted
`Origin` values and cross-site/same-site Fetch Metadata on every non-safe method.
Session cookies are also `HttpOnly`, `Secure` in production, and `SameSite=Lax`.
Ten repository tests cover trusted, foreign, malformed, cross-site, same-site,
same-origin, development, production, and non-browser cases.

The middleware deliberately permits requests with neither `Origin` nor
`Sec-Fetch-Site` so non-browser automation can operate. The current design relies
on such clients not possessing a victim browser's ambient cookie and on
`SameSite=Lax` for cross-site cookie suppression. That design must be validated by
an independent browser/API test; the code evidence alone is not a formal
`Not affected` disposition.

Acceptance evidence:

- current-main integration proves middleware remains before every API route;
- cross-origin form, fetch, malformed-Origin, missing-Origin browser, and
  credentialed CORS tests produce the intended allow/deny results;
- an independent reviewer approves the no-header automation rationale; and
- hosted CodeQL is either clean or the alert is dismissed with the approved
  rationale linked to this register ID.

## TN-VULN-2026-003 — test-only HTML regex

Both alerts point to one frontend test assertion that removed HTML tags using
`/<[^>]+>/g`. Vite does not import the test module into the production entry
graph, so this was not a shipped sanitizer. The local change removes the regex
and verifies the rendered citation content and link directly. The complete
frontend suite passes with 14 files and 62 tests.

Closure still requires a hosted clean scan tied to the integrated commit and
Security/PCI owner approval of the test-only applicability rationale.

## TN-VULN-2026-004 — rate limiting

The SARIF contains 40 results across 16 files:

| File group | Results |
|---|---:|
| `app.ts` production compressed-asset handler | 1 |
| `routes/auth.ts` | 2 |
| `routes/ask.ts` | 4 |
| `routes/documents.ts` | 10 |
| `routes/kb.ts` | 6 |
| `routes/sessions.ts` | 2 |
| `routes/admin/users.ts` | 6 |
| Seven other admin route files | 7 |
| `routes/me.ts` and `routes/oidc.ts` | 2 |
| **Total** | **40** |

Existing controls are material but incomplete:

- login has a bounded per-IP in-memory limiter designed around shared call-center
  egress;
- forgot-password has per-IP and per-email limits;
- answer generation has Postgres-backed per-user and per-program limits that work
  across replicas; and
- local changes add separate Postgres-backed per-user buckets for document
  processing, evaluation runs, bulk invitations, credential administration, and
  password changes, with `Retry-After` and audit receipts; and
- most reported business routes are behind authentication, fresh-password, role,
  program, or classification checks.

CodeQL does not recognize all custom controls and also reports read-only/static
handlers. The local route assessment now classifies every reported group and
protects the confirmed high-amplification operations. However, Truenote still has
no approved universal edge/read availability policy, no approved production
thresholds, and no retained capacity, multi-replica, or runtime `429` receipt.
Therefore the group cannot be dismissed as analyzer noise or closed.

Required design work:

See [`rate-limit-route-assessment-2026-07-16.md`](rate-limit-route-assessment-2026-07-16.md)
for the full classification and acceptance plan. Remaining required work:

1. Export all 40 result locations into the restricted finding system and assign
   an owner/disposition to each result.
2. Classify each endpoint by authentication, mutation/read, cost amplification,
   data volume, privilege, shared-IP behavior, and safe failure mode.
3. Keep credential, workload, and AI-spend controls specialized; tune the local
   distributed per-user limits and define edge/IP limits for appropriate
   unauthenticated/static traffic.
4. Do not introduce a low global per-IP limit that can lock out a call center
   behind one egress address.
5. Load-test approved thresholds, verify `Retry-After`/429 behavior, monitoring,
   audit events, multi-replica consistency, and emergency override.
6. Rerun CodeQL, manually reconcile every result, and retain approved exceptions
   with owner, expiry, and compensating controls.

## TN-VULN-2026-006 — static-file paths

One alert reaches compressed-asset serving from the wildcard request path. The
local remediation now accepts only one conservative Vite asset basename with a
compressible extension, appends only the server-chosen `.br` or `.gz` suffix,
requires the file beneath the fixed asset root to exist, and calls
`res.sendFile()` with Express's fixed `root` option. Three regression tests cover
valid files plus traversal, absolute, nested, encoded, control-character, hidden,
and unsupported-extension paths. The second alert is the fixed-root
`express.static(dist)` middleware and is likely an analyzer mismatch.

Acceptance evidence must still cover the integrated HTTP behavior for encoded
and decoded traversal, separator variants, nonexistent files, compression
negotiation, and the assumption that the controlled build output contains no
attacker-created symlink. Current-main also changed SPA/CSP serving, so testing
must target the integrated version.

## TN-VULN-2026-007 — citation authorization guard

The two alerts point to optional `version`, `query`, and `source` inputs that
control whether a citation-receipt lookup runs. If those inputs are missing or
invalid, `citationAuthorized` remains false. `canServeKbVersion()` then permits
only the current active version; retired history requires an authorized receipt,
and revoked/rejected versions are always denied.

The receipt query matches query owner, program, source index, cited chunk,
document, and document version. Repository unit tests verify invalid source
indices and the active/retired/revoked decision table. Formal disposition still
requires route/database tests proving that another user, another program,
mismatched source/version, missing receipt, and revoked content all fail closed.

## TN-VULN-2026-008 — development email logging

Production now refuses to construct a console sender unless both required Resend
settings are present. Development still prints the plaintext body so a developer
can follow a local reset link, but the payload is JSON-encoded and U+2028/U+2029
escaped before one `console.log` call. A regression test proves injected CR, LF,
and Unicode line separators cannot create extra physical log lines and that HTML
is not logged.

Hosted CodeQL must confirm whether the data-flow alert is eliminated. If it
remains, the reviewer must distinguish log-injection safety from the intentional,
development-only display of a reset URL and confirm that production configuration
fails closed.

## Required approval record

For each result, retain: final applicability, owner, rationale, compensating
controls, remediation or exception, approver, approval date, expiry/review date,
integrated commit, hosted scan result, and independent retest where required.
