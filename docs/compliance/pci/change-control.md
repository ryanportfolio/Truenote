# Secure change control

**Status:** Draft for Engineering, Security, and PCI approval  
**Owner:** Change authority — unassigned

This procedure applies to production application, dependency, configuration,
provider, database, CI, identity, logging, network, and security-control changes.

## Normal change record

Use the pull-request template and retain:

1. reason and description;
2. affected components, data paths, and environments;
3. security and CDE impact;
4. authorized non-author review and any specialist approval;
5. test results, including relevant negative/security tests;
6. vulnerability/dependency results and exception links;
7. deployment steps and authorized deployment decision;
8. failure signal and procedure to return to a secure state;
9. post-deployment verification and evidence owner.

Changes to this PCI pack, the public security brief, or the security workflow must
also pass `pnpm run verify:pci-evidence`. This structural gate supplements—but
does not replace—review of whether the linked evidence actually proves the claim.

The [`branch-enforcement evidence format`](./branch-enforcement-evidence.md)
defines a separate fail-closed record for live GitHub settings. Its manual hosted
gate requires a current safe record, official API request metadata/body hashes,
exact required check contexts and integration identity, an all-path CODEOWNERS
source, no bypasses/gaps, and distinct engineering/security signoffs. This is
structural declared metadata; reviewers must reconcile it to the retained API
bodies and denial tests.

`CDE impact: not yet determined` blocks approval. A checked box without linked or
retained evidence does not satisfy the record.

`verify:change-record` reads the pull-request event body and rejects removed
sections, duplicate/missing fields, unresolved CDE impact, invalid change IDs,
author self-review, incomplete significant-change revalidation, missing emergency
authority/deadline, and any release decision other than approved. The hosted
security workflow runs it on opened, synchronized, reopened, and edited pull
requests. This is structural evidence only: it does not prove branch protection,
the truth of a field, actual GitHub review, organizational independence,
deployment, or post-deployment acceptance.

## PCI DSS 6.5 control coverage

### 6.5.1 Production change procedures

Every production system-component change records reason/description, security and
CDE impact, authorization, testing, and secure recovery. Bespoke/custom software
changes include the attack/vulnerability cases applicable under Requirement 6.2.4,
not only ordinary functional tests.

### 6.5.2 Significant-change completion

The change record identifies whether a change is significant. After completion,
the named evidence owner confirms every applicable PCI DSS requirement remains in
place and updates affected policies, procedures, diagrams, inventories, and other
documentation. A planned post-change check keeps the record open; it is not proof
of completion.

### 6.5.3 Pre-production separation

Pre-production environments remain separate from production, and access controls
enforce that separation. Record the applicable environment/configuration evidence
or an exact non-applicability rationale for review.

### 6.5.4 Roles and functions

Separate development/test and production roles or functions to provide
accountability appropriate to the environment. Record author, non-author reviewer,
deployer, and change authority or document the reviewed accountability model when
the organization is too small for full role separation.

### 6.5.5 Live PAN in pre-production

Do not use live PAN in pre-production. Any approved exception must protect PAN
according to all applicable PCI DSS requirements and retain the procedure,
authorization, scope, and evidence. Synthetic test PAN is the default.

### 6.5.6 Test data and accounts

Remove test data and test accounts from system components before they enter
production. Record the owner, removal result, and retained verification receipt;
a plan alone blocks final release closure.

## Database changes

- Use exact reviewed forward-only SQL; never infer production state from TypeScript
  bindings or a successful development execution.
- Replit publish may omit function/trigger/constraint definitions and does not
  promote row data. Inspect production object definitions after publishing.
- Record the reviewed SQL hash, executor/authority, target environment, result,
  production definition query, and rollback/forward-repair procedure.
- Never store credentials, production exports, or sensitive row data as evidence.

## Emergency changes

An emergency change requires an incident or urgent-risk identifier, named emergency
authority, minimum necessary scope, pre-change backup/rollback decision, and
immediate validation. Complete independent review, full test evidence, and the
normal record within two business days. Emergency status does not waive evidence or
permit unresolved PCI scope.

## Separation and enforcement

- Security-sensitive bespoke/custom changes require review by someone other than
  the author.
- Production deployment approval must come from the named change authority or its
  documented delegate.
- GitHub branch protection must require pull requests, required checks, and the
  approved number of reviews; direct/force pushes and branch deletion are denied.
- The independent reviewer and CODEOWNER identities are currently unassigned, no
  CODEOWNERS file exists, and the retained 2026-07-16 historical API check found
  no live protection. A later same-day re-check could not authenticate with the
  available GitHub CLI credentials, so current live state is unknown rather than
  freshly confirmed absent. This control remains a **Gap** until settings,
  owners, API evidence, and denial tests are retained.

## Acceptance test

Sample one normal and one emergency production change. Both must show the required
record, approval, successful tests, secure rollback path, deployed-state verification,
6.5.1 through 6.5.6 applicability/results, and closure of follow-up work. The PR
body must pass the structural change-record gate. GitHub API/settings evidence must
separately show enforcement and non-author approval. CODEOWNERS must cover every
repository path, and controlled attempts must prove unapproved/missing-check/stale-
review merges plus direct/force pushes are denied.
