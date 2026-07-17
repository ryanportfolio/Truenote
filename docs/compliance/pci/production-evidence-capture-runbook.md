# Production security-control evidence capture

**Status:** Operator runbook; execution evidence not yet collected  
**Owner:** Platform/database owner — unassigned  
**Required approvers:** Change authority, Security, and PCI scope owner/QSA as
applicable

This runbook collects production evidence for repository-defined security
controls without exporting application rows. Running it does not apply DDL,
change configuration, prove CDE segmentation, or establish PCI compliance.

## Evidence handling rules

- Execute only under an approved change/evidence ticket and in the intended
  environment.
- Use a named read-only evidence role for the catalog query. Do not substitute a
  super-user merely for convenience.
- Store raw output in the approved restricted evidence system. Do not commit
  production output, hostnames, account identifiers, prompts, content, PAN, PII,
  credentials, tokens, or webhook payloads to this repository.
- Record the released commit, deployment identifier, environment label, operator,
  reviewer, UTC time, command/query hash, result hash, and restricted-system
  evidence identifier.
- Stop on an unexpected result. Do not repair production interactively during an
  evidence session; open a reviewed forward-fix change.

## 1. Common preconditions

The evidence owner confirms:

- [ ] The application release commit and deployment identifier are known.
- [ ] The read-only database role and approved query path are available.
- [ ] The exact deployed application runtime database role is approved and can
      be supplied through `truenote.evidence_runtime_role`. The evidence
      operator does not assume that runtime role.
- [ ] The P0/P1 and SIEM DDL versions tied to the release are approved.
- [ ] Security-approved non-live test values are available; no real customer or
      cardholder data will be used.
- [ ] SIEM, OpenRouter, platform, and application observers are available for the
      runtime exercises that require them.

Any unchecked prerequisite blocks execution.

### 1.1 Scope-trace authorization

Before tracing any `TN-FLOW-*` path, also confirm:

- [ ] The exact controlled record passes with
      `--require-stage provisional_test_authorization`; its restricted
      authorization evidence is independently available to operator and reviewer.
- [ ] The intended environment and target match
      `syntheticTestAuthorization.environmentReference`.
- [ ] Synthetic tenant/program and accounts match `testAccountReference`.
- [ ] Every traced stable flow is in `authorizedFlowIds`; no excluded/unlisted
      flow will be exercised.
- [ ] Current UTC time is between `issuedAt` and `expiresAt`.
- [ ] `syntheticDataOnly=true`, `panProhibited=true`, and
      `destructiveTestingProhibited=true` remain true.

The provisional record authorizes only this bounded stable-flow trace. It does
not authorize the workload, credential-administration, SIEM failure, catalog, or
other exercises below merely because they share this runbook.

### 1.2 Other evidence exercises

For each non-trace exercise, the approved change/evidence ticket must separately
name the exact operation, environment, synthetic accounts/data, reversible test
method, observers, stop conditions, and time window. Do not map evaluation runs,
invitations, user creation/reset, password changes, or failure injection onto an
unrelated `TN-FLOW-*` ID. An unchecked exercise-specific authorization blocks
that exercise without blocking independently authorized read-only collection.

The provisional scope record is not
final PCI scope acceptance, deployment approval, permission to use PAN/customer
data, or proof of segmentation effectiveness. After the trace is reconciled,
the operator records the controlled start/completion times, exact traced flow
set, restricted receipt reference, and receipt SHA-256. The accountable parties
must issue a separate `final_scope_acceptance` record linked to the exact
provisional ID/hash and supply the final record, provisional record, and completed
[`safe trace receipt`](./synthetic-trace-receipt-template.json) to the final-stage
validator. Keep raw prompts/content and detailed provider artifacts only in the
restricted evidence system referenced by that safe receipt.

## 2. Identify the query exactly

