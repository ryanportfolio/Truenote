# LandingAI ADE (Agentic Document Extraction)

> Researched 2026-07-13 for replacing Mistral OCR + the gpt-4o image captioner with a
> single ZDR-capable document parser. Source of truth: https://docs.landing.ai/llms.txt

## Why we care

One LandingAI **Parse** call returns markdown with **figures described inline**, so it
replaces BOTH the Mistral OCR step AND the separate gpt-4o image-captioning step, and it
can be run under Zero Data Retention. That closes two of Truenote's ZDR gaps with one
component.

## The critical ZDR reality (read first)

ZDR here is **NOT a per-request flag** like OpenRouter. It is:
- An **organization-wide toggle** in the ADE dashboard (Org Settings), and
- **Plan-gated**: US (Ohio) needs **Team or Enterprise**; EU (Ireland) is custom-plan only.
  **Explore / pay-as-you-go does NOT get ZDR.**

So the API key alone does not guarantee ZDR. To be ZDR-compliant: (1) account must be on
**Team plan minimum**, (2) ZDR toggled ON in Org Settings, (3) verified. The request body
sends no ZDR parameter — it is enforced at the account level. **The code change (swap
Mistral → LandingAI) is orthogonal to ZDR enablement; both are needed for the goal but the
build does not depend on the toggle.** When ZDR is on: in-memory only, never stored at
rest, discarded after processing, no training. Certs: GDPR, SOC 2 Type II, HIPAA (HIPAA
also needs a signed BAA). To disable ZDR later, contact support.

Unresolved doc conflict: the ZDR page says "+1 credit per page"; the credit-consumption
page says ZDR "does not consume any additional credits." Confirm with LandingAI billing.

## Two API generations — pick deliberately

| | Parse v2 / DPT-3 (**use this**) | ADE v1 / DPT-2 |
|---|---|---|
| Endpoint | `POST https://api.ade.landing.ai/v2/parse` (direct HTTP) | `landingai-ade` npm SDK |
| Model | `dpt-3-pro-latest` (newest, best) | `dpt-2-latest` |
| Operations | Parse + Extract only | Parse, Extract, Classify, Split, Section |
| SDK? | **No SDK — direct HTTP only** | TS + Python SDK |
| Output | `markdown` + `structure` tree + `grounding` tree | v1 chunk format (incompatible with v2) |
| custom figure prompt | unconfirmed for DPT-3 (docs say custom_prompts is DPT-2 only) | yes (`custom_prompts={"figure":"…"}`, ≤512 chars) |

Decision: use **Parse v2 direct HTTP** for the OCR replacement — best model, figures-as-text,
grounding, and no npm dependency (Node 22 global `fetch` + `FormData`/`Blob`). Use the ADE v1
SDK only if we later want Section/Split/Classify; v1 and v2 response shapes are not interchangeable.

## Auth

`Authorization: Bearer <key>`. Read from `VISION_AGENT_API_KEY` (the vendor-canonical name and
the TS SDK default; Replit secret renamed from `LANDINGAI_API` to this on 2026-07-13). For
direct HTTP the env-var name is arbitrary; we standardize on `VISION_AGENT_API_KEY`.

## Parse v2 request

```
POST https://api.ade.landing.ai/v2/parse
Authorization: Bearer $VISION_AGENT_API_KEY
Content-Type: multipart/form-data
  document = <file bytes>            # PDF or image
  model    = dpt-3-pro-latest
  options  = {"pages":[...]}         # optional JSON; defaults suit most docs
```

Sync limits: **50 MiB, 100 pages/PDF** (Truenote's 20 MB cap fits; a >100-page PDF needs async
**Parse Jobs** — submit + poll, which suits the pg-boss worker). Async jobs: 1 GiB / 6,000 pages,
paced against an hourly page budget. 429 → exponential backoff. Rate limits are per-plan, org-level.

File types: PDF, JPEG/JPG/PNG, GIF/BMP/TIFF/TIF/WEBP. Covers Truenote's PDF/PNG/JPEG/WebP.
**DOCX is NOT supported → keep Mammoth local; Markdown/plain-text stay passthrough.** PDFs are
parsed one page at a time; an image counts as one page. Password-protected files are rejected.

## Parse v2 response (the part we consume)

```json
{
  "markdown":  "reading-order CommonMark string",   // RAG-ready; this is what we chunk
  "metadata":  { "job_id", "model_version", "page_count", "markdown_chars",
                 "failed_pages": [], "duration_ms", "billing": { "total_credits" } },
  "structure": { "type":"document", "children":[ /* pages → blocks, type+id+span */ ] },
  "grounding": { /* mirrors structure + box [left,top,right,bottom] px + line-level parts */ }
}
```

- **Markdown**: page breaks as `<!-- PAGE BREAK -->`; tables as HTML (merged cells) or pipe via
  option; math as LaTeX (`$…$` / `$$…$$`).
