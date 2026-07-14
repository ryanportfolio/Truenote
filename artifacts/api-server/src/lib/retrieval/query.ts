import { sql } from "drizzle-orm";
import { db } from "../db-client.js";
import { getDeadlineConfig } from "../deadlines.js";
import { OpenAIEmbedder, type Embedder } from "../ingestion/embedder.js";
import { elapsedMs } from "../observability/pipeline-timing.js";
import { recordAppError } from "../observability/error-log.js";
import { getRerankModel, rerankWithCohere } from "./rerank.js";
import {
  classificationSqlPredicate,
  type Classification
} from "../security/classification.js";

const DEFAULT_RERANK_THRESHOLD = 0.3;
const DEFAULT_TOP_K = 8;
const DEFAULT_CANDIDATE_K = 40;
const DEFAULT_NEIGHBOR_ANCHORS = 3;

/**
 * Floor for the trigram zero-hit fallback. word_similarity scores below this
 * are noise (random letter overlap), not a typo'd token. Tune against the
 * eval set if the fallback ever surfaces junk candidates — they still have
 * to survive the reranker, so the blast radius of a loose floor is small.
 */
const TRIGRAM_SIMILARITY_FLOOR = 0.3;

export interface RetrievalChunk {
  id: string;
  content: string;
  documentVersionId: string;
  documentId: string | null;
  versionNumber: number;
  programId: string;
  docTitle?: string;
  /** Raw JSONB metadata. Citation code validates fields before use. */
  metadata: unknown;
  relevanceScore: number;
  /**
   * True for ordinal-adjacent context chunks pulled in by neighbor
   * expansion. Neighbors were NOT scored by the reranker — their
   * relevanceScore is 0 and they never participate in the confidence gate.
   */
  neighbor?: boolean;
}

export interface RetrievalInput {
  programId: string;
  question: string;
  /** Server-resolved user clearance. Never accept this from a client body. */
  maxClassification: Classification;
  topK?: number;
  candidateK?: number;
  /** Include the stage-level trace (pre/post-rerank candidates). Used by the eval harness. */
  withTrace?: boolean;
}

export interface RetrievalTraceEntry {
  chunkId: string;
  documentId: string | null;
}

/** Stage-level retrieval trace, for eval failure attribution. */
export interface RetrievalTrace {
  /** Merged vector + BM25 candidates, pre-rerank. */
  candidates: RetrievalTraceEntry[];
  /** Post-rerank top-K, before neighbor expansion. */
  ranked: RetrievalTraceEntry[];
  /** True when BM25 returned zero rows and the trigram fallback supplied candidates instead. */
  trigramFallback: boolean;
}

export interface RetrievalResult {
  chunks: RetrievalChunk[];
  refused: boolean;
  topScore: number | null;
  threshold: number;
  timing: RetrievalTiming;
  trace?: RetrievalTrace;
}

export interface RetrievalTiming {
  totalMs: number;
  stages: {
    embedding: number;
    vectorSearch: number;
    keywordSearch: number;
    trigramSearch: number;
    candidateMerge: number;
    rerank: number;
    neighborFetch: number;
    neighborMerge: number;
  };
  counts: {
    vectorCandidates: number;
    keywordCandidates: number;
    mergedCandidates: number;
    rankedChunks: number;
    contextChunks: number;
  };
  trigramFallback: boolean;
  rerankModel: string;
}

export interface RetrievalDeps {
  embedder?: Embedder;
  /** Called just before the Cohere rerank pass. Lets callers surface an honest pipeline stage to a waiting user. */
  onRerankStart?: () => void;
  /** Cancels in-flight embedding and rerank calls (client disconnect or overall ask deadline). */
  signal?: AbortSignal;
}

interface CandidateRow {
  id: string;
  content: string;
  document_version_id: string;
  version_number: number;
  program_id: string;
  doc_title: string | null;
  document_id: string | null;
  ordinal: number | null;
  metadata: unknown;
}

function readNumberEnv(key: string, fallback: number, parser: (s: string) => number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parser(raw);
  return Number.isFinite(n) ? n : fallback;
}

export interface RetrievalRuntimeConfig {
  threshold: number;
  topK: number;
  candidateK: number;
  neighborAnchors: number;
}

