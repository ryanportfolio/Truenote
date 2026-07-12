# Retrieval & Generation

> CSR asks a question → system returns an answer with citations OR an explicit refusal. This is the product.

## Query pipeline

```
question
  → follow-up rewrite (only when the client sent conversation history:
    gpt-4o-mini resolves "that plan"/"the fee" into a standalone question;
    failure falls back to the raw question; first turn = passthrough)
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
             (request/schema/citation failure → next route; exhausted chain
              → direct OpenAI gpt-5.6-luna backup at low reasoning)
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
- **Multi-turn (2026-07):** the Chat client sends its last 3 completed exchanges; `lib/generation/rewrite.ts` (gpt-4o-mini) rewrites a follow-up into a standalone question used for retrieval AND generation. HARD boundary: conversation history is used ONLY for reference resolution — answer generation still sees excerpts + standalone question, so an ungrounded fact from a previous answer can never leak into a new one. `query_log.question` stores what the CSR typed; the rewrite is returned as `rewrittenQuestion` (manager+ debug footer shows "Searched as: …"). Rewrite failure falls back to the raw question. "New conversation" button clears history between calls.

## Generation contract (the part most demos botch)

The LLM ONLY sees retrieved excerpts + the question. Use this exact system prompt:

```
You are a customer service knowledge assistant for {program_name}.

RULES (non-negotiable):
1. ONLY use the EXCERPTS below. Do not use outside knowledge.
2. If the answer is not fully supported by the excerpts, set "refused": true
   and answer: "I couldn't find this in the knowledge base. Please escalate
   or check the source documents directly."
3. Never invent fees, dates, names, policy numbers, or procedures.
4. Cite every factual claim inline using [chunk_id].
5. Prefer the most recent document version when excerpts conflict.
6. Format the answer as GitHub-flavored Markdown. Use numbered steps for
   procedures, bullet lists for options, and **bold** for key values
   (fees, dates, deadlines). Use a table only to compare options. Never
   use headings, code blocks, images, links, or task lists.

Respond as JSON only:
{
  "answer": "string with [chunk_id] citations inline",
  "refused": boolean,
  "confidence": "high" | "medium" | "low"
}

EXCERPTS:
{retrieved_chunks_with_ids}

QUESTION: {question}
```

Use strict structured outputs (`response_format: { type: 'json_schema', ... }`) through the OpenAI-compatible client — do NOT rely on prompt-only JSON. The model will occasionally drift if you only ask in prose.

The model emits citation IDs only inline. The server extracts those IDs, rejects missing or unknown IDs, and builds source metadata from the retrieved chunks. Do not ask the model for a duplicate `sources` array: two model-authored citation representations can disagree without adding any grounding guarantee.

The approved routes form a server-owned allowlist that a super user orders into a fallback chain on `/admin/model-routing`: GPT-5.6 Luna on OpenAI at low reasoning (default primary), GPT-5.4 Nano Nitro on Azure, Nemotron 3 Super Nitro on DigitalOcean, Nemotron 3 Ultra Nitro on Together, and Mercury 2 on Inception at low reasoning. The order (an array of approved ids) lives in `app_settings`; a missing/legacy/invalid value degrades safely to the listed default order, and any approved route absent from a stored order is appended as a tail fallback so the chain is never empty. Each OpenRouter request pins that route's provider with `provider.only`, sets `reasoning_effort` to the route's own effort (`"low"` for Luna and Mercury 2, `"medium"` for the others), and enforces `provider.zdr=true`, `data_collection="deny"`, `require_parameters=true`, and `allow_fallbacks=false`. Generation walks the chain in order: any request error, schema/parse failure, empty answer, unknown inline citation ID, or missing inline citation advances to the next route. A valid grounded refusal is success and ends the walk; it never cascades. If the whole chain errors, one final attempt runs through direct OpenAI `gpt-5.6-luna` at `reasoning_effort: "low"` (outside OpenRouter, so it survives an OpenRouter-wide outage); any required retention controls must therefore also be enabled on the OpenAI organization.

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
