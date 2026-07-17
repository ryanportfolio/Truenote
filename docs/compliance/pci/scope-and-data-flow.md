# PCI scope and data flow

**Status:** Draft; Security/QSA decision required  
**Owner:** PCI scope owner — unassigned  
**Review cadence:** At least annually and after a significant architecture, provider, or data-flow change

## Blocking decisions

The PCI owner/QSA must record:

1. Whether Truenote stores, processes, transmits, or can affect the security of
   cardholder data or the cardholder data environment (CDE).
2. Whether Truenote is included in the existing CDE assessment or isolated from it.
3. Whether PAN is prohibited everywhere in Truenote or permitted only in named,
   assessed paths.
4. Which assessed entity, application operator, and customer CDE owner are
   accountable, and which infrastructure, providers, administrative/support
   paths, network/management paths, and data stores are in scope.
5. Which segmentation controls reduce scope and how Requirement 11.4 testing will
   validate them.

Use the machine-checked
[`PCI scope and PAN decision record`](./pci-scope-decision-record.md) to capture
these decisions, all 12 provider/service classifications, 6.4.2/6.4.3/11.4
applicability, evidence references, unresolved questions, and distinct decisions.
The repository template intentionally fails until accountable parties replace
every placeholder. First obtain bounded provisional authorization, then execute
the authorized synthetic trace, then record final scope acceptance.

The structured record requires controlled references for the assessed entity,
application operator, and customer CDE owner. It also requires a `present` or
`none_verified` decision, substantive rationale, and typed/hash-bound restricted
evidence-receipt metadata for each administrative/support-path,
network/management-path, data-store, and backup/recovery-copy inventory.
An empty list is not accepted as proof that an inventory category is absent, and
canonical component/flow/provider signals reject contradictory absence claims.
Every receipt binds its category, bounded environment, architecture release,
reviewer, review time, and restricted artifact hash. Reviews older than 90 days
at either scope-decision stage fail the repository gate.
Raw CDE topology and identity details belong only in the restricted evidence
system.

No application-layer `program_id` or classification filter is evidence of PCI
network segmentation.

## Current application data paths

| Stable flow ID | Data and processors | Current controls | PCI-relevant limitation |
|---|---|---|---|
| `TN-FLOW-01` First-turn question | Browser → API → local sensitive-pattern gate → local pre-provider firewall → OpenAI embedding → Neon retrieval → local firewall → Cohere rerank → local firewall → OpenRouter generation → `query_log` | Local secret/SSN/PAN plus deterministic email/structured-phone/IPv4/IPv6 redaction at every text-provider boundary; fail-closed rescan; program/classification filtering; configured OpenRouter PII/prompt guardrail; ZDR-pinned generation; output refusal | Names, addresses, unstructured/obfuscated/contextual PII and runtime effectiveness remain gaps. Provider-side synthetic receipts and data-policy approval are missing. |
| `TN-FLOW-02` Follow-up question | Browser history → local gate/firewall → OpenRouter rewrite → local firewall → OpenAI/Cohere/retrieval → local firewall → OpenRouter generation | Local deterministic redaction covers rewrite, embedding, rerank, and generation; OpenRouter guardrail is additional configured protection | Rewrite failure falls back to the original question, which still passes through later provider-boundary protection. Names/addresses and contextual PII require an approved control or prohibition. |
| `TN-FLOW-03` Document upload | Browser → object storage/API → malware scanner → LandingAI for PDF/image parsing → parsed markdown persisted → content DLP → local firewall → OpenAI embeddings → Neon chunks | File signature/EICAR checks; default-on malware enforcement; post-parse PII/secret quarantine; deterministic pre-embedding redaction | Scanner, storage, and LandingAI receive raw bytes before parsed-content controls; parsed text is stored before the DLP decision. Provider/data policy and raw-file handling remain required. |
| `TN-FLOW-04` Answer delivery | OpenRouter response → local citation validation and PAN/SSN/credential scan → browser and `query_log` | Cite-or-refuse; narrow sensitive-output refusal | OpenRouter sensitive-info guardrails scan inputs, not responses. Broader output handling must follow the approved data policy. |
| `TN-FLOW-05` Security events | API/database → hash-chained `security_events` → transactional SIEM outbox → signed SIEM webhook | Append-only DDL and lease-fenced delivery logic; read-only production catalog verifier prepared | Production verifier output, delivery receipts, alert ownership, and retention are not yet retained here. |

## Provider and component inventory

At minimum, scope review must cover the browser, Replit-hosted frontend/API/worker,
object storage, Neon PostgreSQL, GitHub, OpenRouter and its routed providers,
OpenAI, Cohere, LandingAI, the malware scanner, email provider, IdP, and SIEM.
The detailed responsibility/evidence questions live in
[`third-party-responsibility-matrix.md`](./third-party-responsibility-matrix.md).

## Accountable-party and infrastructure inventory status

| Required decision | Current repository-safe status |
|---|---|
| Assessed entity reference | Missing |
| Application operator reference | Missing |
| Customer CDE owner reference | Missing |
| Administrative and support paths | Inventory/evidence not supplied |
| Network and management paths | Inventory/evidence not supplied |
| Data stores | Inventory/evidence not supplied |
| Backups and recovery copies | Inventory/evidence not supplied |

These are deliberate blockers. Do not replace them with plausible entities,
`none`, or empty arrays. The accountable scope meeting must resolve each field
against controlled evidence.

## PAN policy decision record

**Recommended starting position:** Truenote must not receive or retain PAN unless
the PCI owner/QSA explicitly approves an in-scope path.

| Field | Decision |
|---|---|
| Decision | Unapproved |
| Approved PAN paths | None recorded |
| Prohibited paths | Pending QSA confirmation |
| Approver and date | Unassigned |
| Assessment/requirement reference | Unassigned |
| Required technical enforcement | Pending scope decision |

No validated approved JSON decision record has been reviewed. The table above is
current draft status, not a substitute for the structured approval.

## Acceptance test

First, a structurally accepted `provisional_test_authorization` record must name
the exact environment, test accounts, stable flow IDs, synthetic-data-only
restriction, PAN prohibition, non-destructive boundary, authorization reference,
and expiry. Only then may the synthetic trace run. Final acceptance must record
that the trace completed within that authorization window. This document passes
only after the trace is reconciled, the PCI owner/QSA accepts the boundary, every data
store/provider, backup/recovery copy, and administrative/network path is classified, all three
accountable-party references resolve, the PAN policy is approved, and any claimed
segmentation passes independent testing. The final structured record must pass
`verify:pci-scope-decision` with `structurallyFinalAccepted=true`; structural validation alone
does not authenticate the decision or evidence. Until then, scope remains
**Operational evidence required**.
