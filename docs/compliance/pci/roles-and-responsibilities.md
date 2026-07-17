# PCI roles and responsibilities

**Status:** Assignment required before policies become operational evidence

Use the machine-checked
[`role-assignment record`](./pci-governance-adoption-records.md) and its
[`intentionally failing JSON template`](./pci-role-assignment-record-template.json)
to record assignees, delegates, appointments, acknowledgements, critical
separation, effective time, annual review, and executive/compliance approvals.
No populated record or appointment is supplied by this repository.

| Role | Responsibilities | Named assignment | Evidence required |
|---|---|---|---|
| PCI scope owner | Own CDE boundary, applicability, assessment coordination, and annual scope confirmation | Unassigned | Written appointment and approved scope |
| QSA/compliance-accepting entity | Determine assessment/validation expectations and evidence sufficiency | External/unassigned | Engagement or written direction |
| Engineering owner | Maintain secure development process, component inventory, and delivery gates | Unassigned | Appointment and sampled change evidence |
| Product Security | Own threat review, vulnerability process, secure-development training, and external testing | Unassigned | Appointment, register, training, test reports |
| Independent code reviewer | Review security-sensitive bespoke/custom changes independently of author | Unassigned | GitHub identity/team, CODEOWNERS/branch rule, review records |
| Change authority | Approve production and emergency changes | Unassigned | Appointment and change records |
| Platform/database owner | Own Replit/Neon configuration, production definitions, backup/restore, and recovery evidence | Unassigned | Read-only catalog-query output/definitions, configuration exports, and exercise results |
| IAM owner | Own IdP/MFA, break-glass, access reviews, and joiner/mover/leaver evidence | Unassigned | IdP exports and review records |
| Security operations/SIEM owner | Own event delivery, alerting, retention, dead-letter response, and incident escalation | Unassigned | SIEM receipts, alert tests, runbooks |
| Data/content owner | Approve sources, classifications, retention, revocation, and permitted sensitive-data use | Unassigned | Approval and review records |
| Vendor-risk owner | Own provider due diligence, contracts, subprocessor/data-retention evidence, and annual review | Unassigned | Responsibility matrix and current attestations |

## Separation constraints

- The author cannot be the independent reviewer for a security-sensitive bespoke
  or custom software change.
- Content activation is role-authorized: senior managers and super users may
  activate their own uploads after automated controls; other uploads require an
  authorized reviewer. Do not claim universal uploader/reviewer separation.
- An emergency approver may authorize urgency but cannot permanently waive
  retrospective review, testing, or evidence.

## Acceptance test

Every row has a named person/team and delegate, affected people acknowledge their
responsibilities, GitHub/production permissions reflect the assignments, and a
sampled control execution matches the documented separation.
