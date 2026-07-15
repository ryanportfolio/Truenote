# Contributing to Truenote

Truenote optimizes for answers a customer service representative can verify under call pressure. A change is useful only if it preserves grounding, scope, and an honest refusal path.

## Before you change code

Read:

- [`PRODUCT.md`](./PRODUCT.md) for users and product boundaries;
- [`DESIGN.md`](./DESIGN.md) for frontend behavior and accessibility;
- [`CLAUDE.md`](./CLAUDE.md) for engineering and verification rules;
- [`docs/security/README.md`](./docs/security/README.md) for security claim limits.

Keep these invariants intact:

1. Every representative-facing answer has at least one clickable retrieved citation or is an explicit refusal.
2. Retrieval combines semantic and keyword evidence. Do not replace it with vector-only search.
3. Program and classification scope are resolved and enforced on the server before data leaves PostgreSQL.
4. Low-confidence or ungrounded output is refused. Do not recover a prettier answer by weakening validation.
5. Changes to ingestion, retrieval, reranking, generation, or citations require evaluation against representative questions.

## Local setup

Use Node.js 22 or newer and the pinned pnpm version:

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

On PowerShell, use `Copy-Item .env.example .env`. The root README explains the database and port setup.

Run the API and web app separately:

```bash
pnpm dev:api
pnpm dev:web
```

Run `pnpm worker` when your change needs ingestion or background evaluation jobs.

## Verification

Every pull request should run:

```bash
pnpm check
pnpm test
```

Also run the narrowest relevant check:

- ingestion, retrieval, reranking, generation, citations: eval suite;
- authentication, authorization, ingestion lifecycle, retention, or audit: negative security tests;
- provider, scanner, OIDC, SIEM, storage, or email changes: deployed integration test with synthetic data;
- frontend changes: keyboard, focus, loading, empty, refusal, error, and responsive states.

If a required runtime check cannot run locally, state that in the pull request. Name the environment, command, expected result, and owner needed to finish it.

## Security-sensitive changes

- Add a negative test for every new permission or data boundary.
- Treat excerpts and uploaded documents as untrusted data.
- Never log credentials, raw sensitive matches, prompts, excerpts, session tokens, or provider response bodies without redaction.
- Keep external calls bounded by timeouts and retry caps.
- Fail closed when a required scanner, scope, signature, or validation result is missing.
- Use reviewed raw SQL for database changes. Do not run `drizzle-kit push` or generate migrations from the TypeScript bindings.
- Keep unresolved configuration and operational evidence visible in documentation. Code is not proof of deployed operation.

Report vulnerabilities through [`SECURITY.md`](./SECURITY.md), not a public issue.

## Pull requests

Keep a pull request focused. In its description, include:

- the user or operator problem;
- the behavior before and after;
- files and boundaries affected;
- exact verification commands and results;
- deployment, DDL, configuration, or evidence work still required.

Do not commit `.env` files, credentials, database exports, customer content, generated logs, or copied production errors.
