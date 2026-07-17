# Secure development lifecycle

**Status:** Draft for Engineering and Security approval  
**Policy owner:** Engineering owner — unassigned  
**Control owner:** Product Security — unassigned  
**Review cadence:** At least annually and after material PCI DSS or architecture change

This procedure applies to bespoke/custom Truenote software and security-relevant
configuration, database, CI, and infrastructure changes. Approval and repeated use
are required before it becomes operational evidence.

## Required lifecycle

### 1. Define

- Record the user/operator need and affected components.
- Identify data, trust, provider, authentication, authorization, program,
  classification, retention, audit, and CDE boundaries.
- State security requirements and acceptance tests before implementation.
- Decide whether Security, PCI, data-owner, or platform approval is required.

### 2. Design

- Treat client values, uploaded content, retrieved excerpts, provider responses,
  and browser metadata as untrusted.
- Prefer least privilege, fail-closed boundaries, bounded external calls, and
  auditable state transitions.
- Threat-model new or changed trust boundaries. At minimum consider spoofing,
  tampering, repudiation, disclosure, denial of service, elevation of privilege,
  prompt injection, data poisoning, cross-program leakage, and sensitive output.
- For a possible CDE change, document data flow and segmentation/security impact.
- Use [`threat-model.md`](./threat-model.md) as the application baseline. Add or
  revise stable threat IDs when a review trigger changes an asset, actor, trust
  boundary, data path, provider, control, or residual treatment.

### 3. Implement

- Use supported dependencies and the pinned lockfile.
- Never place secrets, customer data, PAN, raw sensitive matches, or production
  exports in source, fixtures, CI output, or pull requests.
- Add negative tests for every new permission or data boundary.
- Preserve cite-or-refuse, server-side scope, hybrid retrieval, and evaluation
  invariants defined by `CLAUDE.md` and `CONTRIBUTING.md`.
- Use reviewed forward-only SQL and the repository's Replit production-definition
  verification protocol for database objects.

### 4. Review and verify

- A person other than the author reviews security-sensitive bespoke/custom code.
- Product Security reviews changed threat rows and records disposition, owner,
  due/expiry, evidence and retest in the restricted-system copy of
  [`threat-review-record-template.md`](./threat-review-record-template.md).
- Run type checking, production build, unit tests, dependency audit, secret scan,
  static analysis, and the narrowest security/eval suite relevant to the change.
- Run `pnpm run verify:pci-evidence` when PCI records, public security claims, or
  the security workflow changes; fix broken evidence paths, unsupported grades,
  missing scope labels, or weakened workflow invariants before review.
- Test common applicable attack classes, including injection, access-control
  bypass, unsafe deserialization/input handling, SSRF/provider abuse, file upload,
  cryptographic misuse, concurrency/race behavior, and business-logic abuse.
- A passing automated check does not close an unresolved vulnerability finding.

### 5. Release

- Use the approved change record in `.github/pull_request_template.md`.
- Retain reason, scope, security/CDE impact, approval, test results, deployment
  steps, rollback-to-secure-state procedure, and expected post-deployment result.
- Do not deploy when required runtime evidence has no owner or when a blocking
  finding lacks remediation or an approved time-bounded exception.

### 6. Operate and learn

- Verify the deployed state, including database definitions and external control
  configuration; do not infer deployment from source or CI.
- Route discovered vulnerabilities through the vulnerability-management process.
- Trigger incident response when exploitation or material exposure is suspected.
- Feed recurring defects into tests, threat models, and training.

## Training

Personnel who develop or review bespoke/custom software must complete role- and
language-relevant secure-development training at least annually. Training must
cover the tools they use to detect vulnerabilities. Evidence records participant,
course/provider, scope, completion date, and next due date. The
[`Truenote secure-development curriculum`](./secure-development-training-curriculum.md)
provides approval-ready role, language/framework, secure-design/coding, tool,
knowledge-check, and practical-assessment content. Use the
[`secure-development training record`](./secure-development-training-record-template.md)
for the annual population and the
[`secure-development review record`](./secure-development-review-record-template.md)
for a representative released change. The curriculum is unapproved and both
templates are intentionally unfilled; no delivery, training completion, or
sampled operating record is retained.

## Acceptance test

Sample one security-relevant production change. This control passes only if its
record demonstrates every applicable lifecycle stage, non-author review, required
training, successful checks, approved deployment, and verified production result.