/** The effective retrieval settings used by both live asks and eval snapshots. */
export function getRetrievalRuntimeConfig(): RetrievalRuntimeConfig {
  return {
    threshold: readNumberEnv(
      "RERANK_CONFIDENCE_THRESHOLD",
      DEFAULT_RERANK_THRESHOLD,
      Number.parseFloat
    ),
    topK: readNumberEnv("RETRIEVAL_TOP_K", DEFAULT_TOP_K, (s) =>
      Number.parseInt(s, 10)
    ),
    candidateK: readNumberEnv(
      "RETRIEVAL_CANDIDATE_K",
      DEFAULT_CANDIDATE_K,
      (s) => Number.parseInt(s, 10)
    ),
    neighborAnchors: readNumberEnv(
      "RETRIEVAL_NEIGHBOR_ANCHORS",
      DEFAULT_NEIGHBOR_ANCHORS,
      (s) => Number.parseInt(s, 10)
    )
  };
}

/**
 * Vector search over chunks, scoped to a program.
 *
 * The program_id filter is applied at the SQL stage (NOT post-rerank). Per
 * .claude/reference/retrieval.md, mixing program_id filtering into the
 * reranker input is a known bug class.
 *
 * Only chunks from is_active=true versions are returned.
 */
async function vectorSearch(
  programId: string,
  maxClassification: Classification,
  embedding: number[],
  k: number
): Promise<CandidateRow[]> {
  const vec = `[${embedding.join(",")}]`;
  const result = await db.execute(sql`
    SELECT c.id, c.content, c.document_version_id, c.program_id, c.ordinal,
           c.metadata, dv.version_number,
           d.title AS doc_title, d.id AS document_id
    FROM chunks c
    JOIN document_versions dv ON dv.id = c.document_version_id
    LEFT JOIN documents d ON d.id = dv.document_id
    WHERE c.program_id = ${programId}::uuid
      AND dv.is_active = true
      AND dv.lifecycle_state = 'active'
      AND ${classificationSqlPredicate(sql.raw("dv.classification"), maxClassification)}
    ORDER BY c.embedding <=> ${vec}::vector
    LIMIT ${k}
  `);
  return result.rows as unknown as CandidateRow[];
}

/**
 * BM25 (Postgres full-text) search over chunks, scoped to a program.
 *
 * websearch_to_tsquery handles "quoted phrases", OR/AND, and bare words —
 * the syntax CSRs will actually type, without parsing failures on punctuation.
 */
async function bm25Search(
  programId: string,
  maxClassification: Classification,
  question: string,
  k: number
): Promise<CandidateRow[]> {
  const result = await db.execute(sql`
    SELECT c.id, c.content, c.document_version_id, c.program_id, c.ordinal,
           c.metadata, dv.version_number,
           d.title AS doc_title, d.id AS document_id
    FROM chunks c
    JOIN document_versions dv ON dv.id = c.document_version_id
    LEFT JOIN documents d ON d.id = dv.document_id
    WHERE c.program_id = ${programId}::uuid
      AND dv.is_active = true
      AND dv.lifecycle_state = 'active'
      AND ${classificationSqlPredicate(sql.raw("dv.classification"), maxClassification)}
      AND c.content_tsv @@ websearch_to_tsquery('english', ${question})
    ORDER BY ts_rank(c.content_tsv, websearch_to_tsquery('english', ${question})) DESC
    LIMIT ${k}
  `);
  return result.rows as unknown as CandidateRow[];
}

/**
 * Trigram fallback for BM25 zero-hits, scoped to a program.
 *
 * to_tsvector stems dictionary words; it has nothing for typos ("cancelation
 * fee") or exact codes ("PLN-X200") that CSRs type mid-call. pg_trgm's
 * word_similarity(query, content) finds the best word-bounded match of the
 * query inside the chunk, so a one-letter typo still scores high.
 *
 * This runs ONLY when tsquery matched zero rows, so the extra cost lands on
 * queries that would otherwise contribute nothing to the candidate pool.
 * Plain function call (no <% operator) skips the trgm index — a deliberate
 * trade: no GIN trgm index exists yet, and a per-program seq scan is cheap at
 * current KB scale. If the KB grows past ~100k chunks, add the index via DDL
 * and switch to the operator form.
 */