- **Figures/images described inline** (this replaces the captioner):
  `<figure type="CHART|FLOWCHART|DIAGRAM|ILLUSTRATION|PHOTOGRAPH">` with transcribed text +
  a `<description>` block. Figures are text, never returned as image data.
- Block types: text, table, table_cell, figure, marginalia, attestation, logo, card, scan_code.
- **Grounding** gives every block a pixel bounding box + `span` (unicode offsets into markdown)
  + line-level `parts` — enables mapping a chunk back to exact page coordinates.

## The five operations

- **Parse** (required first step) — document → markdown + structure + grounding.
- **Extract** — parsed markdown + a JSON schema → structured field values grounded to locations.
  Unlimited fields, `x-alternativeNames` for fuzzy matching, multi-page tables returned as one array.
- **Classify** — label pages by document type (standalone, no parse needed).
- **Section** — parsed markdown → hierarchical TOC (`table_of_contents` JSON + `table_of_contents_md`)
  with titles, levels, chunk refs. Enables section-aware chunking instead of sliding-window.
- **Split** — split a multi-document file into typed sub-documents.

## Pricing / credits (minor for our ingest-only volume)

- Explore: free 1,000 credits, then US $1 = 100 credits. Single user. **No ZDR.**
- Team: from **$250/mo** (US), $1 = 110 credits. Unlimited users. **ZDR + HIPAA included.**
- Enterprise: custom. ZDR, HIPAA, VPC/on-prem, SSO, SLA.
- Parse v2 cost: **1 credit/page + 0.5 credit/1,000 output chars** (~$0.01–0.015/page at Team
  rates). Standard tier = half the base per-page of priority. Ingest-only, so cost is small.

## Mapping to Truenote's ingestion pipeline

Current (`artifacts/api-server/src/lib/ingestion/run.ts`): validate → sha256 → store →
**Mistral OCR (PDF/images) → markdown + base64 images** → chunk (~500 tok, tables/lists atomic,
heading context) → **gpt-4o vision caption each image → image chunks** → embed → store.

With Parse v2: **one call → markdown with figures already described inline** → chunk → embed.
The separate image-extract + caption stage (`lib/ingestion/image-describer.ts`, the
`MAX_IMAGES_DESCRIBED_PER_VERSION` cap, and the per-image loop in `run.ts`) becomes obsolete for
this path — Mistral no longer returns the base64 images the captioner consumed. DOCX stays on
Mammoth; MD/txt stay passthrough. Keep the existing chunker; figures-as-text flow in as normal text.

## Extra opportunities (beyond the OCR swap)

1. **Grounding → citation receipts.** Bounding boxes could let a citation jump to and highlight the
   exact region in the source PDF. Dead-on for Truenote's "answers with receipts."
2. **Section → heading-aware chunking.** Replaces the "document + heading context" heuristic with a
   real hierarchical TOC → better chunk boundaries. Retrieval-quality upgrade.
3. **Extract → structured metadata.** Effective dates, policy numbers, plan names from SOPs via schema.
4. **Classify / Split → messy uploads.** Split a bundle PDF into sub-documents; classify page types.

These are follow-ons, not the first PR.

## Open items to resolve before/while implementing

- Confirm the account plan is **Team/Enterprise (US Ohio)** with **ZDR ON** in Org Settings.
- Confirm whether **DPT-3/Parse v2 supports `custom_prompts.figure`** (docs say DPT-2 only). If not,
  figure descriptions use defaults — decide if acceptable, or reuse the existing caption instruction
  another way / consider ADE v1 DPT-2 for custom figure prompts.
- Resolve the **ZDR credit-cost doc conflict** (billing question, not code).
- **Sync vs async**: >100-page PDFs need async Parse Jobs; the worker is async-friendly.
- Wrap the call with the existing `getDeadlineConfig()` timeout/retry pattern; 429 backoff.

## Source pages

- Overview: https://docs.landing.ai/ade/ade-overview.md , https://docs.landing.ai/dpt3/overview.md
- Parse: https://docs.landing.ai/dpt3/parse.md , response https://docs.landing.ai/dpt3/parse-response.md
- ZDR / security: https://docs.landing.ai/ade/zdr.md , https://docs.landing.ai/dpt3/ade-security.md
- Auth: https://docs.landing.ai/dpt3/agentic-api-key.md
- File types / limits: https://docs.landing.ai/dpt3/file-types.md , https://docs.landing.ai/dpt3/rate-limits.md
- Pricing / credits: https://docs.landing.ai/ade/ade-pricing.md , https://docs.landing.ai/dpt3/credit-consumption.md
- TS SDK: https://docs.landing.ai/ade/ade-typescript.md
- Extra ops: https://docs.landing.ai/ade/ade-section.md , ade-extract.md , ade-classify.md , ade-split.md
- Custom figure prompts: https://docs.landing.ai/ade/ade-parse-custom-prompts.md
- API reference (Parse): https://docs.landing.ai/api-reference/parse/ade-parse.md ; OpenAPI: https://docs.landing.ai/dpt3/openapi-adev2.json
