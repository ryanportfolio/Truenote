# PCI decision meeting pack

**Status:** Ready for an authorized decision meeting; no meeting, appointment,
authorization, policy adoption, or QSA acceptance is claimed  
**Facilitator:** PCI scope owner - unassigned  
**Record keeper:** Compliance delegate - unassigned

## Meeting objective

Produce the minimum controlled decisions needed to move TrueNote into the
company's existing PCI assessment process without inventing scope, owners, or
evidence. The meeting may approve roles and policies and may authorize the
bounded synthetic trace. Final scope acceptance occurs only after that trace is
completed and reviewed.

## Required attendees or written delegates

- executive appointing authority;
- PCI scope owner;
- QSA or compliance-accepting entity;
- TrueNote application operator/Engineering owner;
- Product Security;
- customer CDE owner;
- Platform/database owner;
- Data/content owner;
- Vendor-risk owner;
- Change authority; and
- record keeper with access to the restricted evidence system.

An absent decision authority must provide a controlled written delegation. A
participant may hold more than one operational role only where the documented
separation constraints remain satisfied.

## Pre-read and meeting prerequisites

Distribute these artifacts at least one business day before the meeting:

1. [`scope-and-data-flow.md`](./scope-and-data-flow.md)
2. [`pci-scope-decision-record.md`](./pci-scope-decision-record.md)
3. [`requirement-6-control-matrix.md`](./requirement-6-control-matrix.md)
4. [`roles-and-responsibilities.md`](./roles-and-responsibilities.md)
5. [`secure-development-lifecycle.md`](./secure-development-lifecycle.md)
6. [`vulnerability-management.md`](./vulnerability-management.md)
7. [`change-control.md`](./change-control.md)
8. [`third-party-responsibility-matrix.md`](./third-party-responsibility-matrix.md)
9. [`production-evidence-capture-runbook.md`](./production-evidence-capture-runbook.md)
10. [`independent-testing-plan.md`](./independent-testing-plan.md)

Before starting, confirm:

- the restricted evidence system and meeting record location are available;
- the controlled role and policy templates have fresh record IDs;
- the target environment and synthetic test accounts are identified privately;
- no PAN, customer content, credentials, raw topology, or personal contact data
  will be placed in repository-safe records; and
- the compliance-accepting entity understands that repository validation checks
  structure and consistency, not the authenticity or sufficiency of evidence.

If any prerequisite is missing, record an owner and due date and stop before
authorizing the trace.

## Decision order

Use this dependency order. Do not jump directly to final scope acceptance.

| Order | Decision | Required output | Stop condition |
|---|---|---|---|
| 1 | Appoint accountable roles and delegates | Controlled role-assignment record, appointment and acknowledgement references | Missing appointing authority, unresolved critical separation, or unacknowledged role |
| 2 | Identify assessment parties | Controlled assessed-entity, application-operator, and customer-CDE-owner references | Any party is unknown or only informally named |
| 3 | Decide working CDE relationship and validation path | One relationship, one validation path, impact rationale, in/out components, connected systems | QSA/compliance direction is absent or contradictory |
| 4 | Decide PAN policy | `prohibited` or exact permitted paths plus enforcement references | Generic or conditional permission, or no enforcement evidence |
| 5 | Review infrastructure and providers | Typed/hash-bound `present` or `none_verified` receipt metadata for admin/support paths, network/management paths, data stores, and backup/recovery copies; all 12 provider classifications | Empty inventory, contradictory or unreviewed absence claim, or unresolved responsibility |
| 6 | Decide 6.4.2, 6.4.3, and 11.4 applicability | Exact applicability, rationale, and control/test-plan references | Applicability depends on missing architecture or assessor direction |
| 7 | Adopt Requirement 6 governance | Controlled policy-adoption record bound to approved document bytes and the role record | Draft document, missing communication/training plan, unresolved item, or absent approval |
| 8 | Authorize bounded synthetic trace | Valid `provisional_test_authorization` JSON and restricted authorization evidence | Target/account/flow mismatch, PAN or live-data use, destructive action, or expiry over 30 days |
| 9 | Assign operational closure work | Action register for vulnerability sources/findings, branch enforcement, production evidence, and independent testing | Owner, due date, or acceptance test missing |

## Required meeting outputs

Retain repository-safe metadata here and detailed evidence only in the restricted
system:

1. role-assignment record and exact-byte hash;
2. policy-adoption record and exact-byte hash;
3. meeting minutes reference, attendee/delegation evidence, and decision log;
4. provisional PCI scope record and exact-byte hash;
5. safe action register with stable IDs, owner principal IDs, due dates, and
   binary acceptance tests;
6. approved synthetic-trace execution window or an explicit no-authorization
   outcome; and
7. reconvene trigger and facilitator.

Do not create a final scope-acceptance record during this meeting unless an
already authorized trace has completed, its safe receipt has been independently
reviewed, every unresolved question is closed, and all final-stage prerequisites
validate.

## Minutes and action-register minimums

The controlled minutes must record:

- meeting ID, date/time, facilitator, record keeper, attendees, and delegations;
- each decision as approved, rejected, or deferred with rationale;
- exact record IDs and SHA-256 values for reviewed role, policy, provisional
  scope, and trace-receipt files;
- every deferred item with stable action ID, accountable principal, due date,
  dependency, acceptance test, and evidence destination;
- conflicts of interest or role-separation decisions; and
- next meeting date or objective reconvene condition.

## Immediate action register to populate

| Action | Required owner | Completion evidence |
|---|---|---|
| Assign all 51 retained findings and approve due dates/dispositions using the [`triage workshop`](./vulnerability-triage-workshop.md) | Product Security | Strict vulnerability gate reports zero finding-management blockers; any remaining blockers are source-only and separately assigned |
| Assign and operate all 11 vulnerability-source categories | Product Security plus source owners | Authenticated receipts and strict source gate pass |
| Enable and behaviorally verify branch enforcement | Engineering/Security | Accepted branch record plus denied and allowed operation receipts |
| Execute authorized production-control verification | Platform/database, SIEM, IAM, and provider owners | Reviewed result record with hashes and closed findings |
| Commission applicable independent PCI/application/segmentation testing | PCI scope owner/Product Security | Qualified independent report, remediation, and retest |
| Commission external AI red-team assurance target | Product Security | Independent report, remediation, and retest |

## Close or reconvene

Close the meeting only after the record keeper reads back each decision, owner,
due date, evidence destination, and stop condition. Reconvene for final scope
acceptance after the bounded trace receipt is reviewed. Reconvene earlier if the
architecture, CDE relationship, provider set, PAN policy, target environment, or
authorized flow set changes.
