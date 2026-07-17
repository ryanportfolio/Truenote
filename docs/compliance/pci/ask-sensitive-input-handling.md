# Ask sensitive-input handling

**Status:** Implemented in repository; deployed operation unverified  
**Evidence grade:** Verified for repository tests; Operational evidence required for production  
**Owner:** Product Security - unassigned

TrueNote blocks deterministic high-risk sensitive data in the current question
and every client-supplied conversation-history field before the text can enter
the retrieval and generation pipeline.

## Control ordering

For an authenticated, program-scoped ask request, the route performs rate-limit
accounting and then applies `blockingAskContentFindings`. A blocking finding
returns HTTP 400 before:

- chat-session creation or lookup;
- follow-up rewriting;
- embeddings, retrieval, or Cohere reranking;
- OpenRouter generation or utility calls;
- `query_log` insertion;
- citation-snapshot persistence;
- session naming; or
- answer-response assembly.

The denial audit event stores the rule ID, category, and count only. It does not
store the matched value, question, or history. The client receives a generic
instruction to remove payment-card data, SSNs, or credentials.

Relevant implementation:

- `artifacts/api-server/src/lib/security/ask-content-policy.ts`
- `artifacts/api-server/src/routes/ask.ts`
- `artifacts/api-server/src/lib/security/content-scan.ts`

## Deterministic blocking coverage

The ask policy currently blocks:

- credential-shaped secrets and supported API-key patterns;
- complete private-key blocks;
- United States Social Security number patterns; and
- payment-card candidates that pass the Luhn check.

The same policy scans the current question plus every question and answer in the
client-supplied history. This matters because history can otherwise reach the
follow-up rewrite provider even though it is not supplied to answer generation.

## Explicit limitations

This blocking gate does not claim coverage for ordinary email addresses,
structured phone numbers, IP addresses, personal names, postal addresses,
encoded or split values, or other contextual PII. Those classes can be
legitimate customer-service content and require an approved data/content policy.
The separate pre-provider firewall redacts deterministic email, phone, and IP
patterns before supported text-provider calls, but that does not make the raw
question safe to persist under every policy.

The rate-limit counter and its metadata-only denial audit may occur before the
content decision. Neither receives the question or history. Repository ordering
and unit tests do not prove the deployed build, database triggers, logging stack,
APM, reverse proxy, or hosting platform avoids request-body capture.

## Repository verification

Three focused tests verify:

1. question blocking for API-key, complete private-key, SSN, and valid
   payment-card values without raw-value retention in findings;
2. scanning of every client-supplied history question and answer; and
3. explicit non-coverage for email, phone, IP, name, and address text.

Run from the API workspace:

```powershell
& '.\node_modules\.bin\vitest.CMD' run 'src/lib/security/__tests__/ask-content-policy.test.ts'
```

## Production acceptance test

In an authorized synthetic environment, submit a unique canary for each blocked
class in the current question and separately in each history field. For every
case, retain safe evidence that:

1. the response is the generic HTTP 400 denial;
2. no session or `query_log` row is created;
3. rewrite, embedding, reranking, and generation providers receive no request;
4. application, error, proxy, APM, audit, and SIEM records contain no canary;
5. the security event contains only reviewed rule/category/count metadata; and
6. the same test passes on every released API deployment path.

Retain raw detailed evidence only in the approved restricted evidence system.
Repeat after changes to the ask route, request logging, history, content scanning,
session creation, provider calls, or telemetry.
