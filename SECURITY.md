# Security policy

Truenote handles policy documents, customer-service questions, identity data, and model-provider traffic. Please report suspected vulnerabilities privately so maintainers can investigate before technical details become public.

## Reporting a vulnerability

Use the repository's **Security** tab and choose **Report a vulnerability**. Include:

- the affected route, component, or commit;
- the security boundary you expected;
- a minimal reproduction using synthetic data;
- the likely impact;
- any temporary mitigation you found.

Do not include real customer content, credentials, session tokens, API keys, private database output, or personal data. Do not open a public issue with exploit details. If GitHub private vulnerability reporting is unavailable, contact the repository owner through GitHub without disclosing the vulnerability details and ask for a private channel.

Maintainers will acknowledge the report, confirm whether it can be reproduced, and coordinate disclosure after affected users have a reasonable chance to update. A fix date depends on severity, reproduction, and deployment ownership.

## Supported versions

Truenote does not publish versioned releases yet.

| Version | Supported |
|---|---|
| Current `main` branch | Yes |
| Earlier commits and unmerged branches | No |

## High-priority boundaries

Reports are especially useful when they show that Truenote can:

- return a representative-facing answer without a valid retrieved citation;
- retrieve or expose content from another program or above the user's classification;
- accept client-supplied scope, role, or clearance as authoritative;
- activate content without required scanning and role-authorized activation or review;
- disclose secrets, payment-card data, SSNs, prompts, or unredacted provider errors;
- bypass OIDC validation, session controls, CSRF defenses, rate limits, retention gates, or audit recording;
- lose, duplicate, or falsely mark SIEM delivery during retries and worker races.

Use synthetic programs, documents, users, and credentials for proof of concept work. Do not access data that is not yours, degrade a shared service, or test third-party providers without their permission.

## Security claim boundary

Security controls in this repository still depend on database DDL, deployment configuration, provider settings, operating procedures, and retained evidence. Source code and passing CI do not prove that a deployment is secure or compliant.

Truenote is not represented as FedRAMP compliant, FedRAMP-ready, or independently assessed. See [`docs/security/README.md`](./docs/security/README.md) for the evidence model and current documentation.
