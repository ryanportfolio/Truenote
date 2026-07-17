# Production security-control verification record

**Machine-readable record:**
[`production-control-verification-record-template.json`](./production-control-verification-record-template.json)

This Markdown copy is a human-review companion. The JSON record and combined
validator are authoritative for completeness, scope/release binding,
applicability, and pass/fail/not-run semantics. Do not use this table alone as
machine-validated evidence.

For each stable ID in the JSON template, complete this exact field set. The
short repository template intentionally lists only identity bindings so it
cannot be mistaken for an executable or accepted record:

```json
{
  "id": "<exact stable exercise ID>",
  "runbookSection": "<exact section>",
  "workstreamId": "<exact TN-WORK ID>",
  "applicability": "required",
  "applicabilityRationale": "<approved repository-safe basis>",
  "applicabilityApprovalReference": null,
  "status": "passed",
  "authorizationReference": "TN-AUTH-<YYYY>-<NNN>",
  "executedAt": "<UTC timestamp>",
  "executedByPrincipalId": "user:TN-<OPERATOR>",
  "reviewedAt": "<UTC timestamp>",
  "reviewedByPrincipalId": "user:TN-<REVIEWER>",
  "environmentReference": "TN-ENV-<YYYY>-<NNN>",
  "releaseCommitSha": "<exact lowercase 40-character commit SHA>",
  "scopeDecisionSha256": "<exact final-scope record SHA-256>",
  "restrictedEvidenceReference": "TN-PROD-EVIDENCE-<YYYY>-<NNN>",
  "evidenceSha256": "<SHA-256 of exact restricted receipt bytes>",
  "findingId": null
}
```

For `not_applicable`, use `status: "not_run"`, provide a controlled
`applicabilityApprovalReference`, keep the review fields, and set authorization,
execution, restricted-evidence, hash, and finding fields to `null`.

Copy this template into the approved restricted evidence system. Do not populate
production identifiers, raw output, PAN, PII, credentials, prompts, or webhook
content in the repository copy.

## Record identity

| Field | Value |
|---|---|
| Evidence record ID | |
| Change/evidence ticket | |
| Environment and CDE scope | |
| Application release commit | |
| Deployment identifier | |
| UTC start/end | |
| Operator and role | |
| Independent reviewer | |
| Platform/database owner | |
| Security/PCI approver | |

## Catalog query

| Field | Value |
|---|---|
| Repository query path | `docs/compliance/pci/production-control-verification.sql` |
| Query SHA-256 | |
| Database evidence role | |
| Raw result artifact ID | |
| Raw result SHA-256 | |
| First result rows / failed rows | |
| Definition rows reviewed | |
| Approved DDL comparison result | `pass` / `fail` |
| Finding IDs for any difference | |

## Runtime results

| Exercise | Environment/actor evidence ID | Result | Finding ID |
|---|---|---|---|
| Document upload/rescan throttle | | `pass` / `fail` / `not run` | |
| Evaluation-run throttle | | `pass` / `fail` / `not run` | |
| Bulk-invitation throttle | | `pass` / `fail` / `not run` | |
| User creation/reset throttle | | `pass` / `fail` / `not run` | |
| Password-change throttle | | `pass` / `fail` / `not run` | |
| Shared-IP user independence | | `pass` / `fail` / `not run` | |
| Multi-replica counter consistency | | `pass` / `fail` / `not run` | |
| Counter-window expiry and cleanup | | `pass` / `fail` / `not run` | |
| Denial audit receipt | | `pass` / `fail` / `not run` | |
| SIEM delivery and alert | | `pass` / `fail` / `not run` | |
| SIEM retry/recovery | | `pass` / `fail` / `not run` | |
| SIEM dead-letter response | | `pass` / `fail` / `not run` | |
| Local firewall OpenAI embedding redaction | | `pass` / `fail` / `not run` | |
| Local firewall Cohere query/document redaction | | `pass` / `fail` / `not run` | |
| Local firewall OpenRouter generation/utility redaction | | `pass` / `fail` / `not run` | |
| Local firewall unresolved-blocking-rule failure | | `pass` / `fail` / `not run` | |
| Contextual name/address policy/control | | `pass` / `fail` / `not run` | |
| Eight-case deployed AI regression | | `pass` / `fail` / `not run` | |
| AI regression report contains no prompts/answers/canaries/tokens | | `pass` / `fail` / `not run` | |
| OpenRouter input redaction | | `pass` / `fail` / `not run` | |
| OpenRouter prompt-injection handling | | `pass` / `fail` / `not run` | |
| Model-output sensitive-data handling | | `pass` / `fail` / `not run` | |

## Deviations and findings

For every failure or skipped required test, record the stable finding ID, impact,
owner, target date, mitigation/exception approver and expiry when applicable, and
exact retest required. Do not paste sensitive technical details here if this copy
will leave restricted storage.

## Decision

- [ ] Every catalog check passed and every retained definition matched approved
      DDL.
- [ ] Required runtime exercises passed for the named release/environment.
- [ ] No unresolved blocking finding exists, or each exception is formally
      approved and time-bounded.
- [ ] Raw artifacts and hashes are retained and immutable.
- [ ] Independent reviewer approved the evidence.
- [ ] Platform/database owner approved the result.
- [ ] Security/PCI owner accepted the tested scope.

**Decision:** `accepted` / `rejected` / `incomplete`  
**Decision authority:**  
**UTC decision time:**  
**Next review/expiry:**

Unchecked required items force `incomplete` or `rejected`; they are not
administrative placeholders.
