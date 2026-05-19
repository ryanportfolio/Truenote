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

export type UserRole = "super_user" | "senior_manager" | "manager" | "csr";

export interface CurrentUser {
  id: string;
  email: string;
  role: UserRole;
  /** Null for super_user (no implicit program scope). Non-null otherwise. */
  programId: string | null;
  name: string;
  mustResetPassword: boolean;
}

/**
 * Role hierarchy mirror of the server-side ranking in
 * api-server/src/lib/auth/current-user.ts. Used client-side to drive UI
 * visibility (e.g., which nav links a CSR sees). The server still enforces
 * auth on every endpoint — this is a UX layer, not a security boundary.
 */
const ROLE_RANK: Record<UserRole, number> = {
  super_user: 100,
  senior_manager: 80,
  manager: 60,
  csr: 20
};

export function hasAtLeastRole(user: CurrentUser, minimum: UserRole): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}

export interface LoginResponse {
  user: CurrentUser;
}

export interface ChangePasswordResponse {
  user: CurrentUser;
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
