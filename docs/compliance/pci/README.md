# Truenote PCI DSS readiness evidence

**Status:** Draft control package for Security/QSA review  
**Current as of:** 2026-07-17
**Scope:** Repository and known provider/data paths; deployed CDE scope is not yet determined

**Normative engineering basis:** [PCI DSS v4.0.1, published June 2024](https://www.pcisecuritystandards.org/document_library/?class=pcidss&doc=pci_dss), accessed 2026-07-17. This repository mapping is non-authoritative; the compliance-accepting entity and QSA determine applicability and evidence sufficiency.

This directory organizes evidence for incorporating Truenote into an existing
PCI DSS assessment. It is not a Report on Compliance, Attestation of Compliance,
certification, legal opinion, or claim that a deployed environment is compliant.
The compliance-accepting entity and QSA determine scope, applicability, validation,
and evidence sufficiency.

## Start here

1. [`security-readiness-session-report-2026-07-16.html`](./security-readiness-session-report-2026-07-16.html)
   is the durable living ledger for security-team feedback, completed work,
   verification, lessons, open blockers, and next actions. Update it as work
   changes so the record survives task handoffs and context compaction.
2. [`pci-decision-meeting-pack.md`](./pci-decision-meeting-pack.md) gives the
   authorized Security/QSA meeting a dependency-ordered agenda, required
   attendees, pre-reads, exact outputs, stop conditions, action register, and
   reconvene rule. The linked
   [`governance adoption procedure`](./pci-governance-adoption-records.md),
   [`role template`](./pci-role-assignment-record-template.json), and
   [`policy template`](./pci-policy-adoption-record-template.json) create
   machine-checked role/delegate appointments and exact-byte-linked policy
   adoption without claiming that either decision occurred.
3. [`scope-and-data-flow.md`](./scope-and-data-flow.md) records the current data
   paths and blocking CDE/PAN decisions. The
   [`machine-checked decision record`](./pci-scope-decision-record.md) and
   [`fillable JSON template`](./pci-scope-decision-record-template.json) make the
   required CDE/PAN/provider/applicability decision explicit. Its two fail-closed
   stages permit a bounded synthetic trace before final scope acceptance without
   pretending either stage has been authorized or approved. The
   [`safe trace-receipt template`](./synthetic-trace-receipt-template.json) binds
   final structural validation to exact receipt bytes and reconciled flow/timing
   metadata without storing sensitive trace content here.
4. [`requirement-6-control-matrix.md`](./requirement-6-control-matrix.md) maps
   current evidence and gaps to PCI DSS Requirements 6.1 through 6.5 and the
   related penetration-testing dependency in 11.4.
5. [`secure-development-lifecycle.md`](./secure-development-lifecycle.md),
    [`vulnerability-management.md`](./vulnerability-management.md), and
    [`change-control.md`](./change-control.md) define the proposed operating
    procedures. The
    [`secure-development review record`](./secure-development-review-record-template.md),
    [`Truenote secure-development curriculum`](./secure-development-training-curriculum.md),
    [`annual training record`](./secure-development-training-record-template.md),
    [`tool-neutral change record`](./manual-change-record-template.md), and
    [`change register`](./change-register-template.md) give staff practical
    Requirement 6.2 and 6.5 content and evidence forms. They become operational
    evidence only after approval, authentic completion, and use.
6. [`roles-and-responsibilities.md`](./roles-and-responsibilities.md) and
   [`third-party-responsibility-matrix.md`](./third-party-responsibility-matrix.md)
   identify owners and external dependencies still requiring assignment or proof.
7. [`evidence-index.md`](./evidence-index.md) distinguishes repository evidence
   from configuration, operational, and third-party evidence.
8. [`provider-input-firewall.md`](./provider-input-firewall.md),
   [`ask-sensitive-input-handling.md`](./ask-sensitive-input-handling.md),
   [`model-output-sensitive-data-handling.md`](./model-output-sensitive-data-handling.md),
   [`openrouter-guardrail-evidence.md`](./openrouter-guardrail-evidence.md),
   [`vulnerability-register.md`](./vulnerability-register.md), and the
   [`11-category vulnerability-source register`](./vulnerability-source-register-2026-07-16.json)
   record the local pre-provider control, generated-answer fail-closed control,
   supplied guardrail evidence, exact remaining PII gaps, repository-safe finding
   index, and required scanner/advisory/reporting coverage. The
   [`vulnerability-source execution record`](./vulnerability-source-execution-record.md)
   and [`safe receipt index`](./vulnerability-source-receipt-index-2026-07-16.json)
   standardize machine-checked declared metadata without treating it as proof of
   execution or artifact authenticity.
9. [`codeql-triage-2026-07-16.md`](./codeql-triage-2026-07-16.md) and the
   [`safe 51-finding baseline`](./codeql-baseline-2026-07-16.json) record the
   retained SARIF identity, exact safe finding reconciliation, technical
   applicability analysis, local fixes, and management evidence still required.
   The [`CodeQL intake runbook`](./codeql-intake-runbook.md) defines repeatable safe
   rescans, management-field preservation, and fail-closed removal handling. The
   [`vulnerability triage workshop`](./vulnerability-triage-workshop.md) gives
   Product Security an exact 51-child assignment/disposition procedure without
   creating a second source of truth or publishing restricted scanner detail.
10. [`rate-limit-route-assessment-2026-07-16.md`](./rate-limit-route-assessment-2026-07-16.md)
   classifies the 40 CodeQL rate-limit locations, records the high-amplification
   controls added locally, and defines capacity/edge acceptance evidence.
11. [`ai-adversarial-regression.md`](./ai-adversarial-regression.md) defines the
   tested internal synthetic harness, evidence-safe live runner, exact non-coverage,
   and boundary between regression and independent red-team evidence.
12. [`independent-testing-plan.md`](./independent-testing-plan.md) defines the
   application/API, AI, and segmentation assurance engagement and its acceptance
   evidence.
13. [`implementation-status.md`](./implementation-status.md) records what this
   work completed and what remains blocked on external decisions or runtime proof.
14. [`verification-record-2026-07-16.md`](./verification-record-2026-07-16.md)
   records exact local checks and the current-main integration limitation.
15. [`change-record-2026-07-16-security-readiness.md`](./change-record-2026-07-16-security-readiness.md)
   is the populated pre-release Requirement 6.5 record for this tranche; its
   unchecked approval, hosted-check, deployment, and runtime gates block closure.
16. [`production-evidence-capture-runbook.md`](./production-evidence-capture-runbook.md)
   defines the controlled production catalog, workload, SIEM, and OpenRouter
   evidence exercise without exporting application data.
17. [`production-control-verification.sql`](./production-control-verification.sql)
    and its
    [`structured result template`](./production-control-verification-record-template.json)
    provide exact read-only catalog checks, 28 stable applicability/result
    exercises, final-scope/release binding, and a fail-closed validator. The
    [`Markdown companion`](./production-control-verification-record-template.md)
    is for human review notes only.
18. [`threat-model.md`](./threat-model.md) maps 26 application, AI, provider,
   supply-chain, insider, and CDE-impact threats across nine trust boundaries.
19. [`threat-review-record-template.md`](./threat-review-record-template.md)
   defines the named review, disposition, ownership, due-date, and sign-off record
   required before the engineering model becomes operational evidence.
20. [`branch-enforcement-evidence.md`](./branch-enforcement-evidence.md) and its
    [`intentionally failing JSON template`](./branch-enforcement-evidence-template.json)
    define optional supplemental GitHub API capture, exact check/integration
    binding, CODEOWNERS coverage, distinct review, and negative enforcement tests.
    Owner direction defers this advanced platform evidence unless Security/PCI
    requests it or relevant CDE integration approaches; the tool-neutral change
    process is the current Requirement 6.5 path.
21. [`public-security-reporting.md`](./public-security-reporting.md) records the
   public `/security/` overview and `/security/report/` policy, RFC 9116
   discovery record, portable tests, production-build output, claim boundaries,
   annual expiry obligation, and deployed intake acceptance test.

## Evidence rule

Code, draft policy, and a configured workflow do not prove a control operates.
A control is complete only when its acceptance test passes and the dated result,
owner, reviewed scope, and remediation/exception state are retained. Never place
secrets, customer data, PAN, production database exports, raw prompts, or detailed
unremediated exploit material in this directory.

## Earliest incomplete gate

P0 remains incomplete until accountable parties issue a bounded provisional
synthetic-test authorization with resolved assessed-entity, application-operator,
customer-CDE-owner, administrative/support-path, network/management-path, and
data-store evidence; reconcile the resulting trace; approve the final CDE
boundary and PAN policy; and verify production database/security integrations.
Requirement 6.5 separately needs an approved tool-neutral procedure, named
authority and system of record, a reconciled change register, and authentic
normal samples. Emergency handling needs a sampled emergency record if an
emergency occurred in the review period; otherwise retain reconciled zero-event
evidence plus an approved tabletop. Additional GitHub controls are owner-deferred.
