# Third-party responsibility matrix

**Status:** Draft; vendor-risk and PCI/QSA review required

Repository configuration proves how Truenote calls a provider; it does not prove
the provider's contract, account configuration, retention behavior, PCI status, or
fitness for an in-scope CDE path.

| Service | Truenote use/data | Truenote responsibility | Required provider/external evidence | Current grade |
|---|---|---|---|---|
| OpenRouter and routed model providers | Answer generation, follow-up rewrite, session naming; question/excerpts/history as applicable | Pin approved provider route; request ZDR; deny data collection/fallback; assign/test PII and prompt-injection guardrail | Production guardrail assignment/export, synthetic redaction receipt, ZDR endpoint evidence, DPA/subprocessor review, account privacy settings | Configuration required / Third-party evidence required |
| OpenAI | Question and document embeddings; opt-in eval judge | Prevent prohibited data, configure retention/privacy, bound calls, inventory model/version | Organization retention settings, DPA/subprocessor and PCI/CDE suitability decision, synthetic boundary test | Third-party evidence required |
| Cohere | Question plus candidate excerpts for reranking | Enforce program/classification before rerank; prevent prohibited data; bound calls | Retention/privacy contract and PCI/CDE suitability decision | Third-party evidence required |
| LandingAI | Raw PDF/image bytes for parsing | Validate/scan files, classify permitted sources, enforce account ZDR, quarantine findings | Team/Enterprise ZDR export, DPA/subprocessor review, PCI/CDE suitability decision, deletion/retention evidence | Configuration required / Third-party evidence required |
| Malware scanner | Raw uploaded bytes | Default-on fail-closed enforcement, authenticated transport, retained scan receipt | Approved vendor/service, contract, data handling/retention, availability and test evidence | Configuration required |
| Replit | Application hosting, secrets, object storage, deployment | Harden configuration, separate environments, verify deployed state, control operators | Service responsibility/assurance documents, CDE eligibility decision, configuration export | Third-party evidence required |
| Neon/PostgreSQL | Application and audit data | Access control, schema/object verification, encryption/configuration, backup/restore | Replit/Neon responsibility evidence, backup/restore and CDE decision | Third-party evidence required |
| GitHub | Source, PRs, CI, artifacts, vulnerability reports | Protect branch, least privilege, required checks/reviews, secrets and artifact retention | Settings export/API evidence, access review, organization/repository assurance | Configuration required |
| Identity provider | OIDC/MFA | Validate issuer/audience/claims; restrict domains; manage break glass and access reviews | Production configuration, MFA/ACR evidence, access-review and recovery records | Configuration required |
| SIEM receiver | Security event metadata | Signed delivery, retry/dead-letter response, alert ownership and testing | Receiver contract/configuration, delivery receipts, alert tests, retention and response runbook | Configuration required |
| Email provider | Invite/reset delivery | Prevent account enumeration, use approved sender/base URL, protect tokens | Production configuration, domain/provider evidence, delivery and retention settings | Configuration required |

## Acceptance test

The PCI owner/QSA approves applicability and responsibility for every in-scope
service; current contracts/attestations and production configuration evidence are
retained; synthetic tests prove the expected boundary; gaps have owners and dates.
