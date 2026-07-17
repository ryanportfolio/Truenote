# PCI scope and PAN decision record

**Status:** Machine-checkable record format implemented; no approved company/QSA
decision is supplied by this document  
**Owner:** PCI scope owner - unassigned  
**Assessment authority:** The compliance-accepting entity and QSA/assessor decide
applicability and evidence sufficiency

This record turns the earliest P0 scope questions into a fail-closed, two-stage
decision. It covers TrueNote's CDE relationship, validation path, PAN policy,
accountable-party references, administrative/support paths, network/management
paths, data stores, segmentation, provider responsibility, PCI DSS
6.4.2/6.4.3/11.4 applicability, evidence references, bounded synthetic-test
authorization, unresolved questions, and distinct decisions.

Use the parseable
[`decision JSON template`](./pci-scope-decision-record-template.json) and
[`synthetic trace receipt template`](./synthetic-trace-receipt-template.json).
Every placeholder and initial `pending` decision are intentional failures. Do
not convert them to plausible text without the accountable parties and evidence.

## Required sequence

The two stages remove a circular dependency: final scope acceptance needs a
synthetic trace, while running that trace needs prior authorization for a named
environment, accounts, and flows.

1. Complete a `provisional_test_authorization` record. This stage records the
   working scope and PAN decisions and authorizes only the bounded synthetic
   exercise described in `syntheticTestAuthorization`.
2. Execute the authorized flows, retain sanitized receipts in the restricted
   evidence system, and reconcile results against the working data flow.
3. Complete a separate `final_scope_acceptance` record. This stage references
   and hashes the exact provisional record, preserves its scope and authorization
   fields, references the complete trace receipt, closes all unresolved
   questions, and records final decisions.

A structurally accepted provisional record is **not** final scope approval. It
does not authorize deployment, destructive testing, PAN or customer data,
prove segmentation, establish QSA sufficiency, or approve any flow outside the
listed stable IDs.

## Required decisions

### CDE relationship and validation path

Select exactly one relationship:

- `inside_cde`
- `connected_to_cde`
- `security_impacting`
- `segmented_out`
- `no_cde_impact`

Select exactly one validation path:

- `existing_cde_assessment`
- `separate_assessment`
- `out_of_scope_determination`

An in-scope, connected, or security-impacting decision requires
`canImpactCdeSecurity=true`, named in-scope components, and connected systems. A
`no_cde_impact` decision requires `canImpactCdeSecurity=false` and an approved
out-of-scope determination, an empty in-scope component list, and no segmentation
reliance. Use `segmented_out` when the decision depends on segmentation.
Application `program_id` boundaries are not network segmentation. `inside_cde`,
`connected_to_cde`, and `security_impacting` cannot be paired with
`out_of_scope_determination`.

### Accountable parties and infrastructure inventories

Every stage must cite controlled records for all three accountable parties:

- the assessed entity whose PCI assessment would include or exclude TrueNote;
- the organization or team operating the TrueNote application; and
- the customer or enterprise owner of the affected CDE.

Use `accountableParties.assessedEntityReference`,
`applicationOperatorReference`, and `customerCdeOwnerReference`. These fields
hold opaque references to controlled identity/role records, not guessed names or
raw contact details. The repository validator requires an uppercase namespace
and uppercase letters, digits, and hyphens only, for example
`GRC-ROLE-2026-001`; map any external
system key to a repository-safe controlled alias rather than embedding a URL,
name, email address, hostname, or free-form description.

Every stage must also make an explicit, evidenced decision for:

- `administrativeAndSupportPaths`;
- `networkAndManagementPaths`; and
- `dataStores`; and
- `backupsAndRecoveryCopies`.

Each inventory uses `status: present` or `status: none_verified`, a substantive
rationale, and at least one structured `evidenceReceipts` entry. Each receipt
contains a repository-safe controlled reference, SHA-256 of the restricted
artifact bytes, `inventory` or `absence_attestation` type, exact inventory
category, matching bounded environment reference, matching architecture-release
reference, stable reviewer principal ID, and canonical review time. `present`
requires an inventory receipt; `none_verified` requires an absence-attestation
receipt. The reviewer must differ from the record preparer. Review cannot be
future-dated, follow the scope decision date, or be more than 90 days old at
either provisional or final decision time. The 90-day maximum is this
repository's fail-closed revalidation default, not a statement that PCI DSS sets
that exact interval; accountable policy may require a shorter interval.

An empty list cannot assert absence. The validator also rejects `none_verified`
when canonical scope signals contradict it:

