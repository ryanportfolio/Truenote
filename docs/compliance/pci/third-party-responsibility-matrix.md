# Third-party responsibility matrix

**Status:** Draft; vendor-risk and PCI/QSA review required

Repository configuration proves how Truenote calls a provider; it does not prove
the provider's contract, account configuration, retention behavior, PCI status, or
fitness for an in-scope CDE path.

Production hosting moved from Replit to Railway on October 7, 2026. The Railway stack has run
with a copy of the Replit production data since 2026-10-07. On 2026-10-07 the
`truenote.org` and `www.truenote.org` A records resolved to Railway's addresses.
Replit stays deployed only as the DNS rollback target, and its bucket still holds
the old demo uploads, until the owner retires it.

| Service | Truenote use/data | Truenote responsibility | Required provider/external evidence | Current grade |
|---|---|---|---|---|
| OpenRouter and routed model providers | Answer generation, follow-up rewrite, session naming; question/excerpts/history as applicable | Pin approved provider route; request ZDR; deny data collection/fallback; assign/test PII and prompt-injection guardrail | Production guardrail assignment/export, synthetic redaction receipt, ZDR endpoint evidence, DPA/subprocessor review, account privacy settings | Configuration required / Third-party evidence required |
| OpenAI | Question and document embeddings; opt-in eval judge | Prevent prohibited data, configure retention/privacy, bound calls, inventory model/version | Organization retention settings, DPA/subprocessor and PCI/CDE suitability decision, synthetic boundary test | Third-party evidence required |
| Cohere | Question plus candidate excerpts for reranking | Enforce program/classification before rerank; prevent prohibited data; bound calls | Retention/privacy contract and PCI/CDE suitability decision | Third-party evidence required |
| LandingAI | Raw PDF/image bytes for parsing | Validate/scan files, classify permitted sources, enforce account ZDR, quarantine findings | Team/Enterprise ZDR export, DPA/subprocessor review, PCI/CDE suitability decision, deletion/retention evidence | Configuration required / Third-party evidence required |
| Malware scanner | Raw uploaded bytes | Default-on fail-closed enforcement, authenticated transport, retained scan receipt | Approved vendor/service, contract, data handling/retention, availability and test evidence | Configuration required |
| Railway | Application hosting (`web` and `worker` services), service variables, object storage bucket, deployment | Harden configuration, verify deployed state, control operators. Current gap: one `production` environment only, with no separate non-production environment | Service responsibility/assurance documents, CDE eligibility decision, configuration export | Third-party evidence required |
| Replit (temporary, until retired) | `truenote.org` DNS rollback target (the former production deployment stays deployed) and the bucket holding the 8 old demo upload objects that were not copied to Railway | Keep it unchanged until retirement, restrict and review access, retire the deployment and delete or migrate the old uploads | Retirement and data-deletion record; access review until then | Third-party evidence required |
| Railway PostgreSQL (`pgvector` service, Postgres 18 on a Railway volume) | Application and audit data | Access control, schema/object verification, encryption/configuration, backup/restore | Railway volume/platform responsibility evidence (encryption at rest pending verification for Railway), backup/restore (none configured as of 2026-10-07) and CDE decision | Third-party evidence required |
| GitHub | Source, PRs, CI, artifacts, vulnerability reports | Protect branch, least privilege, required checks/reviews, secrets and artifact retention | Settings export/API evidence, access review, organization/repository assurance | Configuration required |
| Identity provider | OIDC/MFA | Validate issuer/audience/claims; restrict domains; manage break glass and access reviews | Production configuration, MFA/ACR evidence, access-review and recovery records | Configuration required |
| SIEM receiver | Security event metadata | Signed delivery, retry/dead-letter response, alert ownership and testing | Receiver contract/configuration, delivery receipts, alert tests, retention and response runbook | Configuration required |
| Email provider | Invite/reset delivery | Prevent account enumeration, use approved sender/base URL, protect tokens | Production configuration, domain/provider evidence, delivery and retention settings | Configuration required |

## Acceptance test

The PCI owner/QSA approves applicability and responsibility for every in-scope
service; current contracts/attestations and production configuration evidence are
retained; synthetic tests prove the expected boundary; gaps have owners and dates.
