# Truenote

**A retrieval-augmented knowledge assistant for call-center customer service reps.** Admins upload the source of truth — SOPs, policy PDFs, screenshots, tables. CSRs ask questions mid-call and get answers in seconds, with every claim backed by a clickable citation. When the knowledge base can't support an answer, Truenote says so plainly instead of guessing.

The product is trust and speed, not chat features. Three rules define it:

1. **Every answer ships with a citation, or it's an explicit refusal.** No naked answers, ever.
2. **Refusal over hallucination.** "I couldn't find this in the knowledge base" is a successful response. Truenote never invents fees, dates, policy numbers, or procedures.
3. **Program scoping is a security boundary.** A CSR on Program A can never retrieve content from Program B — enforced server-side on every query, not in the UI.

## Features

### For CSRs (mid-call lookup)

- **Ask, read, cite** — answers render as clean Markdown with inline citation chips. Clicking a chip opens the full source excerpt in a side panel; hovering shows a quick peek. A receipt strip under each answer summarizes what it's grounded in.
- **Follow-up questions** — "what about the premium plan?" works. A lightweight rewrite step resolves the reference into a standalone question before retrieval, and conversation history is used *only* for that — generation still sees nothing but retrieved excerpts, so a previous answer can never leak into a new one.
- **Honest refusals** — a distinct "Not in knowledge base" state, visually calm, never dressed up as an error. One click flags the gap for admins.
- **Keyboard-first** — `Enter` asks, `Shift+Enter` breaks a line, `/` focuses the ask box from anywhere. The composer stays pinned as the transcript grows. Built for one-handed lookups under call pressure.
- **Feedback** — thumbs up/down on every answer feeds the content-gap loop.

### For admins (curation)

- **Upload anything** — PDF, DOCX, PNG/JPG/WebP, Markdown, TXT. Drag-and-drop or file picker; a blank title auto-fills from the filename.
- **Parse preview** — the parsed Markdown renders with chunk boundaries highlighted before a document goes live. Most knowledge-base quality bugs are bad parses caught too late; this catches them early.
- **Document versioning** — re-uploading creates a new version and deactivates (never deletes) the old one. Audit and rollback stay possible.
- **Content gaps** — refused questions and flagged answers aggregate into a review queue with 7/30/90-day windows. "Fill this gap" jumps straight to the upload form with the question prefilled as the title.
- **Programs and users** — program-scoped content, role-based access (CSR → manager → super user), session auth with password reset and rate limiting.
- **Pipeline telemetry** — managers and above see confidence, rerank scores, latency, and the rewritten query under each answer.

## How retrieval works

Truenote uses hybrid retrieval — the single biggest quality decision in the system:

```
question
  → follow-up rewrite (only when history is present)
  → embed (text-embedding-3-small)
  → parallel: vector search (pgvector HNSW) + BM25 keyword search
      BM25 zero-hit → trigram fallback (catches typos and exact codes)
  → merge, dedupe → Cohere rerank → top 8
  → confidence gate: top score below threshold → refuse (no LLM call)
  → neighbor expansion (adjacent chunks of top anchors, for procedures
    that span a chunk boundary)
  → GPT-4o with a strict citation contract (structured JSON output)
  → answer + citation chips, logged for analytics
```

Pure vector search misses exact-match queries CSRs actually ask ("cancellation fee for plan X"); pure keyword search misses paraphrases. Truenote always combines both, then reranks. The confidence gate refuses *before* generation, which both prevents hallucination and saves the LLM call.

### Ingestion

Runs once per document version, never at query time:

1. Upload → object storage, SHA-256 dedupe (accidental re-uploads skip OCR entirely)
2. Parse via Mistral OCR (PDFs, images, scans, and tables handled uniformly)
3. Semantic chunking (~500 tokens; never splits a table or a list), with a contextual header — `[Doc Title > Heading > Subheading]` — prepended to each chunk so both the embedding and the keyword index carry provenance
4. Images get 1–3 sentence GPT-4o vision descriptions, stored as their own searchable chunks
5. Embed, index, activate

## Eval harness

Retrieval quality is proven, not vibed. The eval suite runs the full pipeline against a curated question set and reports:

- Answer accuracy and citation accuracy
- Refusal rates split by in-KB (should be low) vs. out-of-KB (should be high) questions
- **Stage-level failure attribution** — each in-KB failure is pinned to retrieval, rerank, threshold, or generation, so you know which stage to tune
- **Claim-level faithfulness** (opt-in `--judge`) — an LLM judge decomposes each answer into atomic claims and verifies every one against the excerpts the model saw. Catches the answer that passes phrase-matching but invents one fee.
- p50/p95 latency

```bash
pnpm --filter @workspace/scripts run eval                      # full suite
pnpm --filter @workspace/scripts run eval -- --limit 5         # smoke test
pnpm --filter @workspace/scripts run eval -- --judge           # faithfulness judge
pnpm --filter @workspace/scripts run eval -- --threshold 0.25  # parameter sweep
```

Every change touching ingestion, retrieval, or generation runs the suite. Exit code is CI-friendly.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite + Tailwind CSS (wouter routing) |
| API | Express + TypeScript |
| Database | Postgres (Neon) with `pgvector` (HNSW) + `pg_trgm`, via Drizzle |
| Parsing | Mistral OCR |
| Embeddings | OpenAI `text-embedding-3-small` |
| Reranking | Cohere Rerank |
| Generation | NVIDIA Nemotron 3 Ultra via OpenRouter, with OpenAI GPT-5.6 Luna low-reasoning fallback |
| Hosting | Replit (object storage, secrets, deploys) |

## Repository layout

```
artifacts/
  rag-app/        # React SPA (CSR chat + admin surfaces)
  api-server/     # Express API (auth, ask pipeline, ingestion, admin)
lib/
  db/             # Drizzle schema + client, shared across packages
scripts/          # eval harness, seeding, re-ingestion, maintenance
PRODUCT.md        # product brief: users, principles, anti-references
DESIGN.md         # design system: tokens, components, motion, a11y
CLAUDE.md         # engineering guardrails for AI-assisted work
```

## Getting started

Requires Node 20+, [pnpm](https://pnpm.io) via corepack, and a Postgres database with the `vector` and `pg_trgm` extensions.

```bash
corepack pnpm install
cp .env.example .env      # fill in DATABASE_URL + API keys (see file comments)
pnpm -r run check         # type-check all packages
pnpm -r run test          # unit tests
pnpm dev                  # frontend + API (see .env.example for ports)
```

You'll need API keys for OpenRouter (primary answers), OpenAI (embeddings, vision, utility calls, and backup answers), Mistral (OCR), and Cohere (reranking). `.env.example` documents every variable, including the Replit-specific port arrangement.

## Design

The interface follows a written design system ([DESIGN.md](./DESIGN.md)): calm, precise, cited. CSR surfaces are dense and scannable; admin surfaces are airy and deliberate. Body text targets WCAG 2.1 AAA contrast — eyestrain compounds across an 8-hour shift — and the entire ask → read → cite → return flow works from the keyboard.

## Documentation

- [PRODUCT.md](./PRODUCT.md) — who it's for, brand personality, design principles
- [DESIGN.md](./DESIGN.md) — visual tokens, component recipes, accessibility rules
- [CLAUDE.md](./CLAUDE.md) — engineering kernel: verification gates, product non-negotiables
