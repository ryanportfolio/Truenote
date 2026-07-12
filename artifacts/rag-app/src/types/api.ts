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
  /**
   * Owning document id, for "read the full document" links into the
   * knowledge base (/kb/:doc_id). Null when the server couldn't resolve
   * the chunk (deleted between retrieval and lookup).
   */
  doc_id: string | null;
  /** Immutable parsed document version that supplied this passage. */
  document_version_id: string | null;
  version_number: number | null;
  /** Zero-based position in the query log's immutable citation snapshot. */
  citation_index: number;
  /** UTF-16 offsets into that version's parsed Markdown, when directly anchorable. */
  source_start: number | null;
  source_end: number | null;
  /**
   * Runtime-only, history read path: true when the cited document version has
   * since been replaced. The excerpt is still what the CSR was shown, but it's
   * no longer the current source — the UI marks it so a CSR doesn't re-quote
   * superseded content. Absent on live answers; deleted-version citations are
   * dropped server-side rather than flagged.
   */
  superseded?: boolean;
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
export type AskStage = "rewriting" | "searching" | "reranking" | "generating";

/** One prior exchange sent for follow-up query rewriting (server uses it for retrieval only). */
export interface AskHistoryTurn {
  question: string;
  answer: string;
}

export interface AskResponse {
  queryLogId: string | null;
  /** The chat session this exchange was logged under. Send it back to continue the session. */
  sessionId: string | null;
  answer: string;
  sources: Source[];
  refused: boolean;
  confidence: Confidence;
  retrievedChunks: RetrievedChunk[];
  latencyMs: number;
  topScore: number | null;
  /** The standalone question retrieval actually ran, when a follow-up was rewritten. */
  rewrittenQuestion: string | null;
}

/**
 * Chat session history shapes. Mirror of routes/sessions.ts. A session
 * groups a CSR's exchanges into a named, resumable conversation.
 */
export interface SessionListItem {
  id: string;
  /** Auto-generated from the opening exchange; null until the namer runs. */
  title: string | null;
  /** ISO timestamp of the last exchange, or null. */
  updatedAt: string | null;
}

export interface SessionListResponse {
  items: SessionListItem[];
  /** Same sentinel contract as DocumentListResponse. */
  noProgramSelected?: boolean;
}

/** One reconstructed exchange from a past session. */
export interface SessionExchange {
  queryLogId: string;
  question: string;
  answer: string;
  refused: boolean;
  latencyMs: number | null;
  feedback: number | null;
  sources: Source[];
}

