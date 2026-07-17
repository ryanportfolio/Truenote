# GitHub branch-enforcement evidence

**Status:** Machine-checkable evidence format implemented; live enforcement is
not currently verified  
**Owner:** Engineering owner - unassigned  
**Reviewer:** Security reviewer - unassigned

**Current priority decision:** Additional branch-evidence hardening is deferred
for now. Keep this practical baseline for future PCI/Security use; do not expand
it unless the compliance-accepting entity requests it or CDE integration makes it
necessary. This priority decision does not change the current Gap evidence grade.

This record is the fail-closed evidence format for the GitHub enforcement portion
of PCI DSS Requirement 6.5 change control. It converts a settings screenshot or
an informal statement into a dated, reviewable declaration tied to retained
GitHub API responses.

Use the parseable
[`JSON template`](./branch-enforcement-evidence-template.json). Its placeholders,
disabled rules, unapproved signoffs, and `pending` decision are intentional
failures. Do not replace them with plausible values without configuring the
repository and retaining the authentic API response bundle.

## Required live state

The completed record must show all of the following for `ryanportfolio/kbase` and
`refs/heads/main`:

1. enforcement is active and applies to the default branch;
2. pull requests are required with at least one approval;
3. stale approvals are dismissed, CODEOWNER review is required, and the last
   pusher cannot self-complete approval;
4. review conversations must be resolved;
5. required checks are enforced and branches must be current before merge;
6. administrators are enforced, direct pushes are restricted, and force pushes
   and deletion are blocked;
7. no bypass actor is configured; and
8. the four exact jobs from the `Security and quality` workflow are required:
   `Typecheck, build, tests`, `Dependency audit and SBOM`, `Secret scan`, and
   `CodeQL analysis and SARIF evidence`.

The record requires complete, authenticated API capture from both:

- `/repos/ryanportfolio/kbase/rulesets`
- `/repos/ryanportfolio/kbase/branches/main/protection`

For each response, record the exact official GitHub API endpoint, `GET`, HTTP 200,
GitHub request ID, response-body hash, page count, and completed-pagination flag.
Retain the complete responses together in the approved restricted evidence
system, record the bundle SHA-256 and safe reference, and do not copy tokens,
private repository data, or sensitive response material into this directory.

Required checks must record the exact GitHub check context and integration ID,
not only a human-readable workflow label. All four current jobs are GitHub Actions
jobs and therefore must resolve to one reviewed integration identity.

## Behavioral enforcement receipts

Configuration declarations are not enough. Schema version 2 requires all six
stable behavioral test IDs exactly once:

- `denied_unapproved_pr`
- `denied_missing_required_check`
- `denied_stale_review`
- `denied_direct_push`
- `denied_force_push`
- `allowed_fully_approved_merge`

The missing-check exercise must test each exact required check ID: `verify`,
`supply-chain`, `secrets`, and `codeql`. Each test records its expected and
actual result, controlled target reference, operator, independent reviewer,
execution/review times, restricted receipt ID and SHA-256. It also binds back to
the exact captured configuration artifact SHA-256 and controlled ruleset
reference. Targets and receipts cannot be reused across test IDs. Tests must
follow the API capture, complete within 24 hours of it, and be reviewed before
the engineering/security signoffs.

Retain the actual GitHub response, pull-request state, check state, and rejected
push output only in restricted storage. A declared `denied` result is not an
authenticated GitHub receipt; reviewers must resolve and compare every hash.

## CODEOWNERS prerequisite

Enabling "require code owner review" has no useful path coverage without a valid
CODEOWNERS file. A structurally accepted record must bind to
`.github/CODEOWNERS`, record its SHA-256 and owner tokens, and provide a final active
`*` rule that covers every repository path. The CLI reads the repository file and
compares it with the declaration. No CODEOWNERS file exists in the reviewed
worktree today, so this prerequisite remains a gap and no real record can pass.

## Freshness and approval

Evidence older than 30 days fails. Future timestamps, duplicate JSON keys,
placeholder hashes or references, accepted records with gaps, duplicate/missing
checks or behavioral tests, disabled controls, and bypass actors fail. The
engineering owner and security reviewer must be different identities, and
neither may be the API-capture operator.

The decision remains `pending` until the live configuration exists, the raw API
bundle is retained, and both reviewers accept it. A repository template or local
unit test is not a substitute for those steps.

## Validator

Run from the repository root:

```powershell
corepack pnpm --filter @workspace/scripts run verify:branch-enforcement -- docs/compliance/pci/branch-enforcement-evidence-template.json
```

The unfilled template must fail. Run the same command against the controlled
completed record after the settings are enabled and reviewed.

A passing command proves only that declared metadata is complete, current, and
internally consistent with the required TrueNote workflow/job/check names and
the local CODEOWNERS source. It does not parse the restricted API bodies,
authenticate GitHub responses or signer identities, prove that artifact hashes
resolve, evaluate organization-level or overlapping rulesets, inspect the
repository live, verify that a pull request was actually blocked, or replace
Security/PCI review. Reviewers must reconcile the declared settings against the
retained API bodies and denial tests before granting operational credit.

## Current-state boundary

The last retained historical check on 2026-07-16 reported no enforced branch
protection/ruleset. A later live re-check on the same date could not authenticate
because the available GitHub CLI credentials were invalid. Therefore this
document makes no current live-state claim: enforcement remains a **Gap** until a
new authenticated capture and negative merge/push test satisfy the acceptance
test below.

## Acceptance test

1. Configure and save the required rules for `main`.
2. Capture both GitHub API responses and retain the hashed bundle.
3. Complete the JSON record with distinct engineering and security review.
4. From controlled test branches, execute all six stable behavioral test IDs and
   retain distinct restricted receipts. The missing-check bundle must cover each
   of the four exact required checks.
5. Have an independent reviewer reconcile every receipt and configuration
   binding, then complete engineering and security signoffs.
6. Run the validator successfully.

Only the complete result supports operational branch-enforcement evidence.