Use
[`production-control-verification.sql`](./production-control-verification.sql).
Before execution, calculate its SHA-256 using an approved workstation tool and
record the result. Examples:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath docs/compliance/pci/production-control-verification.sql
```

```sh
sha256sum docs/compliance/pci/production-control-verification.sql
```

The SQL begins a read-only transaction, applies short statement/lock timeouts,
reads PostgreSQL catalogs, and commits. It does not select application rows.
Before execution, set `truenote.evidence_runtime_role` in the approved client
session to the exact deployed application runtime role. Keep the role name and
session command in restricted evidence. The SQL resolves that named role for
privilege checks while remaining connected as the read-only evidence role; a
missing or invalid setting fails those rows. Security-definer functions must
also match the exact approved `search_path` order from repository DDL.

## 3. Execute the catalog verification

Run the exact reviewed SQL through the approved database console/client with raw
results exported directly to restricted evidence storage.

Acceptance requires:

1. every first-result-set row has `passed = true`;
2. all expected tables, columns, validated constraints, valid/ready indexes,
   functions, enabled triggers, and privilege checks appear exactly once;
3. security-definer functions report a fixed `search_path` where required;
4. SIEM mutation functions are not executable by `PUBLIC`, the runtime role can
   execute only the intended claim/complete/fail/health functions, and the outbox
   has no `PUBLIC` table privilege;
5. a qualified reviewer compares the retained definitions and SHA-256 values in
   the second result set with the approved repository DDL; and
6. the exported result file is hashed and linked from a completed structured
   [`JSON result record`](./production-control-verification-record-template.json),
   with the Markdown companion used only for human review notes.

Any `passed = false`, missing definition, unexpected overload, privilege drift,
or definition mismatch is a finding. It is not converted to a pass by explanation
alone.

## 4. Exercise workload throttles

Use the approved synthetic tenant/accounts and the deployed threshold values.
Do not expose unrelated deployment secrets in evidence.

For each operation below, capture request ID, synthetic actor, UTC time, response
status, `Retry-After` when applicable, and downstream work-start evidence:

| Operation | Required result |
|---|---|
| Document upload/rescan | Requests through the approved limit succeed; the next request returns `429` before multipart parsing, scanner, parser, embedding, or queue work begins |
| Evaluation run | Requests through the approved limit succeed; the next request returns `429` without creating or enqueueing a run |
| Bulk invitation | Requests through the approved limit succeed; the next request returns `429` before Argon2/token/email work |
| User creation/reset | Requests through the shared credential-administration limit succeed; the next request returns `429` before Argon2/token/email work |
| Password change | Requests through the approved limit succeed; the next request returns `429` before password hashing/update work |

Then prove:

- two users behind the same source IP have independent allowances;
- one user receives a consistent decision across at least two API replicas;
- the allowance resets after the window;
- every denial produces a redacted `workload.rate_limited` audit receipt; and
- stale counter cleanup is scheduled and evidenced.

Do not lower thresholds or disable controls solely to simplify the test. Capacity
owners must approve thresholds against expected shift-change, import, and
evaluation bursts.

## 5. Exercise audit and SIEM delivery

Trigger an approved, reversible security event using the application—not a direct
insert. Capture only synthetic identifiers and redacted metadata.

Acceptance requires:

- an append-only security event with request correlation;
- a transactional outbox row for the same event;
- a signed receiver request accepted by the configured SIEM;
- delivery state reaching `delivered`;
- the corresponding SIEM search/alert receipt;
- a controlled receiver failure demonstrating retry and then recovery; and
- a controlled maximum-attempt exercise demonstrating dead-letter visibility and
  the documented responder path.

Detailed webhook bodies, signing keys, and exploit material remain restricted.

## 6. Exercise the local provider firewall and OpenRouter guardrails separately

Follow
[`provider-input-firewall.md`](./provider-input-firewall.md) using approved
synthetic values. Capture sanitized downstream request evidence for OpenAI
embeddings, Cohere reranking, OpenRouter generation, and OpenRouter utility calls.
For each implemented deterministic class, prove the raw value did not leave
Truenote. Exercise the blocking-rule fail-closed path and record search/evaluation
quality against an approved false-positive corpus. Test names, addresses,
obfuscation, encoding, and fragmentation as expected gaps or approved contextual
controls; do not silently count them as covered.

Follow
[`openrouter-guardrail-evidence.md`](./openrouter-guardrail-evidence.md) with
Security-approved non-live canaries. Retain configuration/assignment evidence and
runtime receipts showing what left Truenote, what the guardrail transformed or
blocked, and whether the model/provider received the original value. Test input
redaction, prompt-injection handling, and output handling separately.

The supplied screenshots and local implementation do not satisfy these runtime
exercises by themselves.

Run the fixed synthetic suite from
[`ai-adversarial-regression.md`](./ai-adversarial-regression.md) against the same
named release and authorized non-production environment. Retain only its sanitized
report plus restricted monitoring/provider artifact references. Every case must
pass; failures enter the vulnerability/change process and require retest. This
internal execution does not replace the independent AI red-team engagement.

## 7. Close or escalate

The evidence owner and independent reviewer complete the result record. A passing
catalog query plus runtime exercises can support production-operation claims only
for the named release, environment, time, and tested scope.

Failures enter the vulnerability/change process with an owner, risk, due date,
secure forward-fix/rollback plan, and retest. Never edit a raw evidence artifact;
retain a new version and preserve the original hash.

## 8. Validate structured applicability and results

The JSON template contains every stable exercise ID and intentionally fails
until completed. Each exercise must be exactly `required` or `not_applicable`.
A required exercise must be `passed` with a distinct authorization, operator,
independent reviewer, restricted evidence reference, and SHA-256. A
not-applicable exercise must be `not_run`, carry a substantive approved basis,
and contain no fake execution artifact. Dependency checks prevent partial
combined evidence and contradictory exclusions.

Run the combined validator with the exact final scope, provisional, and trace
bytes:

```powershell
corepack pnpm --filter @workspace/scripts run verify:production-controls -- `
  --record <production-record.json> `
  --scope <final-scope.json> `
  --provisional <provisional-scope.json> `
  --trace-receipt <trace-receipt.json>
```

The command first requires the linked scope files to pass the final-stage scope
validator, then checks the production record. A pass is structural and
internally consistent only. It does not resolve restricted artifacts,
authenticate signers or hashes, prove the observations came from production, or
establish PCI compliance. Security/PCI must perform those external checks before
granting operational evidence credit.

## Evidence boundary

This runbook does not cover branch protection, secure-development training,
provider contracts, IAM/MFA, backup/restore, incident tabletop, independent
application/AI penetration testing, or CDE segmentation. Those remain separate
required evidence in [`evidence-index.md`](./evidence-index.md).
