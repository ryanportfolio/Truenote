# PCI governance adoption records

**Status:** Machine-checkable formats implemented; no role appointment or policy
adoption is supplied by these templates  
**Authority:** Executive appointing authority and compliance-accepting entity for
roles; assigned Engineering, Product Security, PCI scope, and QSA/compliance
principals for policy adoption

These records convert the draft Requirement 6 roles and procedures into a
controlled adoption sequence. Structural validation does not authenticate a
principal, delegation, acknowledgement, approval, training plan, communication,
or policy exception. Resolve every controlled reference in the restricted
evidence system.

## Required order

1. Complete the
   [`role-assignment template`](./pci-role-assignment-record-template.json).
2. Obtain executive and compliance approvals, acknowledgements from each
   assignee and delegate, and make the role record effective.
3. Update every policy document being adopted so its first 12 lines contain:

   ```text
   **Status:** Approved
   **Adoption record:** TN-PCI-POLICY-YYYY-NNN
   ```

4. Hash the exact approved document bytes without reformatting them.
5. Complete the
   [`policy-adoption template`](./pci-policy-adoption-record-template.json),
   binding the exact role-record bytes, all six canonical policy paths/hashes,
   communication evidence, training plan, exceptions, and four linked role
   signoffs.
6. Run the combined validator and retain its output with the controlled meeting
   record.

Do not change policy files after approval without issuing a new adoption record
or controlled amendment. Any byte change invalidates the recorded hash.

## Role-assignment requirements

The role record requires every canonical role exactly once:

1. `pci_scope_owner`
2. `qsa_or_compliance_accepting_entity`
3. `engineering_owner`
4. `product_security`
5. `independent_code_reviewer`
6. `change_authority`
7. `platform_database_owner`
8. `iam_owner`
9. `security_operations_siem_owner`
10. `data_content_owner`
11. `vendor_risk_owner`

Each role requires distinct assignee/delegate stable principal IDs, a unique
appointment reference, separate assignee/delegate acknowledgement references,
and an acceptance timestamp no later than the effective time. The repository
default also requires these critical separations:

- PCI scope owner differs from the QSA/compliance-accepting entity;
- Engineering owner differs from the independent code reviewer; and
- Change authority differs from the independent code reviewer.

Each separation applies to both the assignee and delegate sets: no principal may
appear on either side of a critical pair. Principal IDs must use a repository-safe
`user:`, `group:`, `service:`, or `external:` class and may not contain an email
address. Appointment, acknowledgement, and approval evidence use field-specific
opaque aliases whose entire suffix is `YYYY-NNN`, such as
`TN-APPOINT-2026-001`, `TN-ACK-2026-001`, and
`TN-ROLE-APPROVAL-2026-001`, not names or infrastructure identifiers.

The executive appointing authority and compliance-accepting entity must use
distinct approval principals and evidence references. Neither can be the record
preparer. The effective date cannot be future-dated, unresolved items must be
empty, and the next review must be current and occur within 366 days.

## Policy-adoption requirements

The policy record requires these exact repository documents and recomputes their
SHA-256 values from current bytes:

| Policy ID | Canonical path |
|---|---|
| `secure_development_lifecycle` | `docs/compliance/pci/secure-development-lifecycle.md` |
| `vulnerability_management` | `docs/compliance/pci/vulnerability-management.md` |
| `change_control` | `docs/compliance/pci/change-control.md` |
| `scope_and_data_flow` | `docs/compliance/pci/scope-and-data-flow.md` |
| `roles_and_responsibilities` | `docs/compliance/pci/roles-and-responsibilities.md` |
| `third_party_responsibility_matrix` | `docs/compliance/pci/third-party-responsibility-matrix.md` |

Every policy uses version `YYYY.N`, decision `approved`, a unique controlled
approval reference, and an exceptions array. The validator rejects a document
whose approved-status/adoption-record header is missing, whose path/hash differs,
or whose role record is absent, invalid, or byte-hash mismatched.
The first 12 lines must contain exactly one `Status: Approved` declaration and
exactly one adoption-record declaration matching the current record; conflicting
draft or adoption headers fail.

Engineering, Product Security, PCI scope, and QSA/compliance signoff principals
must exactly match the linked role assignees, be distinct, differ from the record
preparer, and approve no later than the policy effective time. Policy adoption
cannot predate the linked role assignments. At least one communication reference
and a training-plan reference are mandatory.

### Exceptions

An exception is not free-form approval. Each entry requires a stable
`TN-PCI-EXCEPTION-YYYY-NNN` ID, substantive rationale, an owner who is an assigned
governance-role principal, expiry after policy effectiveness and no later than
the next review, a non-expired current window, a distinct
`TN-EXCEPTION-APPROVAL-YYYY-NNN` reference, and `status: approved`. Exception rationales
reject common repository-unsafe PAN/SSN, credential, account-ID, URL, email, IP,
and hostname forms. This is defense in depth, not a complete DLP system.
Unresolved items still block the entire policy record.

## Validator

Run from the repository root after the controlled records and policy headers are
complete:

```powershell
corepack pnpm --filter @workspace/scripts run verify:pci-governance-adoption -- --roles path/to/role-assignment.json --policy path/to/policy-adoption.json
```

The command rejects duplicate JSON object keys, missing or duplicate roles and
policies, unsupported fields, placeholders, invalid/future chronology, weak role
separation, unacknowledged appointments, self-approval, reused evidence aliases,
unresolved items, overdue annual review dates, mutated role/policy bytes,
contradictory or draft policy headers, unlinked signers, unsafe repository
metadata, expired exceptions, and malformed exceptions.

The repository templates must fail. A passing command proves only that the
supplied safe metadata, exact local document bytes, and cross-record links are
internally consistent. It does not prove that the appointing authority exists,
that identities and evidence references are authentic, that people understood
their duties, that training occurred, that procedures operate, or that an
assessor accepts them.

## Acceptance test

This governance control becomes operational evidence only when the two linked
records pass, every reference resolves in the restricted system, policy documents
carry the exact approved headers and hashes, all affected people receive the
approved procedures and training plan, permissions reflect the assignments, and
a sampled Requirement 6 control execution demonstrates the documented roles and
separation. Until then, all six policies remain draft or assignment-required.
