# Secure development training record

**Status:** Unfilled operating-evidence template  
**Supports:** PCI DSS Requirement 6.2.2  
**Record ID:** `TN-SDLC-TRAIN-<YYYY>-<NNN>`  
**Training owner:** `<controlled principal ID>`  
**Review period:** `<start date>` through `<end date>`

Use one record for each annual training cycle. Keep personal details and course
certificates in the approved restricted evidence system. The repository-safe
copy uses stable principal IDs and controlled references only.

## Curriculum approval

| Field | Required value |
|---|---|
| Curriculum name and version | `TN-SDLC-CURRICULUM-001 v1.0` or `<approved equivalent title/version>` |
| Curriculum source/hash | [`secure-development-training-curriculum.md`](./secure-development-training-curriculum.md) plus `<approved SHA-256 or controlled equivalent reference>` |
| Approved by Product Security | `<principal, decision time, evidence reference>` |
| Applicable roles | `<developer, reviewer, platform/database, other>` |
| Languages/frameworks covered | `<current technology scope>` |
| Vulnerability-detection tools covered | `<CodeQL, dependency audit, secret scan, DAST, other>` |
| Secure coding topics | `<access control, injection, input handling, cryptography, SSRF, file upload, concurrency, business logic>` |
| AI/provider topics where applicable | `<prompt injection, data leakage, provider input/output handling, retrieval scope>` |
| PCI/data-handling topics | `<CDE impact, PAN prohibition in test, evidence handling, change control>` |
| Delivery method | `<course, workshop, lab, assessment>` |
| Passing requirement | `<score, completion, practical exercise>` |
| Evidence location | `<restricted reference>` |

## Participant register

| Principal ID | Role | Required topics | Completed at | Result | Certificate/assessment reference | Next due | Manager verified |
|---|---|---|---|---|---|---|---|
| `<principal>` | `<role>` | `<topic set>` | `<UTC timestamp>` | `<pass/fail>` | `<controlled reference>` | `<date>` | `<principal and time>` |

Record every person who develops or reviews bespoke/custom software. A person is
current only when the required role- and language-specific curriculum was passed
within the approved annual period and the evidence reference resolves.

## Coverage and gaps

| Metric | Value |
|---|---:|
| In-scope people | `<count>` |
| Current completions | `<count>` |
| Failed assessments | `<count>` |
| Overdue or missing completions | `<count>` |
| Approved temporary exceptions | `<count>` |

List every gap. Training exceptions must name an owner, compensating restriction,
expiry, and approver. An exception does not make an untrained person trained.

| Gap/exception ID | Principal ID | Restriction or remediation | Owner | Due/expiry | Approver | Evidence |
|---|---|---|---|---|---|---|
| `<stable ID>` | `<principal>` | `<action>` | `<principal>` | `<date>` | `<principal>` | `<reference>` |

## Attestation

| Role | Principal ID | Decision | Decided at | Evidence reference |
|---|---|---|---|---|
| Training owner | `<principal>` | `<complete/incomplete>` | `<UTC timestamp>` | `<reference>` |
| Product Security | `<different principal>` | `<accepted/rejected>` | `<UTC timestamp>` | `<reference>` |

## Acceptance test

The cycle is complete only when the participant population reconciles to the
current developer/reviewer roster; every required participant has current,
role-relevant completion evidence; failures and gaps are restricted or resolved;
and Product Security accepts the record. This blank template is not proof that
training occurred.
