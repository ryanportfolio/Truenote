# Public security reporting and discovery

**Status:** Public overview and RFC 9116 record observed in production; GitHub
private-intake operation remains unverified
**Owner:** Product Security - unassigned  
**Review date:** 2026-07-16

This control closes the repository-side portion of the assessment finding that a
public security contact was not discoverable. It uses RFC 9116 to point directly
to the repository's private GitHub vulnerability intake and maintained security
policy without inventing an email address, company identity, response SLA, or
disclosure commitment. A dedicated `/security/report/` page was retired from
navigation after production repeatedly served the SPA shell at that path.

## Public paths

- `https://truenote.org/security/` is the existing public security-capabilities
  brief backed by `docs/security/truenote-security-capabilities.html` and the
  `publish-security-page` Vite plugin.
- `https://truenote.org/.well-known/security.txt` is backed by
  `artifacts/rag-app/public/.well-known/security.txt` using RFC 9116 fields.
- Its `Contact` field opens GitHub private vulnerability reporting and its
  `Policy` field opens the repository's maintained GitHub security policy.
- The login surface links to the security overview. The overview and sitemap
  expose PCI Readiness rather than the retired reporting page.

The reporting contact opens GitHub private vulnerability reporting for
`ryanportfolio/Truenote`. If that facility is unavailable, `SECURITY.md` tells
the reporter to request a private channel from the repository owner without
disclosing vulnerability details.

## Safety and claim boundaries

The repository policy requires synthetic data and tells reporters not to submit customer
content, personal data, PAN, credentials, session tokens, API keys, or private
database output. It prohibits accessing data that is not theirs, degrading a
shared service, or testing third-party providers without authorization.

The public overview and repository policy do not claim PCI DSS or FedRAMP compliance, certification, independent
assessment, deployed security, or a response/remediation SLA. Repository source
and local tests remain distinct from deployment and operation.

## Machine checks

`scripts/src/public-security-page.test.ts` contains four portable tests that
verify:

1. login-to-overview discovery, removal of the broken reporting route from the
   overview and sitemap, the exact private GitHub reporting path, PCI discovery,
   and absence of an invented `mailto:` or SLA;
2. sensitive-data, safe-testing, and assurance-boundary text;
3. the retained reporting-policy source's skip-link/main/heading structure,
   external CSS, noreferrer links, focus styling, responsive styling, and no
   inline script/style; and
4. the RFC 9116 contact, canonical and policy fields plus a future expiry no more
   than 366 days away.

The expiring `security.txt` test intentionally creates an annual maintenance
obligation instead of allowing a permanently stale discovery record.

## Acceptance test

Repository implementation becomes operational evidence only when an authorized
owner:

1. approves the public wording and named GitHub repository/owner;
2. confirms GitHub private vulnerability reporting is enabled and monitored;
3. builds and deploys the reviewed commit;
4. fetches `/security/`, `/security/styles.css`, and
   `/.well-known/security.txt` from the public origin; verifies expected content
   rather than status alone; and retains status, content-type, body hash, date,
   and reviewed release identity;
5. submits a harmless synthetic private test report, records acknowledgement and
   routing without sensitive content, then closes it through the approved
   workflow; and
6. assigns review ownership for the overview, repository policy, intake queue, and
   `security.txt` expiry.

Until those steps pass, the evidence grade is **Implemented, unverified**.
