# Retrieval & Generation

> CSR asks a question → system returns an answer with citations OR an explicit refusal. This is the product.

## Query pipeline

```
question
  → follow-up rewrite (only when the client sent conversation history:
    Granite 4.1 8B via the OpenRouter ZDR utility resolves "that plan"/"the
    fee" into a standalone question; failure falls back to the raw question;
    first turn = passthrough)
  → embed (text-embedding-3-small)
  → parallel: vector search (top 40) + BM25 search (top 40)
       BM25 zero-hit → pg_trgm word_similarity fallback (typos, SKU codes)
  → merge + dedupe by chunk_id
  → Cohere rerank → top 8
  → confidence gate (top score >= RERANK_CONFIDENCE_THRESHOLD?)
       no  → refuse, return "not in knowledge base"
       yes → neighbor expansion (ordinal ±1 of top RETRIEVAL_NEIGHBOR_ANCHORS
             anchors, same active version; unscored context, never gated)
           → OpenRouter approved route chain ordered by a super user
             with route-specific reasoning, citation contract, and ZDR
             (request/citation failure → next route; exhausted chain → refuse)
  → render answer + citation chips
  → log to query_log
```

**Every query is scoped by `program_id` server-side.** The filter is applied to both vector and BM25 queries. Do not rely on UI scoping.

## Retrieval rules