- `administrative_access`, `deployment_pipeline`, or included `source_and_ci`
  responsibility requires administrative/support paths to be `present`;
- any connected system, in-scope stable flow, or included provider responsibility
  requires network/management paths to be `present`;
- any data-store component/provider or in-scope stable flow requires data stores
  to be `present`; and
- `backups_and_recovery` as an in-scope component requires backup/recovery copies
  to be `present`.

Use only the canonical component IDs in the template/process:
`public_frontend`, `application_api`, `background_worker`,
`administrative_access`, `deployment_pipeline`, `database`, `object_storage`,
`identity_integration`, `security_monitoring`, `email_delivery`,
`public_documentation`, and `backups_and_recovery`. Connected-system IDs are
`cde_identity_services`, `cde_network_services`, `cde_security_monitoring`, and
`cde_change_management`. Adding an architecture category requires a reviewed
schema update; free-form names fail closed.

Keep raw hostnames, IP addresses, URLs, email addresses, account IDs,
credentials, and detailed CDE topology in the restricted evidence system. The
new inventory rationales reject common repository-unsafe forms, including
compressed IP literals, arbitrary URI schemes, common single-label host forms,
and hyphen-encoded IPs. Inventory receipts also use category-specific aliases
(`TN-ADMIN-PATH-*`, `TN-NETWORK-PATH-*`, `TN-DATA-STORE-*`, or `TN-BACKUP-*`)
and bind `TN-TEST-ENVIRONMENT-*` plus `TN-ARCH-RELEASE-*` aliases. This scan is
defense in depth rather than a complete DLP system.

### Stable flow decisions

Record exactly one `in_scope` or `excluded` decision, rationale, and restricted
evidence reference for every stable flow in
[`scope-and-data-flow.md`](./scope-and-data-flow.md): `TN-FLOW-01` through
`TN-FLOW-05`. The authorized flow set must exactly equal the in-scope set; an
excluded flow cannot disappear silently. Final trace coverage must exactly equal
the authorized set.

### PAN policy

Choose `prohibited` or `permitted_named_paths`.

- `prohibited` requires an empty allowed-path list, explicit prohibited paths,
  and enforcement references.
- `permitted_named_paths` requires every approved path, every prohibited path,
  and technical enforcement references. A generic statement such as "when
  needed" fails the intent of the record.

The recommended starting position remains prohibition unless the PCI owner and
QSA/assessor explicitly approve a named assessed path.

### Segmentation

If the decision relies on segmentation or selects `segmented_out`, record named
boundaries, the control reference, the independent test plan, and mark
Requirement 11.4 testing `required`. The record rejects a segmentation reliance
paired with `11.4` set to `not_applicable`.

### Provider and service inventory

Every approved record contains exactly one decision for each canonical ID:

1. `application_hosting`
2. `database`
3. `object_storage`
4. `source_and_ci`
5. `model_gateway`
6. `embeddings`
7. `reranking`
8. `document_parsing`
9. `malware_scanning`
10. `email`
11. `identity_provider`
12. `siem`

Each is `in_scope`, `out_of_scope`, or `shared_responsibility`, with a rationale
and responsibility reference. `pending` is not an accepted decision at either
stage.

### Requirement applicability

Record exactly one `applicable` or `not_applicable` decision for:

- `6.4.2` public-facing web application protection;
- `6.4.3` payment-page scripts; and
- `11.4` penetration and applicable segmentation testing.

Applicable decisions require a control-plan reference. Not-applicable decisions
require a rationale and a null plan reference. The validator checks completeness,
not the assessor's substantive judgment.

### Provisional synthetic-test authorization

Set `decisionStage` to `provisional_test_authorization` and `decision` to
`authorized_for_synthetic_testing`. The record must contain working decisions
for scope, accountable parties, infrastructure inventories, PAN, segmentation,
providers, and applicability, plus:

- `syntheticTraceReference: null`;
- `syntheticTestAuthorization.status: authorized`;
- exact restricted references for the environment and test accounts;
- the exact in-scope stable-flow set in `authorizedFlowIds`;
- `syntheticDataOnly`, `panProhibited`, and
  `destructiveTestingProhibited` all set to `true`;
- a restricted authorization reference, canonical `issuedAt`, and expiry no more
  than 30 days later;
- empty `traceFlowIds` and null trace receipt reference/hash, `startedAt`, and
  `completedAt`;
- `provisionalRecordSha256: null`; and
- distinct stable corporate principal IDs, distinct approval artifacts, and
  `authorized` decisions from the PCI scope owner and compliance-accepting
  entity. Both decisions must occur before `issuedAt`, and neither principal may
  be the preparer principal.

