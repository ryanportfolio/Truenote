## Change identity

<!-- Replace every option/placeholder. The structural CI gate fails until this record is complete. -->

- Change ID: `TN-CHG-YYYY-NNN`
- Change type: `normal` / `emergency`
- Author: `@github-user`
- Target release/commit: `<release or immutable commit identity>`
- Target environment: `<environment>`
- Significant change: `yes` / `no`
- Significant-change rationale: `<decision and affected PCI scope/documentation>`

## Purpose and scope

- Purpose: `<user/operator problem and reason for change>`
- Affected components and data boundaries: `<components, providers, database objects, settings, and data paths>`

## Security and PCI impact

- CDE impact: `none` / `possible` / `in scope`
- CDE-impact rationale: `<why, including segmentation/security impact>`
- Security impact and threat considered: `<authentication, authorization, isolation, sensitive data, audit, retention, providers, CDE, and threat IDs>`

## PCI DSS 6.5 change controls

<!-- “Not applicable” always needs a specific rationale and remains subject to reviewer/QSA acceptance. -->

- 6.5.1 bespoke/custom security testing: `completed` / `not applicable`
- 6.5.1 evidence or rationale: `<6.2.4-style attack/vulnerability tests and receipt, or exact rationale>`
- 6.5.2 completion revalidation: `planned` / `completed` / `not applicable`
- 6.5.2 evidence owner and plan/result: `<owner, applicable PCI controls/documents, acceptance result or scheduled closure>`
- 6.5.3 pre-production separation: `confirmed` / `not applicable`
- 6.5.3 evidence or rationale: `<separation evidence or exact rationale>`
- 6.5.4 role/function separation: `confirmed` / `not applicable`
- 6.5.4 evidence or accountability rationale: `<author/reviewer/deployer/change-authority separation or documented accountability>`
- 6.5.5 live PAN in pre-production: `no live PAN` / `protected per approved procedure` / `not applicable`
- 6.5.5 evidence or rationale: `<synthetic-data statement or approved protection evidence>`
- 6.5.6 test data/accounts removal: `planned` / `completed` / `not applicable`
- 6.5.6 evidence owner and plan/result: `<owner, removal plan/result, and receipt>`

## Verification

- Commands and results: `<exact checks and outcomes>`
- Negative/security tests: `<tests added/updated and outcome>`
- Runtime/integration verification: `<result or Pending: owner and acceptance test>`
- Evidence not collected locally: `<owner, target environment, expected result, and evidence ID>`

## Vulnerabilities and dependencies

- Dependency/SBOM impact: `<new/changed dependencies, audit/SBOM result, or reason none>`
- Finding/exception links: `<stable finding IDs and approvals, or None: specific rationale>`

## Deployment and secure recovery

- Deployment/configuration/DDL steps: `<authorized steps and executor>`
- Post-deployment verification: `<binary acceptance checks, owner, and evidence ID>`
- Failure signal: `<observable condition that blocks/rolls back>`
- Secure recovery procedure: `<reviewed rollback or forward-repair path>`
- Incident ID: `<required for emergency; for normal use Not applicable: normal change>`
- Emergency authority: `<required for emergency; for normal use Not applicable: normal change>`
- Retrospective review due: `<YYYY-MM-DD for emergency; for normal use Not applicable: normal change>`

## Approval and closure

- Non-author reviewer: `@github-user`
- Review evidence: `<pull-request review URL or immutable receipt ID>`
- Specialist approval: `<Security/PCI/data/platform approval ID, or Not applicable: exact rationale>`
- Release/change-authority decision: `approved` / `pending`

<!--
This gate checks record structure and internally consistent identities. It does not prove
that GitHub branch protection is enabled, a reviewer actually approved through GitHub,
the reviewer is organizationally independent, deployment occurred, or runtime evidence
passed. Retain those receipts separately and link safe identifiers above.
-->
