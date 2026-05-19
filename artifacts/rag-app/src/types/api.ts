/**
 * API response shapes. These are duplicated from the api-server's types on
 * purpose — TypeScript types are erased at runtime, but coupling the
 * frontend to a backend package via a TS import would make every API change
 * a cross-package dependency. The shapes are stable (set by the
 * .claude/reference/retrieval.md generation contract), so duplication is
 * cheap.
 *
 * When the shape drifts on the backend, fix here too.
 */

export type UserRole = "admin" | "csr";

export interface CurrentUser {
  id: string;
  email: string;
  role: UserRole;
  programId: string;
}

export interface Source {
  chunk_id: string;
  doc_title: string;
  excerpt: string;
}

export interface RetrievedChunk {
  id: string;
  content: string;
  docTitle?: string;
}

export type Confidence = "high" | "medium" | "low";

export interface AskResponse {
  queryLogId: string | null;
  answer: string;
  sources: Source[];
  refused: boolean;
  confidence: Confidence;
  retrievedChunks: RetrievedChunk[];
  latencyMs: number;
  topScore: number | null;
}

export type ParseStatus = "pending" | "parsing" | "ready" | "failed";

export interface DocumentListItem {
  documentId: string;
  title: string;
  versionId: string | null;
  parseStatus: ParseStatus | null;
  /** ISO timestamp string (or null). */
  uploadedAt: string | null;
}

export interface DocumentListResponse {
  items: DocumentListItem[];
}

export interface UploadResponse {
  ok: boolean;
  error?: string;
  documentVersionId?: string;
}

export interface PreviewResponse {
  markdown: string | null;
  parseStatus: ParseStatus | null;
  title: string | null;
}