Unresolved questions may remain only when they are explicit and the bounded
exercise is intended to answer them. The authorization expires automatically
at `expiresAt`; extension requires a new controlled record. The 30-day maximum
is this repository's fail-closed safety default, not a claim that PCI DSS sets
that exact duration; accountable policy may choose a shorter window.

### Final scope acceptance

Set `decisionStage` to `final_scope_acceptance` and `decision` to `approved`.
Set `supersedesRecordId` to the exact provisional `recordId` and
`provisionalRecordSha256` to the SHA-256 of the exact provisional JSON bytes.
The validator requires that provisional file as a separate input and rejects a
standalone final record. The final record must preserve the provisional scope,
PAN, segmentation, provider, applicability, non-trace evidence, environment,
accounts, flow set, safety flags, authorization reference, issuance, and expiry.
If trace results change any of those decisions, issue a new provisional record
and repeat the bounded trace instead of widening the old authorization.

The final evidence set must include non-placeholder references to:

- the frozen data-flow artifact that final acceptance is approving;
- the scope inventory;
- the completed end-to-end synthetic trace;
- the architecture/release reviewed; and
- QSA/assessor or compliance-accepting direction.

Set `syntheticTestAuthorization.status` to `completed`; make `traceFlowIds`
exactly equal `authorizedFlowIds`; provide the restricted trace receipt reference
and SHA-256; and make that receipt reference equal `syntheticTraceReference`.
The safe receipt ID must match `TN-SYNTHETIC-TRACE-YYYY-NNN`, its year must match
review, and its `provisionalRecordId` and `provisionalRecordSha256` must bind the
exact authorization bytes. The receipt also preserves authorization/environment/
account references, flow set, start/completion times, an empty coverage-gap list,
distinct operator/reviewer principals, review time, and a restricted detailed
artifact reference.
Canonical `startedAt` and `completedAt` must show issuance at or before trace
start, trace start at or before completion, and completion on or before expiry.
Final review may occur after expiry, but the safe receipt review must follow
trace completion and each final signoff must follow receipt review. The final
`decisionDate` cannot precede the provisional decision, trace completion, or
receipt review date. Remove every resolved entry from
`unresolvedQuestions`; the final list must be empty. Distinct corporate principal
IDs and distinct approval artifacts must record `approved`; neither may be the
preparer principal, and final approval artifacts cannot reuse the provisional
authorization artifacts.

## Validator

Run from the repository root:

```powershell
corepack pnpm --filter @workspace/scripts run verify:pci-scope-decision -- path/to/provisional.json --require-stage provisional_test_authorization
```

For final acceptance, supply both immutable files:

```powershell
corepack pnpm --filter @workspace/scripts run verify:pci-scope-decision -- path/to/final.json --require-stage final_scope_acceptance --provisional path/to/provisional.json --trace-receipt path/to/trace-receipt.json
```

Calculate the provisional byte hash without reformatting the controlled file:

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath path/to/provisional.json).Hash
(Get-FileHash -Algorithm SHA256 -LiteralPath path/to/trace-receipt.json).Hash
```

The unfilled template must fail. Run the same command against each controlled
stage record after accountable review. `--require-stage` is mandatory so an
automation gate cannot mistake provisional success for final acceptance. Success
reports the exact stage and `structurallyFinalAccepted` state. A provisional pass
reports `structurallyFinalAccepted=false`; only a complete, linked final-stage
record can report `structurallyFinalAccepted=true`.

The CLI rejects duplicate JSON object keys in the final, provisional, and safe
receipt inputs before parsing them. This prevents differently behaving parsers
or human reviewers from interpreting the same hashed bytes ambiguously.

A passing command hashes the exact supplied provisional and safe trace-receipt
bytes and validates their declared binding, coverage, and chronology. It proves
only that this repository-safe metadata is complete and internally consistent.
Inventory receipt hashes bind declared restricted artifacts, but this validator
does not receive or resolve those restricted bytes. It does not authenticate
identities/references, inspect the restricted inventories or detailed trace,
prove absence, prove the architecture or runtime behavior, establish segmentation
effectiveness, or replace an assessor decision.

## Acceptance test

The control passes only when the final-stage record validates with
`structurallyFinalAccepted=true`, both accountable approvals resolve in the
restricted evidence system, every referenced artifact matches the reviewed
architecture/release, the authorized synthetic trace demonstrates the accepted
data boundary, and any segmentation reliance passes qualified independent
Requirement 11.4 testing. Until then, the existing
[`scope and data-flow record`](./scope-and-data-flow.md) remains draft and P0
remains open.
