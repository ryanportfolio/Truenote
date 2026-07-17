# Model-output sensitive-data handling

**Status:** Implemented in repository; deployed operation unverified  
**Evidence grade:** Verified for portable repository tests; Operational evidence required for production  
**Owner:** Product Security - unassigned

TrueNote validates the complete non-streamed model answer before it can be
returned to the user or written to query history. This is separate from the
pre-provider input firewall and OpenRouter guardrails.

## Current control path

1. An approved ZDR-only OpenRouter route returns a complete answer candidate.
2. `validateGeneratedAnswer` scans the candidate before citation normalization
   can produce an accepted answer payload.
3. A blocking PII or secret finding returns `sensitive_output` with no accepted
   payload. The diagnostic copy is replaced with
   `[redacted: sensitive output blocked]`.
4. Generation treats that candidate as an invalid provider attempt and advances
   to the next approved ZDR route.
5. If no route returns a valid safe answer, TrueNote returns the standard canned
   refusal. Only the accepted safe answer or refusal reaches the query-log and
   API-response path.

Relevant implementation:

- `artifacts/api-server/src/lib/generation/answer.ts`
- `artifacts/api-server/src/lib/security/content-scan.ts`
- `artifacts/api-server/src/routes/ask.ts`

## Deterministic coverage

The blocking output scan covers:

- credential-shaped secrets and supported API-key patterns;
- complete private-key blocks;
- United States Social Security number patterns; and
- payment-card candidates that pass the Luhn check.

The portable test directly supplies each class with an otherwise valid source
citation and verifies that the candidate produces no answer payload, exposes
only the redacted diagnostic marker, and does not retain the raw candidate in
the validation result.

## Explicit limitations

The output scan does not currently claim deterministic blocking for ordinary
email addresses, structured phone numbers, IP addresses, personal names, or
postal addresses. Email, phone, and IP redaction exists on provider input, but
output policy may differ because cited knowledge-base answers can legitimately
contain approved contact information. Product Security and the data/content
owner must decide which output classes should be blocked, redacted, or permitted
when supported by authorized source content.

Repository tests do not prove the deployed route uses the reviewed build, that
every runtime response passes this function, or that provider and logging
configuration operate as expected. They are not an independent red team or PCI
assessment.

## Verification

Run from the repository root:

```powershell
& '.\scripts\node_modules\.bin\tsx.CMD' --test '.\scripts\src\provider-input-firewall.test.ts'
```

## Production acceptance test

In an authorized synthetic environment, make each approved generation route
return unique synthetic secret, private-key, SSN, and valid test-card canaries
with an otherwise valid citation. For every attempt, retain safe evidence that:

1. the raw canary was absent from the API response, query history, application
   logs, error diagnostics, telemetry, and sanitized test report;
2. the route was rejected as `sensitive_output`;
3. fallback stayed inside the approved ZDR route chain; and
4. complete route-chain failure returned only the standard refusal.

Repeat after changes to content scanning, generation validation, route fallback,
query logging, or response serialization. Retain raw detailed evidence only in
the approved restricted evidence system.
