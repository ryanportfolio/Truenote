# Secure development review record

**Status:** Unfilled operating-evidence template  
**Supports:** PCI DSS Requirement 6.2 and the bespoke/custom software portions of 6.5  
**Record owner:** `<controlled principal ID>`  
**Record ID:** `TN-SDLC-<YYYY>-<NNN>`

Use this record for one representative security-relevant production change. It
collects the evidence that the approved secure development lifecycle was used.
It does not replace the pull-request change record, vulnerability register, or
production verification record. Link those records here.

Do not place names, email addresses, credentials, PAN, customer content, raw
prompts, production exports, scanner details, or exploit instructions in this
repository copy. Use stable principal IDs and controlled evidence references.

## 1. Change and release binding

| Field | Required value |
|---|---|
| Record ID | `TN-SDLC-<YYYY>-<NNN>` |
| Change record ID | `TN-CHANGE-<YYYY>-<NNN>` |
| Repository and commit | `<repository>` / `<40-character commit SHA>` |
| Pull request | `<controlled reference>` |
| Released version or deployment ID | `<controlled reference>` |
| Target environment | `<controlled environment reference>` |
| Final PCI scope record | `<record ID and exact-file SHA-256, or approved not-yet-in-scope rationale>` |
| Security relevance | `<why this is the sampled change>` |
| CDE or segmentation impact | `<yes/no plus approved evidence reference>` |
| Started / released / verified | `<canonical UTC timestamps>` |

## 2. People and qualification

| Function | Principal ID | Evidence required |
|---|---|---|
| Author | `<principal>` | Current role assignment |
| Non-author reviewer | `<different principal>` | Review receipt |
| Product Security reviewer | `<principal>` | Security disposition receipt |
| Change authority | `<principal>` | Release decision receipt |
| Deployment operator | `<principal>` | Deployment receipt |

For every person who developed or reviewed bespoke/custom software, record the
current annual training entry from
[`secure-development-training-record-template.md`](./secure-development-training-record-template.md).

| Principal ID | Training record ID | Completed | Due | Curriculum version | Evidence reference |
|---|---|---|---|---|---|
| `<principal>` | `TN-SDLC-TRAIN-<YYYY>-<NNN>` | `<date>` | `<date>` | `<version>` | `<controlled reference>` |

Stop the review if a required participant has no current training evidence or if
the author and required non-author reviewer are the same principal.

## 3. Define and design

### Change requirement

- User or operator need: `<summary>`
- Affected components and interfaces: `<stable component IDs>`
- Data classes and flows: `<safe references>`
- Security requirements stated before implementation: `<controlled reference>`
- Security acceptance tests stated before implementation: `<controlled reference>`

### Threat and scope review

| Question | Decision | Evidence |
|---|---|---|
| New or changed trust boundary? | `<yes/no>` | `<threat IDs and review record>` |
| Authentication or authorization changed? | `<yes/no>` | `<evidence>` |
| Provider or AI boundary changed? | `<yes/no>` | `<evidence>` |
| Sensitive-data handling changed? | `<yes/no>` | `<evidence>` |
| CDE, connected-system, segmentation, or payment-page impact? | `<yes/no>` | `<scope/change approval>` |
| Database or infrastructure security definition changed? | `<yes/no>` | `<reviewed definition and verification plan>` |

Every applicable Critical or High residual threat must have an accountable
owner, target date, treatment, and planned retest before release approval.

## 4. Implementation and review evidence

| Control | Result | Evidence reference |
|---|---|---|
| Supported dependencies and reviewed lockfile used | `<pass/fail/N/A>` | `<artifact>` |
| No secrets, PAN, customer data, or production exports added | `<pass/fail>` | `<review/scan>` |
| Negative tests added for changed permissions or data boundaries | `<pass/fail/N/A>` | `<tests>` |
| Forward-only reviewed SQL used where applicable | `<pass/fail/N/A>` | `<SQL hash/review>` |
| Non-author code review completed | `<pass/fail>` | `<review receipt>` |
| Threat changes reviewed by Product Security | `<pass/fail/N/A>` | `<review record>` |
| Open findings dispositioned before release | `<pass/fail>` | `<register snapshot>` |

`N/A` requires a specific rationale and reviewer approval. It cannot be used to
hide a failed or unexecuted applicable control.

## 5. Verification results

Record the exact released commit and retained artifact for every applicable
check. A link to a workflow definition is not an execution receipt.

| Check | Required? | Result | Artifact or run reference | Reviewed by |
|---|---:|---|---|---|
| Type checking | `<yes/no>` | `<pass/fail/N/A>` | `<reference>` | `<principal>` |
| Production build | `<yes/no>` | `<pass/fail/N/A>` | `<reference>` | `<principal>` |
| Unit and integration tests | `<yes/no>` | `<pass/fail/N/A>` | `<reference>` | `<principal>` |
| Relevant negative/security tests | `<yes/no>` | `<pass/fail/N/A>` | `<reference>` | `<principal>` |
| Dependency audit | `<yes/no>` | `<pass/fail/N/A>` | `<reference>` | `<principal>` |
| SBOM generation and inventory review | `<yes/no>` | `<pass/fail/N/A>` | `<reference>` | `<principal>` |
| Secret scan | `<yes/no>` | `<pass/fail/N/A>` | `<reference>` | `<principal>` |
| Static analysis | `<yes/no>` | `<pass/fail/N/A>` | `<reference>` | `<principal>` |
| Dynamic or deployed security test | `<yes/no>` | `<pass/fail/N/A>` | `<reference>` | `<principal>` |
| PCI evidence integrity gate | `<yes/no>` | `<pass/fail/N/A>` | `<reference>` | `<principal>` |

## 6. Findings and exceptions

| Finding or exception ID | Severity | Disposition | Owner | Due or expiry | Retest evidence |
|---|---|---|---|---|---|
| `<stable ID>` | `<severity>` | `<remediate/mitigate/not affected/exception>` | `<principal>` | `<date>` | `<reference>` |

No `pending` disposition, overdue blocking finding, expired exception, or missing
required retest may appear in an accepted record.

## 7. Release and production verification

| Evidence | Result or reference |
|---|---|
| Authorized deployment decision | `<controlled approval reference>` |
| Deployment steps and operator receipt | `<reference>` |
| Secure rollback or forward-repair procedure | `<reference>` |
| Test accounts/data removed before production | `<result and receipt>` |
| Production definitions/configuration verified | `<result and receipt>` |
| Expected security result observed | `<result and receipt>` |
| Unexpected result or follow-up finding | `<finding ID or none>` |
| Record closed at | `<canonical UTC timestamp>` |

## 8. Final decisions

| Role | Principal ID | Decision | Decided at | Evidence reference |
|---|---|---|---|---|
| Engineering owner | `<principal>` | `<accepted/rejected>` | `<UTC timestamp>` | `<reference>` |
| Product Security | `<different principal>` | `<accepted/rejected>` | `<UTC timestamp>` | `<reference>` |
| Change authority | `<principal>` | `<approved/rejected>` | `<UTC timestamp>` | `<reference>` |

## Acceptance test

The record is accepted only when it is bound to one released commit and target
environment; all applicable lifecycle stages have retained evidence; developer
and reviewer training is current; non-author review occurred; required tests
passed; findings and exceptions are resolved within approved rules; deployment
was authorized; and the production result was verified. An unfilled template,
local test run, or unsigned record is not operating evidence.
