# Truenote

Internal retrieval-augmented lookup tool for call-center CSRs. Admins upload SOPs, policies, and screenshots; CSRs query during calls and get cited, verifiable answers — or an explicit refusal. Every answer points to a source the CSR can click. Refusal over hallucination, always.

**Stack:** React + Vite + Tailwind on the front end; Postgres with `pgvector` + `pg_trgm` for hybrid retrieval. Deployed on Replit.

- [PRODUCT.md](./PRODUCT.md) — product brief, users, principles, anti-references
- [DESIGN.md](./DESIGN.md) — visual tokens (palette, type, spacing, motion)
- [CLAUDE.md](./CLAUDE.md) — engineering kernel for AI-assisted work in this repo
