import { sql } from "drizzle-orm";
import { db } from "../db-client.js";
import { OpenAIEmbedder, type Embedder } from "../ingestion/embedder.js";
import { rerankWithCohere } from "./rerank.js";

const DEFAULT_RERANK_THRESHOLD = 0.3;
const DEFAULT_TOP_K = 8;
const DEFAULT_CANDIDATE_K = 40;

export interface RetrievalChunk {
  id: string;
  content: string;
  documentVersionId: string;
  programId: string;
  docTitle?: string;
  relevanceScore: number;
}

export interface RetrievalInput {
  programId: string;
  question: string;
  topK?: number;
  candidateK?: number;
}

export interface RetrievalResult {
  chunks: RetrievalChunk[];
  refused: boolean;
  topScore: number | null;
  threshold: number;
}

export interface RetrievalDeps {
  embedder?: Embedder;
}

interface CandidateRow {
  id: string;
  content: string;
  document_version_id: string;
  program_id: string;
  doc_title: string | null;
}

function readNumberEnv(key: string, fallback: number, parser: (s: string) => number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parser(raw);
  return Number.isFinite(n) ? n : fallback;
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
  embedding: number[],
  k: number
): Promise<CandidateRow[]> {
  const vec = `[${embedding.join(",")}]`;
  const result = await db.execute(sql`
    SELECT c.id, c.content, c.document_version_id, c.program_id,
           d.title AS doc_title
    FROM chunks c
    JOIN document_versions dv ON dv.id = c.document_version_id
    LEFT JOIN documents d ON d.id = dv.document_id
    WHERE c.program_id = ${programId}::uuid
      AND dv.is_active = true
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
  question: string,
  k: number
): Promise<CandidateRow[]> {
  const result = await db.execute(sql`
    SELECT c.id, c.content, c.document_version_id, c.program_id,
           d.title AS doc_title
    FROM chunks c
    JOIN document_versions dv ON dv.id = c.document_version_id
    LEFT JOIN documents d ON d.id = dv.document_id
    WHERE c.program_id = ${programId}::uuid
      AND dv.is_active = true
      AND c.content_tsv @@ websearch_to_tsquery('english', ${question})
    ORDER BY ts_rank(c.content_tsv, websearch_to_tsquery('english', ${question})) DESC
    LIMIT ${k}
  `);
  return result.rows as unknown as CandidateRow[];
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

export async function retrieve(
  input: RetrievalInput,
  deps: RetrievalDeps = {}
): Promise<RetrievalResult> {
  const threshold = readNumberEnv(
    "RERANK_CONFIDENCE_THRESHOLD",
    DEFAULT_RERANK_THRESHOLD,
    Number.parseFloat
  );
  const topK = input.topK ?? readNumberEnv("RETRIEVAL_TOP_K", DEFAULT_TOP_K, (s) => parseInt(s, 10));
  const candidateK =
    input.candidateK ??
    readNumberEnv("RETRIEVAL_CANDIDATE_K", DEFAULT_CANDIDATE_K, (s) => parseInt(s, 10));

  const trimmed = input.question.trim();
  if (trimmed.length === 0) {
    return { chunks: [], refused: true, topScore: null, threshold };
  }

  const embedder = deps.embedder ?? new OpenAIEmbedder();
  const embeddings = await embedder.embed([trimmed]);
  const embedding = embeddings[0];
  if (!embedding) {
    return { chunks: [], refused: true, topScore: null, threshold };
  }

  const [vectorRows, bm25Rows] = await Promise.all([
    vectorSearch(input.programId, embedding, candidateK),
    bm25Search(input.programId, trimmed, candidateK)
  ]);

  const candidates = mergeCandidates(vectorRows, bm25Rows);
  if (candidates.length === 0) {
    return { chunks: [], refused: true, topScore: null, threshold };
  }

  const reranked = await rerankWithCohere({
    question: trimmed,
    documents: candidates.map((c) => c.content),
    topN: topK
  });

  const ranked: RetrievalChunk[] = [];
  for (const r of reranked.results) {
    const cand = candidates[r.index];
    if (!cand) continue;
    ranked.push({
      id: cand.id,
      content: cand.content,
      documentVersionId: cand.document_version_id,
      programId: cand.program_id,
      docTitle: cand.doc_title ?? undefined,
      relevanceScore: r.relevance_score
    });
  }

  const topScore = ranked[0]?.relevanceScore ?? null;
  const refused = topScore === null || topScore < threshold;

  return { chunks: ranked, refused, topScore, threshold };
}
