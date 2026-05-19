# Retrieval & Generation

> CSR asks a question → system returns an answer with citations OR an explicit refusal. This is the product.

## Query pipeline

```
question
  → embed (text-embedding-3-small)
  → parallel: vector search (top 40) + BM25 search (top 40)
  → merge + dedupe by chunk_id
  → Cohere rerank → top 8
  → confidence gate (top score >= RERANK_CONFIDENCE_THRESHOLD?)
       no  → refuse, return "not in knowledge base"
       yes → LLM call with citation contract
  → render answer + citation chips
  → log to query_log
```

**Every query is scoped by `program_id` server-side.** The filter is applied to both vector and BM25 queries. Do not rely on UI scoping.

## Retrieval rules

- **Hybrid is non-negotiable.** Pure vector misses exact-match queries CSRs actually ask ("cancellation fee for plan X"). Pure BM25 misses paraphrases ("how do I refund a customer?" vs SOP titled "issuing returns"). Always combine.
- **Use HNSW, not IVFFlat,** for the pgvector index. HNSW recall is meaningfully better on small KBs (which yours will be for months).
- **Reranker over top 40 candidates, not top 8.** Cheap; big quality lift. Skipping this is the most common cause of "RAG demo feels dumb."
- **Confidence gate is non-negotiable.** If the reranker's top score is below `RERANK_CONFIDENCE_THRESHOLD` (default 0.3, tunable), refuse without calling the LLM. Saves cost AND prevents hallucination on questions the KB can't answer.

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

Respond as JSON only:
{
  "answer": "string with [chunk_id] citations inline",
  "sources": [{"chunk_id":"...", "doc_title":"...", "excerpt":"..."}],
  "refused": boolean,
  "confidence": "high" | "medium" | "low"
}

EXCERPTS:
{retrieved_chunks_with_ids}

QUESTION: {question}
```

Use OpenAI structured outputs (`response_format: { type: 'json_schema', ... }`) — do NOT rely on prompt-only JSON. The model will occasionally drift if you only ask in prose.

## UI contract

- Every CSR answer renders citation chips. If the LLM returns zero sources, treat as a refusal regardless of the `refused` flag.
- Citation chip is clickable → opens a side panel with the full chunk text + a link to the source document at the right version.
- Refusal renders a clearly different visual state — not an error, but explicitly "not in KB."
- Thumbs up/down writes to `query_log.feedback`. Low-feedback queries are the gold for KB improvement.

## Pitfalls

- Mixing `program_id` filter into reranker input (post-hoc filter) is a known bug class — filter at the SQL stage, before reranking, or you'll return chunks from the wrong program when scores happen to favor them.
- BM25 via `ts_rank` on `to_tsvector('english', content)` handles most cases; if your KB has heavy industry jargon (insurance codes, telco SKUs), consider a custom dictionary.
- The reranker threshold is a hyperparameter. Tune it against the eval set, not vibes.
- Don't stream responses in v1. CSRs need the complete answer + citations to read to a customer — streaming partial state is a regression.
