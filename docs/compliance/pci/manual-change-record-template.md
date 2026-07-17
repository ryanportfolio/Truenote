# Manual PCI change record template

**Template status:** Unfilled; not approval or deployment evidence

**Use:** One copy per normal or emergency production change

**System of record:** `<approved system and controlled record reference>`

Do not mark the record closed while any required field, approval, test, recovery
result, or post-change verification is missing. Use controlled references for
restricted evidence. Never include credentials, PAN, customer data, production
exports, or detailed unremediated exploit material.

## 1. Change identity

- Change ID: `<stable unique identifier>`
- Title: `<short description>`
- Change type: `<normal | emergency>`
- Status: `<draft | approved | scheduled | deployed | recovered | failed | rejected | cancelled | closed>`
- Requester: `<named person or controlled identity reference>`
- Record opened (UTC): `<YYYY-MM-DDThh:mm:ssZ>`
- Planned production window (UTC): `<start and end>`
- Actual production window (UTC): `<start and end or not started>`
- Target release/configuration/database identity: `<immutable identifier or hash>`
- Related incident/problem/request: `<controlled reference or none>`

## 2. Reason, scope, and data boundary

- Reason for change: `<business, security, defect, or regulatory reason>`
- Description: `<what will change and what will not>`
- Affected components and services: `<bounded list>`
- Affected environments: `<development, test, staging, production>`
- Affected data flows and stores: `<safe references; no sensitive topology>`
- Customer/CDE dependency: `<safe responsibility or scope reference>`
- Dependency/provider impact: `<providers, libraries, platforms, or none>`

## 3. Security and PCI impact

- Security impact: `<confidentiality, integrity, availability, identity, logging, recovery, or none with rationale>`
- Threats considered: `<threat-model IDs or substantive summary>`
- CDE impact: `<none | possible | in scope>`
- CDE-impact rationale and approval reference: `<required>`
- Significant change: `<yes | no>`
- Significant-change rationale: `<required>`
- PCI DSS requirements affected: `<exact requirements or approved none rationale>`
- Requirement 6.2.4 test obligations: `<applicable cases and evidence plan>`
- Required specialist review: `<Product Security, PCI/QSA, privacy, database, IAM, vendor risk, or none with rationale>`

## 4. Roles and accountability

| Role | Named person or controlled identity | Evidence/reference |
|---|---|---|
| Requester | `<required>` | `<required>` |
| Developer/configuration author | `<required>` | `<required>` |
| Code reviewer other than originating author | `<required for bespoke/custom software; otherwise approved not applicable>` | `<required>` |
| Tester | `<required>` | `<required>` |
| Security or specialist reviewer | `<required or approved not applicable>` | `<required>` |
| Production deployer | `<required>` | `<required>` |
| Change authority | `<required>` | `<required>` |
| Post-change verifier | `<required>` | `<required>` |

- Role/function separation result: `<confirmed | approved accountability model>`
- Overlapping-role rationale and additional safeguards: `<required when roles overlap>`
- Production-access authorization reference: `<required>`
- Non-author code review result: `<required for bespoke/custom software; role-overlap rationale cannot waive it>`

## 5. Pre-production controls

- Pre-production separated from production: `<confirmed | approved not applicable>`
- Separation/access-control evidence: `<controlled reference>`
- Live PAN used in pre-production: `<no | approved exception>`
- PAN rationale, authorization, protection, and evidence: `<required for exception>`
- Synthetic test data/accounts planned: `<bounded list or none>`
- Test data/account removal owner and method: `<required>`

## 6. Test plan and results

| Test | Environment | Expected result | Actual result | Evidence/reference | Finding ID |
|---|---|---|---|---|---|
| Functional acceptance | `<required>` | `<required>` | `<pass/fail/not run>` | `<required>` | `<ID or none>` |
| Authorization and data-boundary negative test | `<required>` | `<required>` | `<pass/fail/not run>` | `<required>` | `<ID or none>` |
| Security regression / Requirement 6.2.4 | `<required>` | `<required>` | `<pass/fail/not run>` | `<required>` | `<ID or none>` |
| Vulnerability/dependency/secret scan | `<required>` | `<required>` | `<pass/fail/not run>` | `<required>` | `<ID or none>` |
| Recovery rehearsal or validation | `<required>` | `<required>` | `<pass/fail/not run>` | `<required>` | `<ID or none>` |

- Open findings and dispositions: `<owner, due date, decision, exception/retest reference>`
- Test approver: `<named authorized party>`
- Test approval reference/time (UTC): `<required>`

## 7. Deployment and secure recovery

- Deployment steps and exact artifact/configuration identity: `<required>`
- Preconditions and go/no-go checks: `<required>`
- Failure signals and stop conditions: `<required>`
- Secure recovery method: `<rollback, restore, disable, or forward repair>`
- Recovery authority: `<named identity>`
- Backup/snapshot decision and evidence: `<required>`
- Recovery time/data-loss expectation: `<approved target or not applicable rationale>`
- Production approval decision: `<approved | rejected>`
- Production approval reference/time (UTC): `<required>`

## 8. Deployment result

- Executor: `<named identity>`
- Environment: `<exact assessed production environment reference>`
- Released artifact/configuration/database identity: `<immutable ID/hash>`
- Started/completed (UTC): `<required>`
- Result: `<successful | failed | recovered | cancelled>`
- Execution evidence: `<controlled reference>`
- Unexpected behavior or incident: `<reference or none>`
- Recovery invoked: `<yes | no>`
- Recovery result/evidence: `<required if invoked>`

## 9. Post-change verification

- Production health/security checks: `<tests and results>`
- Logging, monitoring, SIEM, and alert checks: `<results/evidence>`
- Data-boundary/provider checks: `<results/evidence>`
- Test data/accounts removed: `<confirmed with owner, time, and evidence>`
- Open findings/follow-up actions: `<owner, due date, disposition, reference>`
- Post-change verifier: `<named identity>`
- Verification completed (UTC): `<required>`

## 10. Significant-change revalidation

Complete when `Significant change: yes`.

- Applicable PCI DSS requirements confirmed in place: `<list and evidence>`
- Scope/CDE boundary reviewed and annual scope input updated: `<reference>`
- Network/data-flow diagrams updated: `<reference or not affected rationale>`
- Inventories and responsibility matrix updated: `<reference or rationale>`
- Policies/procedures/runbooks updated: `<reference or rationale>`
- Revalidation owner and completion time (UTC): `<required>`

## 11. Emergency-change supplement

Complete when `Change type: emergency`.

- Incident or urgent-risk ID: `<required>`
- Emergency authority and approval time (UTC): `<required>`
- Why normal timing was unsafe: `<required>`
- Minimum necessary scope: `<required>`
- Immediate validation result: `<required>`
- Retrospective reviewer and due date: `<approved deadline; draft operating target is within two business days>`
- Retrospective result and full-test completion: `<required before closure>`

## 12. Closure

- Final status: `<closed | failed | recovered | rejected | cancelled>`
- All required evidence references resolve: `<yes | no>`
- Findings resolved or controlled: `<yes | no>`
- 6.5.1 through 6.5.6 results complete: `<yes | no>`
- Closure authority: `<named authorized party>`
- Closure approval reference/time (UTC): `<required>`
- Register entry updated: `<yes | no and reference>`
- Next review/expiry: `<date or none with rationale>`

The record is incomplete if any required answer is a placeholder, a plan is
substituted for an actual result, an approval cannot be authenticated, or a
controlled evidence reference cannot be resolved.
