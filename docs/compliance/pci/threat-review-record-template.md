# Threat-model review record

Complete this record in the approved restricted evidence system. Do not add
production identifiers, customer data, PAN, prompts, credentials, exploit detail,
or private findings to the repository copy.

| Field | Value |
|---|---|
| Review record ID | |
| Threat-model commit and SHA-256 | |
| Application release/deployment | |
| Architecture/data-flow version | |
| CDE/PAN scope decision reference | |
| Product Security reviewer | |
| Independent reviewer | |
| PCI owner/QSA reviewer | |
| Engineering/data/platform participants | |
| UTC review date | |
| Next review date | |

## Review result

- [ ] System scope, assets, actors and all nine trust boundaries match the deployed
      architecture.
- [ ] Every threat row has a supported control grade and evidence scope.
- [ ] Repository controls were traced to current code/tests/DDL.
- [ ] Configuration, operational and third-party claims were checked against
      retained external evidence.
- [ ] Every Critical/High residual action has a named owner, due date and stable
      finding/change ID.
- [ ] CDE impact, PAN policy and provider paths were approved.
- [ ] Penetration, AI red-team and segmentation scope covers the applicable open
      threats.
- [ ] No blocking threat lacks remediation or formal time-bounded approval.

## Threat disposition

| Threat ID | Decision | Owner | Due/expiry | Evidence/finding ID | Retest |
|---|---|---|---|---|---|
| | `mitigate` / `transfer` / `avoid` / `accept` | | | | |

## Decision

**Result:** `approved` / `approved with actions` / `rejected` / `incomplete`  
**Approver:**  
**UTC decision time:**  
**Restricted evidence links:**

An empty required field or unchecked required item forces `incomplete` or
`rejected`.
