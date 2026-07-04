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

export interface ResetPasswordResponse {
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

/**
 * Real pipeline checkpoints streamed by /api/ask/stream while the CSR
 * waits. Mirror of AskStage in api-server routes/ask.ts.
 */
export type AskStage = "searching" | "reranking" | "generating";

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
  /**
   * Set to true when a super_user hasn't picked a target program yet.
   * The UI uses this to render a "select a program" prompt instead of
   * an empty list, which would be ambiguous (could mean "no documents"
   * or "no scope"). Non-super_user responses never include this.
   */
  noProgramSelected?: boolean;
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

export interface Program {
  id: string;
  name: string;
  /** ISO timestamp string (or null). */
  createdAt: string | null;
}

export interface ProgramListResponse {
  items: Program[];
}

/** Public, non-secret server config used by the SPA. */
export interface AppConfig {
  /**
   * Minimum length the change-password form should enforce. Server is
   * the source of truth (the zod schema rejects shorter passwords);
   * the client mirrors it for UX consistency.
   */
  minPasswordLength: number;
  /**
   * True when the api-server has a real email transport configured
   * (Resend API key + sender address both set). The Login page uses
   * this to hide the "Forgot password?" link when the server would
   * silently log the reset token to stdout instead of mailing it —
   * surfacing the link in that state lets users think a reset is
   * coming when it isn't.
   */
  emailResetAvailable: boolean;
}

/**
 * User-admin shapes. Mirror of the api-server's UserListItem in
 * routes/admin/users.ts. Same duplication rationale as everything else
 * in this file — coupling via a TS import would chain every API tweak
 * across package boundaries.
 *
 * `programId` is null only for super_user (DB CHECK on the server).
 * Timestamps are ISO strings; the server formats once so the SPA
 * doesn't have to think about JSON's date hole.
 */
export interface UserListItem {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  programId: string | null;
  isActive: boolean;
  mustResetPassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface UserListResponse {
  items: UserListItem[];
}

export interface CreateUserRequest {
  email: string;
  name: string;
  role: UserRole;
  /**
   * - non-super_user roles: required (must be a UUID). The server
   *   defaults to the actor's own program for manager/senior_manager
   *   when omitted, but explicit is clearer at the call site.
   * - super_user role: must be null (DB CHECK).
   */
  programId: string | null;
  /**
   * Optional. If omitted the server generates a temp password and
   * returns it once on the response. If provided, the server hashes
   * it as-is; either way the new user is forced to change it on
   * first login.
   */
  password?: string;
}

export interface CreateUserResponse {
  item: UserListItem;
  /**
   * Present only when the server generated the password (i.e. the
   * caller omitted `password` from the request). Surfaced to the
   * admin once; treat as sensitive and communicate out-of-band.
   */
  tempPassword?: string;
}

export interface UpdateUserRequest {
  name?: string;
  role?: UserRole;
  programId?: string | null;
  isActive?: boolean;
}

export interface ResetUserPasswordResponse {
  tempPassword: string;
}