async function trigramSearch(
  programId: string,
  maxClassification: Classification,
  question: string,
  k: number
): Promise<CandidateRow[]> {
  const result = await db.execute(sql`
    SELECT c.id, c.content, c.document_version_id, c.program_id, c.ordinal,
           c.metadata, dv.version_number,
           d.title AS doc_title, d.id AS document_id
    FROM chunks c
    JOIN document_versions dv ON dv.id = c.document_version_id
    LEFT JOIN documents d ON d.id = dv.document_id
    WHERE c.program_id = ${programId}::uuid
      AND dv.is_active = true
      AND dv.lifecycle_state = 'active'
      AND ${classificationSqlPredicate(sql.raw("dv.classification"), maxClassification)}
      AND word_similarity(${question}, c.content) > ${TRIGRAM_SIMILARITY_FLOOR}
    ORDER BY word_similarity(${question}, c.content) DESC
    LIMIT ${k}
  `);
  return result.rows as unknown as CandidateRow[];
}

/**
 * Defense-in-depth program-scope filter, applied to the final chunk set before
 * it leaves retrieval. Program scoping is a security boundary: every search
 * query already filters `program_id` at the SQL stage, so in correct operation
 * this drops nothing. It exists so a future edit that accidentally widens one
 * of those queries fails CLOSED here (a CSR on Program A can never be served a
 * Program B chunk) instead of leaking cross-tenant content. Pure and exported
 * for tests. Callers record the drop as a security-relevant error.
 */
export function filterToProgramScope(
  chunks: RetrievalChunk[],
  programId: string
): { kept: RetrievalChunk[]; dropped: RetrievalChunk[] } {
  const kept: RetrievalChunk[] = [];
  const dropped: RetrievalChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.programId === programId) kept.push(chunk);
    else dropped.push(chunk);
  }
  return { kept, dropped };
}

export function mergeCandidates(
  vectorRows: CandidateRow[],
  bm25Rows: CandidateRow[]
): CandidateRow[] {
  const merged = new Map<string, CandidateRow>();
  for (const row of vectorRows) merged.set(row.id, row);
  for (const row of bm25Rows) {
    if (!merged.has(row.id)) merged.set(row.id, row);
  }
  return Array.from(merged.values());
}

/**
 * Fetch ordinal ±1 siblings (same active document version) for the anchor
 * chunks. Procedures routinely span a chunk boundary — the reranked chunk has
 * steps 1–4, the answer needs step 5 from the next chunk. Neighbors are
 * context for the LLM, not evidence: they skip the reranker and the gate.
 *
 * The program_id filter is redundant (same version ⇒ same program) but kept
 * anyway — program scoping is a security boundary and belongs in every chunk
 * query, so a future edit can't accidentally widen this one.
 */
async function fetchNeighborRows(
  programId: string,
  maxClassification: Classification,
  anchors: Array<{ documentVersionId: string; ordinal: number }>
): Promise<CandidateRow[]> {
  if (anchors.length === 0) return [];
  const pairConds = anchors.map(
    (a) =>
      sql`(c.document_version_id = ${a.documentVersionId}::uuid AND c.ordinal IN (${a.ordinal - 1}, ${a.ordinal + 1}))`
  );
  const result = await db.execute(sql`
    SELECT c.id, c.content, c.document_version_id, c.program_id, c.ordinal,
           c.metadata, dv.version_number,
           d.title AS doc_title, d.id AS document_id
    FROM chunks c
    JOIN document_versions dv ON dv.id = c.document_version_id
    LEFT JOIN documents d ON d.id = dv.document_id
    WHERE c.program_id = ${programId}::uuid
      AND dv.is_active = true
      AND dv.lifecycle_state = 'active'
      AND ${classificationSqlPredicate(sql.raw("dv.classification"), maxClassification)}
      AND (${sql.join(pairConds, sql` OR `)})
  `);
  return result.rows as unknown as CandidateRow[];
}

/**
 * Interleave neighbor chunks after their anchors, preserving rerank order.
 * Only the top `anchorCount` ranked chunks get neighbors; duplicates (a
 * neighbor that is itself a ranked hit, or shared by two anchors) are
 * dropped. Exported for tests.
 */