- **Hybrid is non-negotiable.** Pure vector misses exact-match queries CSRs actually ask ("cancellation fee for plan X"). Pure BM25 misses paraphrases ("how do I refund a customer?" vs SOP titled "issuing returns"). Always combine.
- **Use HNSW, not IVFFlat,** for the pgvector index. HNSW recall is meaningfully better on small KBs (which yours will be for months).
- **Reranker over top 40 candidates, not top 8.** Cheap; big quality lift. Skipping this is the most common cause of "RAG demo feels dumb."
- **Confidence gate is non-negotiable.** If the reranker's top score is below `RERANK_CONFIDENCE_THRESHOLD` (default 0.3, tunable), refuse without calling the LLM. Saves cost AND prevents hallucination on questions the KB can't answer.
- **Rerank model is env-configurable** (`COHERE_RERANK_MODEL`, default `rerank-english-v3.0`). Upgrading (e.g. `rerank-v3.5`) is eval-gated: flip the secret, run the eval suite, and RETUNE the threshold — score distributions differ across rerank model versions, so the old threshold is invalid the moment the model changes. The eval's `threshold` failure-stage count is the retune signal.
- **Trigram fallback (2026-07):** when `websearch_to_tsquery` matches zero rows, `word_similarity(question, content) > 0.3` supplies BM25-leg candidates instead — catches typos ("cancelation") and exact codes tsvector stems away. Plain function call, no trgm index yet; if the KB passes ~100k chunks, add a `gin (content gin_trgm_ops)` index via DDL and switch to the `<%` operator form.
- **Neighbor expansion (2026-07):** after the gate passes, ordinal ±1 siblings (same active document version) of the top `RETRIEVAL_NEIGHBOR_ANCHORS` (default 3) reranked chunks are appended as context — procedures routinely span a chunk boundary. Neighbors carry `relevanceScore: 0` and `neighbor: true`, never affect the gate, and are citable (they're real chunks). Set the env to 0 to disable.
- **Eval trace:** `retrieve({ withTrace: true })` returns pre-rerank candidates + post-rerank top-K (chunk id → doc id) so the eval harness attributes failures to a stage. `/api/ask` doesn't request it.
- **Multi-turn (2026-07):** the Chat client sends its last 3 completed exchanges; `lib/generation/rewrite.ts` (Granite 4.1 8B via the OpenRouter ZDR utility, `lib/generation/utility-model.ts`) rewrites a follow-up into a standalone question used for retrieval AND generation. HARD boundary: conversation history is used ONLY for reference resolution — answer generation still sees excerpts + standalone question, so an ungrounded fact from a previous answer can never leak into a new one. `query_log.question` stores what the CSR typed; the rewrite is returned as `rewrittenQuestion` (manager+ debug footer shows "Searched as: …"). Rewrite failure falls back to the raw question. "New conversation" button clears history between calls.

## Generation contract (the part most demos botch)

The LLM ONLY sees retrieved excerpts + the question. Use this exact system prompt:

```
You are a customer service knowledge assistant for {program_name}.

RULES (non-negotiable):
1. ONLY use the EXCERPTS below. Do not use outside knowledge.
2. If the answer is not fully supported by the excerpts, return exactly:
   "I couldn't find this in the knowledge base. Please escalate
   or check the source documents directly."
3. Never invent fees, dates, names, policy numbers, or procedures.
4. Cite every factual claim by copying its short SOURCE token exactly.
   Use forms like [S1] or [S2]; never copy or invent a UUID.
5. Prefer the most recent document version when excerpts conflict.
6. Format the answer as GitHub-flavored Markdown. Use numbered steps for
   procedures, bullet lists for options, and **bold** for key values
   (fees, dates, deadlines). Use a table only to compare options. Never
   use headings, code blocks, images, links, or task lists.
7. Return only the final Markdown answer or the exact refusal text.
   Never return JSON, metadata, analysis, or a separate sources list.

EXCERPTS:
{retrieved_chunks_with_ids}

QUESTION: {question}
```

The model emits plain text and short source tokens only inline. Excerpts are numbered `SOURCE [S1]`, `SOURCE [S2]`, and so on; the server maps those aliases to retrieved chunk UUIDs and rewrites the answer to canonical `[uuid]` citations. Legacy direct UUIDs plus harmless `[chunk_id:uuid]` and `【uuid】` variants remain accepted when exact. Missing, out-of-range, or genuinely unknown IDs are rejected. There is no fuzzy UUID correction, model-authored JSON, or sources array.

After the citation checks pass, `validateGeneratedAnswer` runs a per-claim figure grounding gate (`generation/figure-grounding.ts`). It checks the answer as the CSR sees it, in four steps.

- **Visible citations.** Citations are read the way the answer view rewrites them (`annotateCitations` in `artifacts/rag-app/src/lib/citation-rendering.ts`): its bracket pattern runs over the whole answer before Markdown parsing, so `[note [S1]` and `[[S1]](url)` are one unknown token each and give no clickable chip. A citation counts only where react-markdown renders the chip: not inside a code span, fenced or indented code, raw HTML or an HTML block (both shown as literal text), an HTML comment, an autolink (`<https://...>`), a GFM autolink literal (`https://x.com/[S1]` swallows the chip's `[1`), the destination of a link with empty text (`[]([S1])`), after a backslash (`\[S1]`) or after `!` (`![S1]` renders an image). Autolink literals and `[](` may or may not form a link, and either way changes how later backticks pair, so the gate reads every combination of up to four such spans in a block and counts a citation only if it is visible in all of them; with more than four, no citation in that block counts. A table cell past the header row's column count is not rendered, so its figures need no grounding and its citations do not count.
- **Structure.** Blocks follow CommonMark and GFM rules as micromark applies them in the answer view (react-markdown with remark-gfm): blockquote and list-item containers are matched line by line, blank lines end paragraphs, and an ordered-list marker starts a list item only when it is not interrupting a paragraph or indented code, or when it is exactly `1.`/`1)` with text after it. Otherwise the line continues the paragraph and its number is a figure (`grace period is\n15. days`). Fenced and indented code, HTML blocks (including comments that run past blank lines) and GFM table rows are never read as list markers. A table ends when its blockquote or list item ends; tables take no lazy continuation lines, so `> | a | b |\n> |---|---|\n> | x | y |\nThe fee is $40.` ends with an ordinary paragraph. Where the gate's model of the renderer could be wrong, it reads the line as text, and citations on the lines after a lone HTML tag inside a paragraph do not count.
- **Displayed text.** Each block's content is NFKC-normalized, format, control and combining characters are removed (zero-width space, soft hyphen, word joiner, bidi marks), and every space variant becomes a space. Before NFKC, a space goes between a decimal digit and a vulgar fraction, superscript or other `\p{No}` numeral, so `4½` (NFKC `41⁄2`) reads as `4 1⁄2` and `10²` as `10` and `2`. The content is then read twice, and a figure must be grounded in both readings: once with escapes and character references decoded and inline markup (`*`, `_`, `~`, backticks) removed, so `$9*5*`, `$9&#53;` and `$9` + U+200B + `5` all read as `$95`; once raw with markup as a separator, because code spans and HTML show references and backticks literally. Excerpts get the same two readings. Digit groups split by one space (`$5 009` with U+202F) read as one number. A numeric character NFKC cannot map to ASCII digits (`٩`, `❾`, `Ⅻ`) or an unknown named character reference rejects the answer.
- **Claims and figures.** Paragraphs, list items and headings split into sentences; table rows stay whole. A sentence ends at `.`, `!` or `?` plus optional closers and citations, with or without a space, so `The fee is $40. [S1]` credits S1 to that sentence; a period after `a.m.`/`p.m.` ends it only when an uppercase letter follows; a citation-only remainder joins the sentence before it, including a citation alone in the next paragraph or table row. Within a sentence, each figure is credited to the first citation group after it, or, when none follows, the last group before it. Figures are typed spans compared as exact strings, never as floating-point values: a currency amount, a percentage, a plain number, or a compound (digits joined by `-`, `/`, `:`, a fraction slash U+2044 or U+2215, or letters, such as `2026-10-07`, `9:00`, `5-7`, `PLN-2041`, compared lowercased; a whole number, one space and a fraction such as `4 1/2` is one compound, and fraction slashes compare as `/`). A currency amount has a symbol or ISO code next to the number, or a money word after it (`dollars`, `cents`, `euros`, `pounds`, `pence`, `yen`, `yuan`, `rupees`, `pesos`, `francs`, `bucks`, `quid`, `rand`, `grand`, singular or plural, with one capitalized qualifier kept in the unit, so `40 US dollars` differs from `40 Canadian dollars` and from `$40`). A scale word after the number (`hundred`, `thousand`, `lakh`, `million`, `crore`, `billion`, `trillion`) is part of the value, as is `k`, `M`, `B`, `bn` and similar attached to a currency amount (`$40k`, `$2.5M`) or one space after it (`$40 M`); the value is shifted as a string, so `$1.5 million` equals `$1,500,000` and `$40 thousand` does not equal `$40`. Thousands separators and trailing decimal zeros are dropped, so `$1,250.00` equals `$1,250`. A figure is grounded only if a cited excerpt holds a figure of the same kind, unit and value, so a plain number matches only a plain number: `40 cents`, `40 euros` and `40 dollars` are not grounded by `$40` or `40%`, and a bare `40` is not grounded by `$40`. Other unit words (`days`, `months`, `minutes`) do not change the kind. A number never matches part of a compound, so `$7` does not match `2026-10-07`, `40%` does not match `$40`, and `$4½` does not match `$41` plus `2`. A leading minus sign is part of the value.

A miss fails validation with `ungrounded_figure`, which advances to the next route like any validation failure and ends in the safe refusal when the chain is exhausted. Limits: units without figures get no check, so prose claims (procedures, names, yes/no policy statements) are still grounded only by the per-answer citation rule; numbers written as words and list ordinals are not figures, so `95. dollars` after a blank line renders as a list numbered 95 and passes; a fenced code block's info string is hidden and unchecked; an excerpt figure matches anywhere in the cited excerpt regardless of what it counts, and unit words other than money and scale are not compared, so `40 percentage points` and `2 dozen` are grounded by `40 days` and `2 days`; a money word after a two-word qualifier (`40 New York dollars`) is not read, leaving a plain number; a format change rejects a correct answer (`5-7` versus `5 to 7`, `3pm` versus `3 PM`, `$40` versus `USD 40` or `40 dollars`, `40¢` versus `40 cents`, `$4.50` versus `$4½`, `007` versus `7`); `5 p.m. Monday` splits after `p.m.`, leaving the first part uncited; space-separated three-digit groups such as `option 2 100` read as one number; answers containing HTML, code or URLs are read conservatively and may be rejected (the system prompt forbids all three), for example `www.` inside a word hides a citation the renderer shows; raw HTML tags render as visible text, so `$9<b>5</b>` reads as `$9` and `5`; non-ASCII digits reject even when the excerpt uses the same digits. The structure and citation rules mirror micromark and `annotateCitations`; a change to either needs the gate re-checked.

Known gaps that let an ungrounded answer through (found by the final independent audit):

- A table row whose cells are separated or led by non-ASCII whitespace (for example NBSP) can push a citation into a cell the renderer drops, and the gate still counts it.
- An HTML tag with a quoted attribute containing `>` or `<` is not recognized as an HTML block, so a citation inside it counts though the CSR sees literal text.
- Money words, codes and prefixes outside the built-in list (for example `40 dinars`, `Rs 40`, `$40 CAD`, `C$40`, lowercase qualifiers) and scale forms outside it (`mln`, `mil`, `Mn`, `millions`, spaced `k`) are compared as plain numbers or ignored.
- Joiners other than U+2044, U+2215 and fullwidth solidus (for example `⧸`, `╱`, `÷`) and superscript or subscript digits split one value into separate numbers.
- A pipe inside a code span in a table body row (for example `` | `a|b` | $99 | [S6] | ``) splits the cell in GFM, so the citation falls into a dropped cell and renders with no chip, but the gate counts it.

The owner accepted these gaps on 2026-10-07. Close them by validating answers against a strict allowed-format subset, or by parsing answers with the same markdown library the frontend uses.

The approved routes form a server-owned allowlist that a super user orders into a fallback chain on `/admin/model-routing`: Nemotron 3 Super Nitro on DigitalOcean (default primary), GPT-5.4 Nano Nitro on Azure, Nemotron 3 Ultra Nitro on Together, Mercury 2 on Inception at low reasoning, and Granite 4.1 8B on WandB. The order lives in `app_settings`; unknown or removed ids are dropped and missing approved routes appended. Every request pins one provider and enforces `provider.zdr=true`, `data_collection="deny"`, and `allow_fallbacks=false`. OpenRouter rejects a route before prompt delivery when no matching ZDR endpoint exists. Generation advances on request, empty-answer, or citation failure. Chain exhaustion returns the safe refusal. There is deliberately no direct-provider backup that can bypass OpenRouter's per-request ZDR enforcement.

Granite 4.1 8B is a standard instruct model, not a hybrid-thinking model. Its WandB OpenRouter endpoint does not expose `reasoning_effort`; the route omits that parameter and uses deterministic `temperature: 0`. There are no low, medium, or high thinking options for this model.

## UI contract

- Every CSR answer renders citation chips. If the server derives zero sources from recognized inline citation IDs, treat the answer as invalid regardless of the `refused` flag.
- Citation chip is clickable → opens a side panel with the clean source excerpt + an immutable deep link (`version`, query-log id, source position). The reader opens that READY historical version and marks the exact raw-Markdown span. Image-derived chunks keep a version-pinned receipt but may have no direct text span. Citation-target reads re-check query owner, program, source position, document, and version.
- Refusal renders a clearly different visual state — not an error, but explicitly "not in KB."
- Thumbs up/down writes to `query_log.feedback`. Low-feedback queries are the gold for KB improvement.

## Pitfalls

- Mixing `program_id` filter into reranker input (post-hoc filter) is a known bug class — filter at the SQL stage, before reranking, or you'll return chunks from the wrong program when scores happen to favor them.
- BM25 via `ts_rank` on `to_tsvector('english', content)` handles most cases; if your KB has heavy industry jargon (insurance codes, telco SKUs), consider a custom dictionary.
- The reranker threshold is a hyperparameter. Tune it against the eval set, not vibes.
- Don't stream responses in v1. CSRs need the complete answer + citations to read to a customer — streaming partial state is a regression.

### 2026-07-11: Demo prompts must track the seed corpus

First-run questions in `artifacts/rag-app/src/pages/Chat.tsx` must stay answerable by the active demo corpus in `scripts/src/seed.ts`. Stale suggestions produce correct refusals on the live demo and make a working retrieval system look broken.
