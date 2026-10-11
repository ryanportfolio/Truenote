---
title: Secure development and change control summary
description: How a change reaches Truenote production, and which checks it must pass on the way.
updated: 2026-10-11
---

## From commit to production

1. Truenote has one owner-developer, who works with AI coding agents. GitHub secret scanning push protection checks every push.
2. Every change goes through a pull request. No one can push directly to the main branch, force-push to it or delete it, and the rule has no bypass list.
3. Each pull request must pass four required checks: typecheck, build and tests; a production dependency audit with an SBOM; a Gitleaks secret scan; and CodeQL static analysis. A new High CodeQL alert blocks the merge.
4. Each pull request is reviewed by several independent AI reviewers (OpenAI Codex), and confirmed findings are fixed before the merge.
5. The pull request description is the written change record: purpose, security impact, testing, deployment steps, rollback and approval.
6. The application services are deployed by a GitHub Actions workflow, only from main and only when the commit's security checks passed. The database, malware scanner and backup services are deployed by hand from a clean checkout of reviewed main, and recovery deploys follow a documented manual procedure. Every deployment is recorded with its commit, CI run, deployment ID and image digest, and the system owner's go precedes it.
7. Database schema changes are reviewed SQL files, applied in one transaction with a recorded hash, and refused if already applied.

## Change types

| Type | Record |
| --- | --- |
| Code or configuration in the repository | Pull request with the change record |
| Automated dependency update (Dependabot, dependency files only) | The pull request itself, with the upstream release notes and CI results; the merge is the approval |
| Production deploy | The pull request record plus the deployment entry |
| Schema change | Change record with the reviewed SQL hash and the dry-run and applied output |
| Hosting or settings change outside the repository | Written change record |
| Emergency change | Incident reference; full record within 2 business days |

## Single-owner accountability

With one person writing and approving changes, no reviewer can be independent of the author. Truenote records this openly: the automated checks, the multi-agent review and the written change record stand in for a second human reviewer, and the system owner will sign a quarterly statement that the process was followed. The first customer's security reviewer is asked to accept this arrangement.

## Status

Of the 24 pipeline gates in the detailed document, 7 are implemented, 13 are partially implemented, 3 are planned and 1 is a gap. The open ones are tracked in the plan of action and milestones.
