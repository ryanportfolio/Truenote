# Pre-provider input firewall control record

**Recorded:** 2026-07-16  
**Evidence grade:** Verified  
**Scope:** Portable repository boundary tests; deployment/runtime evidence pending

## Control objective

Sensitive text must be transformed inside Truenote before it is sent to an AI
text provider. The control is defense in depth for OpenRouter and closes the
previously unprotected deterministic-data path to direct OpenAI embeddings and
Cohere reranking.

## Implemented boundary

`protectProviderText()` runs synchronously immediately before these provider
requests are constructed:

- OpenAI embedding batches;
- Cohere rerank queries and candidate documents;
- OpenRouter answer-generation system/user messages; and
- OpenRouter follow-up rewrite and session-naming system/user messages.

It redacts these deterministic classes:

- private-key blocks, AWS-style keys, and OpenAI-style keys;
- valid US SSN patterns and Luhn-valid payment-card numbers;
- email-address patterns;
- structured phone patterns containing recognizable separators or parentheses;
- syntactically valid IPv4 addresses; and
- syntactically valid IPv6 addresses.

Findings contain rule identifiers and counts only. They do not retain matched
values. After transformation, the firewall reruns the blocking sensitive-content
scanner. If a blocking PII/secret rule remains, it throws a safe firewall error
instead of sending the request.

## Explicit non-coverage

This control does **not** claim reliable detection of:

- person names or street addresses;
- unseparated phone/account-number ambiguity;
- obfuscated, encoded, fragmented, multilingual, or contextual PII;
- raw PDF/image/file bytes sent to storage, malware scanning, or LandingAI before
  parsed text exists; or
- provider retention, processing location, subprocessors, or contractual use.

Names and addresses require an approved contextual entity-recognition/DLP control
or an approved prohibition/data-handling policy. OpenRouter screenshots show its
own name/address guardrail configuration, but assignment and runtime effectiveness
remain separate evidence.

## Repository evidence

- `artifacts/api-server/src/lib/security/provider-input-firewall.ts`
- `artifacts/api-server/src/lib/ingestion/embedder.ts`
- `artifacts/api-server/src/lib/retrieval/rerank.ts`
- `artifacts/api-server/src/lib/generation/answer.ts`
- `artifacts/api-server/src/lib/generation/utility-model.ts`
- `artifacts/api-server/src/lib/security/__tests__/provider-input-firewall.test.ts`
- `artifacts/api-server/src/lib/ingestion/__tests__/embedder.test.ts`
- `artifacts/api-server/src/lib/retrieval/__tests__/rerank.test.ts`
- `artifacts/api-server/src/lib/generation/__tests__/answer.test.ts`

API and scripts TypeScript checks passed after implementation. A config-independent
Node test suite passed 7/7 tests: six input-boundary cases and one adjacent
model-output case. The six input cases directly captured the payload supplied to
injected OpenAI, Cohere, and OpenRouter clients. They proved every claimed
deterministic class was removed without raw findings and that contextual
name/address coverage is not claimed. The equivalent API Vitest files did not
start in the Codex sandbox because esbuild could not read the Vite configuration
path; hosted CI still must execute those files for the released commit.

Portable acceptance evidence:

- `scripts/src/provider-input-firewall.test.ts`
- `scripts/package.json#scripts.test`
- result: 7 tests passed, 0 failed on 2026-07-16

The seventh portable case covers the adjacent
[`model-output sensitive-data control`](./model-output-sensitive-data-handling.md).
It does not expand the input firewall's claimed classes.

## Required acceptance evidence

1. Product Security and the PCI/data owner approve prohibited/allowed data and
   false-positive behavior.
2. The portable and API unit/boundary tests pass in hosted CI for the released
   commit.
3. Synthetic canaries prove raw values are absent from the exact downstream
   OpenAI, Cohere, and OpenRouter requests.
4. A retrieval/evaluation corpus measures unacceptable search-quality loss caused
   by redaction and records the approved disposition.
5. Adversarial testing covers encodings, fragmentation, multilingual values,
   names, addresses, prompt injection, and failure behavior.
6. Every remaining PII class is covered by an approved contextual control,
   prohibited by policy, or tracked as a time-bounded accepted risk.
7. An independent tester retests the deployed path and the owner retains the
   report, findings, remediation, and closure evidence.

The correct present claim is **Verified for portable repository boundary
tests**—not deployed effectiveness, complete PII protection, independent
verification, PCI compliance, or certification.
