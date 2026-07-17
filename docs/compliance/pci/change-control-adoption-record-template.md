# PCI change-control adoption record template

**Template status:** Unfilled; not approval or operating evidence

**Current Requirement 6.5 control grade:** Gap

Use this record in the authorized PCI decision meeting to approve the
tool-neutral change-control process and its organization-defined operating
choices. Store the completed record and restricted approvals in the approved
system of record. Do not include credentials, PAN, customer data, production
exports, personal contact details, or sensitive topology.

## 1. Record identity

- Adoption record ID: `<stable controlled identifier>`
- Decision meeting ID: `<controlled meeting reference>`
- Decision date/time (UTC): `<YYYY-MM-DDThh:mm:ssZ>`
- Record preparer: `<controlled principal ID>`
- Restricted evidence location: `<controlled reference>`
- Approved role-assignment record ID and SHA-256: `<required>`
- Approved policy-adoption record ID and SHA-256: `<required>`
- Effective date/time (UTC): `<YYYY-MM-DDThh:mm:ssZ>`
- Next review date: `<approved date>`

## 2. Procedure identity

- Procedure path: `docs/compliance/pci/change-control.md`
- Procedure version: `<approved version>`
- Exact approved SHA-256: `<64 lowercase hexadecimal characters>`
- Decision: `<approved | rejected | deferred>`
- Decision rationale: `<substantive rationale>`
- Approved exceptions: `<controlled references or none>`

Any later byte change requires a controlled amendment or new adoption record.

## 3. Authority and accountability

| Responsibility | Primary principal | Delegate | Appointment/approval reference |
|---|---|---|---|
| Change authority | `<required>` | `<required>` | `<required>` |
| Engineering owner | `<required>` | `<required>` | `<required>` |
| Product Security | `<required>` | `<required>` | `<required>` |
| PCI scope owner | `<required>` | `<required>` | `<required>` |
| Production/platform owner | `<required>` | `<required>` | `<required>` |
| Register reconciler | `<required>` | `<required>` | `<required>` |
| Evidence custodian | `<required>` | `<required>` | `<required>` |

- Production/pre-production role-overlap model: `<separated | approved accountability model>`
- Overlap rationale and additional controls: `<required when roles overlap>`
- Bespoke/custom software non-author review owner: `<required>`
- Non-author review assurance: `<controlled identity and review evidence; role overlap cannot waive Requirement 6.2.3>`

## 4. Approved system of record

- System name and owner: `<required>`
- Record types stored: `<register, normal changes, emergency changes, approvals, tests, deployments, recovery, closure>`
- Access-control model: `<who can create, approve, deploy, close, administer, and audit>`
- Authentication and audit evidence: `<controlled references>`
- Record version-history and audit behavior: `<required>`
- Export and assessor-sampling method: `<required>`
- Backup/recovery owner and evidence: `<controlled reference>`

GitHub may supply supporting artifacts, but it is not required to be the system
of record and additional branch evidence is not a prerequisite for this adoption.

## 5. Population and reconciliation

- Production-change population sources: `<release/deployment, database/configuration, provider, IAM, network, logging/SIEM, incidents, and other applicable sources>`
- Reconciliation owner: `<required>`
- Approved reconciliation cadence: `<organization-defined cadence>`
- Cadence rationale: `<risk and assessment-period basis>`
- Assessment/sample period: `<start and end or decision trigger>`
- Missing/duplicate/failed/recovered/cancelled handling: `<required>`
- Reconciliation approval reference: `<required>`

The cadence is an organization-defined control decision. Do not describe the
draft quarterly target as a PCI DSS-prescribed frequency.

## 6. Retention and evidence handling

- Retention period: `<approved duration>`
- Retention authority or policy reference: `<required>`
- Restricted evidence classes: `<required>`
- Repository-safe metadata rules: `<required>`
- Legal hold or investigation preservation path: `<required or approved not applicable>`
- Disposal owner and method: `<required>`

## 7. Normal-change requirements

- Required record template or system fields: `<controlled reference>`
- Security-impact and CDE-impact approval path: `<required>`
- Significant-change decision owner: `<required>`
- Requirement 6.2.3 non-author review path: `<required for bespoke/custom software>`
- Requirement 6.2.4 security-test path: `<required for bespoke/custom software>`
- Production approval authority: `<required>`
- Secure recovery evidence: `<required>`
- Post-change verification and closure authority: `<required>`

## 8. Emergency-change requirements

- Emergency authority: `<required>`
- Incident/urgent-risk linkage: `<required>`
- Minimum record required before execution: `<required>`
- Immediate validation and recovery requirements: `<required>`
- Approved retrospective-review deadline: `<organization-defined deadline>`
- Deadline rationale: `<required>`
- Tabletop owner and cadence/trigger: `<required>`
- Tabletop scenario and evidence destination: `<required>`

The draft two-business-day target is organization-chosen, not a PCI
DSS-prescribed deadline. Do not manufacture an emergency event. If no emergency
occurred in the sampled period, retain reconciled zero-event evidence and an
approved tabletop/process-test result.

## 9. Initial operating-evidence milestones

| Milestone | Owner | Due date/trigger | Acceptance evidence | Status |
|---|---|---|---|---|
| Reconcile the initial production-change population | `<required>` | `<required>` | `<register and source reconciliation references>` | `<open | complete>` |
| Sample one normal production change | `<required>` | `<required>` | `<complete authentic record and closure>` | `<open | complete>` |
| Evidence emergency handling | `<required>` | `<required>` | `<actual emergency sample, or zero-event reconciliation plus tabletop>` | `<open | complete>` |
| Review access and record integrity | `<required>` | `<required>` | `<access/audit/export evidence>` | `<open | complete>` |
| Conduct effectiveness review | `<required>` | `<required>` | `<findings, owners, dates, retests, and approval>` | `<open | complete>` |

## 10. Approval

| Decision role | Principal | Decision | Controlled approval reference | Time (UTC) |
|---|---|---|---|---|
| Change authority | `<required>` | `<approve | reject>` | `<required>` | `<required>` |
| Engineering owner | `<required>` | `<approve | reject>` | `<required>` | `<required>` |
| Product Security | `<required>` | `<approve | reject>` | `<required>` | `<required>` |
| PCI scope owner | `<required>` | `<approve | reject>` | `<required>` | `<required>` |
| Compliance-accepting entity | `<required>` | `<approve | reject>` | `<required>` | `<required>` |
| QSA/assessor, if engaged | `<required or approved not engaged>` | `<reviewed | advisory | accept | reject | not engaged>` | `<required>` | `<required>` |

- Unresolved items: `<stable action IDs with owner, due date, and acceptance test, or none>`
- Final adoption status: `<approved | rejected | deferred>`

## Binary acceptance test

This record supports adoption only when:

1. the exact procedure bytes and decision are authenticated and agree with the
   approved role and policy-adoption records;
2. every authority, delegate, system-of-record choice, retention decision,
   reconciliation source/cadence, and emergency rule is complete;
3. Requirement 6.2.3 non-author review is not waived by role overlap;
4. the restricted references and approvals resolve to authentic evidence;
5. unresolved items have an owner, due date, and binary acceptance test; and
6. the initial operating-evidence milestones remain explicitly open until their
   authentic results are reviewed.

A completed adoption record approves the process. It does not by itself prove
that the process operates or that PCI DSS Requirement 6.5 is satisfied.
