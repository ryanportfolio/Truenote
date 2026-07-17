# Public security reporting and discovery

**Status:** Implemented and production-built in repository; deployed availability
and operating intake remain unverified  
**Owner:** Product Security - unassigned  
**Review date:** 2026-07-16

This control closes the repository-side portion of the assessment finding that a
public security contact was not discoverable. It extends the existing public
security-capabilities route with a direct reporting link, uses the existing
private GitHub vulnerability-reporting policy, and does not invent an email
address, company identity, response SLA, or disclosure commitment.

## Public paths

- `https://truenote.org/security/` is the existing public security-capabilities
  brief backed by `docs/security/truenote-security-capabilities.html` and the
  `publish-security-page` Vite plugin.
- `https://truenote.org/security/report/` is the dedicated reporting policy
  backed by `artifacts/rag-app/public/security/report/index.html` and its
  external stylesheet.
- `https://truenote.org/.well-known/security.txt` is backed by
  `artifacts/rag-app/public/.well-known/security.txt` using RFC 9116 fields.
- The login surface links to the security overview, and the overview links
  directly to `/security/report/`.
- The sitemap lists both `/security/` and `/security/report/`.

The primary reporting action opens GitHub private vulnerability reporting for
`ryanportfolio/kbase`. If that facility is unavailable, the page tells the
reporter to request a private channel from the repository owner without
disclosing vulnerability details.

## Safety and claim boundaries

The page requires synthetic data and tells reporters not to submit customer
content, personal data, PAN, credentials, session tokens, API keys, or private
database output. It prohibits accessing data that is not theirs, degrading a
shared service, or testing third-party providers without authorization.

The page does not claim PCI DSS or FedRAMP compliance, certification, independent
assessment, deployed security, or a response/remediation SLA. Repository source
and local tests remain distinct from deployment and operation.

## Machine checks

`scripts/src/public-security-page.test.ts` contains four portable tests that
verify:

1. canonical reporting URL, login-to-overview-to-report discovery, both sitemap
   entries, the exact private GitHub reporting path, and absence of an invented
   `mailto:` or SLA;
2. sensitive-data, safe-testing, and assurance-boundary text;
3. skip-link/main/heading structure, external CSS, noreferrer links, focus
   styling, responsive styling, and no inline script/style; and
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
4. fetches `/security/`, `/security/styles.css`, `/security/report/`,
   `/security/report/styles.css`, and `/.well-known/security.txt` from the public
   origin and retains status, content-type, body hash, date, and reviewed release
   identity;
5. submits a harmless synthetic private test report, records acknowledgement and
   routing without sensitive content, then closes it through the approved
   workflow; and
6. assigns review ownership for the page, repository policy, intake queue, and
   `security.txt` expiry.

Until those steps pass, the evidence grade is **Implemented, unverified**.