export function expandWithNeighbors(
  ranked: RetrievalChunk[],
  anchorCount: number,
  neighborRows: CandidateRow[]
): RetrievalChunk[] {
  const seen = new Set(ranked.map((r) => r.id));
  const byAnchor = new Map<string, CandidateRow[]>();
  for (const row of neighborRows) {
    if (seen.has(row.id)) continue;
    const key = row.document_version_id;
    const list = byAnchor.get(key) ?? [];
    list.push(row);
    byAnchor.set(key, list);
  }
  for (const list of byAnchor.values()) {
    list.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  }

  const out: RetrievalChunk[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const anchor = ranked[i];
    if (!anchor) continue;
    out.push(anchor);
    if (i >= anchorCount) continue;
    const siblings = byAnchor.get(anchor.documentVersionId) ?? [];
    for (const row of siblings) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({
        id: row.id,
        content: row.content,
        documentVersionId: row.document_version_id,
        documentId: row.document_id,
        versionNumber: row.version_number,
        programId: row.program_id,
        docTitle: row.doc_title ?? undefined,
        metadata: row.metadata,
        relevanceScore: 0,
        neighbor: true
      });
    }
  }
  return out;
}

export async function retrieve(
  input: RetrievalInput,
  deps: RetrievalDeps = {}
): Promise<RetrievalResult> {
  const timingStartedAt = performance.now();
  const timingStages: RetrievalTiming["stages"] = {
    embedding: 0,
    vectorSearch: 0,
    keywordSearch: 0,
    trigramSearch: 0,
    candidateMerge: 0,
    rerank: 0,
    neighborFetch: 0,
    neighborMerge: 0
  };
  const timingCounts: RetrievalTiming["counts"] = {
    vectorCandidates: 0,
    keywordCandidates: 0,
    mergedCandidates: 0,
    rankedChunks: 0,
    contextChunks: 0
  };
  let timingTrigramFallback = false;
  const finishTiming = (): RetrievalTiming => ({
    totalMs: elapsedMs(timingStartedAt),
    stages: timingStages,
    counts: timingCounts,
    trigramFallback: timingTrigramFallback,
    rerankModel: getRerankModel()
  });
  const runtime = getRetrievalRuntimeConfig();
  const threshold = runtime.threshold;
  const topK = input.topK ?? runtime.topK;
  const candidateK = input.candidateK ?? runtime.candidateK;
  const neighborAnchors = runtime.neighborAnchors;

  const emptyTrace = (trigramFallback = false): RetrievalTrace => ({
    candidates: [],
    ranked: [],
    trigramFallback
  });

  const trimmed = input.question.trim();
  if (trimmed.length === 0) {
    return {
      chunks: [],
      refused: true,
      topScore: null,
      threshold,
      timing: finishTiming(),
      ...(input.withTrace ? { trace: emptyTrace() } : {})
    };
  }

  const queryEmbeddingDeadline = getDeadlineConfig().queryEmbedding;
  const embedder =
    deps.embedder ??
    new OpenAIEmbedder({
      timeoutMs: queryEmbeddingDeadline.timeoutMs,
      maxRetries: queryEmbeddingDeadline.maxRetries
    });
  const embeddingStartedAt = performance.now();
  const embeddings = await embedder
    .embed([trimmed], { signal: deps.signal })
    .finally(() => {
      timingStages.embedding = elapsedMs(embeddingStartedAt);
    });
  const embedding = embeddings[0];
  if (!embedding) {
    return {
      chunks: [],
      refused: true,
      topScore: null,
      threshold,
      timing: finishTiming(),
      ...(input.withTrace ? { trace: emptyTrace() } : {})
    };
  }

  const vectorPromise = (async () => {
    const startedAt = performance.now();
    try {
      return await vectorSearch(
        input.programId,
        input.maxClassification,
        embedding,
        candidateK
      );
    } finally {
      timingStages.vectorSearch = elapsedMs(startedAt);
    }
  })();
  const keywordPromise = (async () => {
    const startedAt = performance.now();
    try {
      return await bm25Search(
        input.programId,
        input.maxClassification,
        trimmed,
        candidateK
      );
    } finally {
      timingStages.keywordSearch = elapsedMs(startedAt);
    }
  })();
  const [vectorRows, bm25Initial] = await Promise.all([vectorPromise, keywordPromise]);
  timingCounts.vectorCandidates = vectorRows.length;

  // Zero-hit fallback: tsquery found nothing keyword-shaped, so try trigram
  // similarity (typos, SKU codes). Vector candidates are unaffected either way.
  let bm25Rows = bm25Initial;
  let trigramFallback = false;
  if (bm25Rows.length === 0) {
    const trigramStartedAt = performance.now();
    bm25Rows = await trigramSearch(
      input.programId,
      input.maxClassification,
      trimmed,
      candidateK
    ).finally(() => {
      timingStages.trigramSearch = elapsedMs(trigramStartedAt);
    });
    trigramFallback = bm25Rows.length > 0;
  }
  timingTrigramFallback = trigramFallback;
  timingCounts.keywordCandidates = bm25Rows.length;

  const mergeStartedAt = performance.now();
  const candidates = mergeCandidates(vectorRows, bm25Rows);
  timingStages.candidateMerge = elapsedMs(mergeStartedAt);
  timingCounts.mergedCandidates = candidates.length;
  if (candidates.length === 0) {
    return {
      chunks: [],
      refused: true,
      topScore: null,
      threshold,
      timing: finishTiming(),
      ...(input.withTrace ? { trace: emptyTrace(trigramFallback) } : {})
    };
  }

  deps.onRerankStart?.();
  const rerankStartedAt = performance.now();
  const reranked = await rerankWithCohere({
    question: trimmed,
    documents: candidates.map((c) => c.content),
    topN: topK,
    signal: deps.signal
  }).finally(() => {
    timingStages.rerank = elapsedMs(rerankStartedAt);
  });

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ranked: RetrievalChunk[] = [];
  for (const r of reranked.results) {
    const cand = candidates[r.index];
    if (!cand) continue;
    ranked.push({
      id: cand.id,
      content: cand.content,
      documentVersionId: cand.document_version_id,
      documentId: cand.document_id,
      versionNumber: cand.version_number,
      programId: cand.program_id,
      docTitle: cand.doc_title ?? undefined,
      metadata: cand.metadata,
      relevanceScore: r.relevance_score
    });
  }
  timingCounts.rankedChunks = ranked.length;

  const topScore = ranked[0]?.relevanceScore ?? null;
  const refused = topScore === null || topScore < threshold;

  // Trace reflects the pipeline BEFORE neighbor expansion — recall@topK must
  // measure what the reranker chose, not what expansion appended.
  const trace: RetrievalTrace | undefined = input.withTrace
    ? {
        candidates: candidates.map((c) => ({ chunkId: c.id, documentId: c.document_id })),
        ranked: ranked.map((r) => ({
          chunkId: r.id,
          documentId: byId.get(r.id)?.document_id ?? null
        })),
        trigramFallback
      }
    : undefined;

  let chunks = ranked;
  if (!refused && neighborAnchors > 0) {
    const anchors = ranked
      .slice(0, neighborAnchors)
      .map((r) => ({
        documentVersionId: r.documentVersionId,
        ordinal: byId.get(r.id)?.ordinal ?? null
      }))
      .filter((a): a is { documentVersionId: string; ordinal: number } => a.ordinal !== null);
    if (anchors.length > 0) {
      const neighborFetchStartedAt = performance.now();
      const neighborRows = await fetchNeighborRows(
        input.programId,
        input.maxClassification,
        anchors
      ).finally(() => {
        timingStages.neighborFetch = elapsedMs(neighborFetchStartedAt);
      });
      const neighborMergeStartedAt = performance.now();
      chunks = expandWithNeighbors(ranked, neighborAnchors, neighborRows);
      timingStages.neighborMerge = elapsedMs(neighborMergeStartedAt);
    }
  }
  // Defense in depth: every search query is already program-scoped in SQL, so
  // this drops nothing in correct operation. If a future edit ever widens one
  // of those filters, fail closed here rather than serve a cross-program chunk.
  const scoped = filterToProgramScope(chunks, input.programId);
  if (scoped.dropped.length > 0) {
    void recordAppError({
      severity: "error",
      source: "retrieval",
      operation: "program-scope-violation",
      error: new Error("retrieval returned chunks outside the requested program"),
      programId: input.programId,
      context: {
        droppedCount: scoped.dropped.length,
        droppedChunkIds: scoped.dropped.slice(0, 20).map((c) => c.id),
        foreignProgramIds: Array.from(new Set(scoped.dropped.map((c) => c.programId)))
      }
    });
  }
  chunks = scoped.kept;
  timingCounts.contextChunks = chunks.length;

  return {
    chunks,
    refused,
    topScore,
    threshold,
    timing: finishTiming(),
    ...(trace ? { trace } : {})
  };
}