export interface SessionDetailResponse {
  id: string;
  title: string | null;
  exchanges: SessionExchange[];
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

/** One content gap: a question the KB failed, grouped over the window. */
export interface KbGapItem {
  question: string;
  askCount: number;
  refusedCount: number;
  flaggedCount: number;
  negativeCount: number;
  /** ISO timestamp string. */
  lastAskedAt: string;
}

export interface KbGapsResponse {
  items: KbGapItem[];
  windowDays: number;
  totals: {
    queries: number;
    refused: number;
    flaggedMissing: number;
    negativeFeedback: number;
  };
  /** Same sentinel contract as DocumentListResponse. */
  noProgramSelected?: boolean;
}

/**
 * CSR-facing knowledge base shapes. Mirror of routes/kb.ts on the server
 * (same duplication rationale as the rest of this file). Only documents
 * with an active, parse-ready version appear — this is the read surface,
 * not document admin.
 */
export interface KbDocumentListItem {
  documentId: string;
  title: string;
  /** Active version's upload time (ISO), or null. */
  updatedAt: string | null;
}

export interface KbDocumentListResponse {
  items: KbDocumentListItem[];
  /** Same sentinel contract as DocumentListResponse. */
  noProgramSelected?: boolean;
}

export interface KbDocumentResponse {
  documentId: string;
  /** Active parsed version rendered by the reader. */
  documentVersionId: string;
  versionNumber: number;
  /** False when a citation deep-link intentionally opens a historical version. */
  isCurrentVersion: boolean;
  title: string;
  markdown: string | null;
  updatedAt: string | null;
  /** True only when query/source matched the current user's immutable receipt. */
  citationAuthorized: boolean;
  citationTarget: {
    excerpt: string;
    sourceStart: number;
    sourceEnd: number;
  } | null;
}

export type KbHighlightColor = "yellow" | "green" | "blue";

/** One personal passage highlight anchored to a rendered document version. */
export interface KbHighlight {
  id: string;
  highlightedText: string;
  startOffset: number;
  endOffset: number;
  color: KbHighlightColor;
  createdAt: string;
  updatedAt: string;
}

export interface KbHighlightListResponse {
  items: KbHighlight[];
  /** Lets the client reject a list fetched across a document-version race. */
  documentVersionId: string;
  /** Server capability flag for creating, editing, and removing highlights. */
  canWriteHighlights: boolean;
}

export interface CreateKbHighlightRequest {
  documentVersionId: string;
  highlightedText: string;
  startOffset: number;
  endOffset: number;
  color: KbHighlightColor;
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

export interface ModelRoutingOption {
  id: string;
  label: string;
  model: string;
  provider: string;
  providerLabel: string;
  reasoningEffort: "none" | "low" | "medium";
  description: string;
}

export interface ModelRoutingConfig {
  /** Ordered approved-route ids; index 0 is the primary. */
  order: string[];
  /** The same routes as objects, in fallback order (index 0 = primary). */
  routes: ModelRoutingOption[];
  persistenceReady: boolean;
}

/** Super-user evaluation-center shapes. Mirrors /api/admin/evaluations. */
export type EvalQuestionKind = "in-kb" | "out-of-kb";

export interface EvalQuestionItem {
  id: string;
  programId: string;
  question: string;
  kind: EvalQuestionKind;
  expectedDocId: string | null;
  expectedDocTitle: string | null;
  expectedAnswerContains: string[];
  notes: string | null;
  createdAt: string | null;
}

export interface EvalQuestionListResponse {
  items: EvalQuestionItem[];
  noProgramSelected?: boolean;
}

export interface SaveEvalQuestionRequest {
  kind: EvalQuestionKind;
  question: string;
  expectedDocId?: string | null;
  expectedAnswerContains?: string[];
  notes?: string | null;
}

export type EvalFailureStage = "retrieval" | "rerank" | "threshold" | "generation";

export interface EvalQuestionResult {
  questionId: string;
  question: string;
  programId: string | null;
  programName: string | null;
  expectedDocId: string | null;
  expectedAnswerContains: string[];
  notes: string | null;
  answer: string;
  refused: boolean;
  topScore: number | null;
  citedChunkIds: string[];
  citedDocIds: string[];
  latencyMs: number;
  generationPath: "retrieval-refusal" | "primary" | "fallback" | "fallback-failed" | "not-run";
  kind: EvalQuestionKind;
  pass: boolean;
  citationCorrect: boolean | null;
  phrasesPresent: Array<{ phrase: string; present: boolean }>;
  answerCorrect: boolean | null;
  retrievalHit: boolean | null;
  rerankHit: boolean | null;
  expectedDocRank: number | null;
  failureStage: EvalFailureStage | null;
  faithfulnessPct: number | null;
  unsupportedClaims: string[];
  faithfulnessJudgeFailed: boolean;
  error: string | null;
}

export interface EvalSummary {
  totalQuestions: number;
  passed: number;
  failed: number;
  inKbTotal: number;
  inKbPassed: number;
  outOfKbTotal: number;
  outOfKbPassed: number;
  citationAccuracyPct: number | null;
  answerAccuracyPct: number | null;
  /** Refusal rate split by answerable vs intentionally unanswerable questions. */
  inKbRefusalRatePct: number | null;
  outOfKbRefusalRatePct: number | null;
  retrievalRecallPct: number | null;
  rerankRecallPct: number | null;
  inKbFailuresByStage: Record<EvalFailureStage, number> & { unattributed: number };
  expectedDocRankMean: number | null;
  judgedQuestions: number;
  meanFaithfulnessPct: number | null;
  unfaithfulQuestions: number;
  fallbackGenerationCount: number;
  failedFallbackCount: number;
  judgeFailures: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
}

export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: EvalSummary;
  results: EvalQuestionResult[];
}

export interface EvalRunConfiguration {
  judge: boolean;
  questionSetHash: string | null;
  generation: {
    id: string;
    label: string;
    model: string;
    providerLabel: string;
  };
  routeChain?: Array<{
    id: string;
    label: string;
    model: string;
    providerLabel: string;
  }>;
  /** Legacy direct backup snapshot; absent on ZDR-only runs. */
  fallback?: {
    label: string;
    model: string;
    providerLabel: string;
  };
  retrieval: {
    topK: number;
    candidateK: number;
    threshold: number;
    neighborAnchors: number;
    rerankModel: string;
  };
}

export type EvalRunStatus = "queued" | "running" | "completed" | "failed";

export interface EvalRunListItem {
  id: string;
  status: EvalRunStatus;
  questionId: string | null;
  judge: boolean;
  questionCount: number;
  completedQuestions: number;
  configuration: EvalRunConfiguration | null;
  summary: EvalSummary | null;
  error: string | null;
  isBaseline: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EvalRunListResponse {
  persistenceReady: boolean;
  items: EvalRunListItem[];
  noProgramSelected?: boolean;
}

export interface EvalRunDetailResponse {
  item: EvalRunListItem;
  report: EvalReport | null;
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
  /**
   * Present only on demo deployments (server env DEMO_LOGIN_ACCOUNTS).
   * Working credentials, published on purpose so the login page can
   * pre-fill them. Roles are capped at "manager" server-side.
   */
  demoAccounts?: DemoAccount[];
}

export interface DemoAccount {
  label: string;
  email: string;
  password: string;
  role: "csr" | "manager";
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

export interface BulkCreateUsersResponse {
  created: UserListItem[];
  skippedEmails: string[];
  /**
   * How many created users were emailed a one-time "set your password"
   * invite link. No plaintext password is ever returned — each user sets
   * their own via the emailed link, so the admin distributes nothing.
   */
  invitedCount: number;
  forcedPasswordReset: true;
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

/**
 * Content-gaps review shapes. Mirror of the api-server's QueryLogItem in
 * routes/admin/queries.ts (same duplication rationale as above).
 *
 * `feedback`: -1 / 0 / 1 (thumbs down / none / up); may be null on rows
 * older than the feedback feature. `answer` is deliberately not exposed —
 * the reviewer's unit of work is the question.
 */
export type QueryLogFilter = "flagged" | "refused" | "negative" | "all";

export interface QueryLogItem {
  id: string;
  question: string;
  refused: boolean;
  flaggedMissing: boolean;
  feedback: number | null;
  latencyMs: number | null;
  programId: string | null;
  createdAt: string | null;
}

export interface QueryLogListResponse {
  items: QueryLogItem[];
}

/** Super-user live pipeline observability shapes. */
export type PipelineStageGroup = "request" | "retrieval" | "finalization";

export interface PipelineStageStat {
  key: string;
  label: string;
  group: PipelineStageGroup;
  samples: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface ProviderTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ProviderAttemptTiming {
  routeId: string;
  provider: string;
  model: string;
  durationMs: number;
  outcome: "success" | "invalid" | "error";
  tokens?: ProviderTokenUsage;
}

export interface PipelineTimingBreakdown {
  version: 1;
  totalMs: number;
  stages: Record<string, number>;
  counts: {
    vectorCandidates: number;
    keywordCandidates: number;
    mergedCandidates: number;
    rankedChunks: number;
    contextChunks: number;
  };
  context: {
    rewriteCalled: boolean;
    trigramFallback: boolean;
    generationPath: "retrieval-refusal" | "primary" | "fallback" | "fallback-failed";
    rerankModel: string;
  };
  providerAttempts: ProviderAttemptTiming[];
}

export interface ProviderTimingStat {
  routeId: string;
  provider: string;
  model: string;
  attempts: number;
  successes: number;
  successRatePct: number;
  p50Ms: number;
  p95Ms: number;
  tokenSamples: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  meanTotalTokens: number;
}

export interface ObservabilityResponse {
  storageReady: boolean;
  windowHours: number;
  sampleCount: number;
  sampleTruncated: boolean;
  summary: {
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    refusalRatePct: number;
  };
  stages: PipelineStageStat[];
  providers: ProviderTimingStat[];
  recent: Array<{
    id: string;
    question: string;
    programName: string;
    refused: boolean;
    createdAt: string | null;
    timing: PipelineTimingBreakdown;
  }>;
}

export type ErrorLogSeverity = "warning" | "error" | "fatal";

export interface ErrorLogItem {
  id: string;
  occurredAt: string;
  severity: ErrorLogSeverity;
  source: string;
  operation: string;
  message: string;
  name: string | null;
  stack: string | null;
  code: string | null;
  status: number | null;
  provider: string | null;
  model: string | null;
  routeId: string | null;
  requestId: string | null;
  correlationId: string | null;
  method: string | null;
  path: string | null;
  userId: string | null;
  programId: string | null;
  queryLogId: string | null;
  details: unknown;
}

export interface ErrorLogResponse {
  storageReady: boolean;
  windowHours: number;
  total: number;
  hasMore: boolean;
  counts: Record<ErrorLogSeverity, number>;
  sources: string[];
  items: ErrorLogItem[];
}
