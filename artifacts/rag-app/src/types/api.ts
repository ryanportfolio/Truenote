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

import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

export type UserRole = "super_user" | "senior_manager" | "manager" | "supervisor" | "csr";

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
  supervisor: 40,
  csr: 20
};

export function hasAtLeastRole(user: CurrentUser, minimum: UserRole): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}

export interface LoginResponse {
  user: CurrentUser;
}

export type MfaMethod = "passkey" | "recovery_code";

/**
 * POST /api/auth/login for an account with a passkey: the password was
 * accepted, no session exists yet, and an httpOnly cookie scoped to
 * /api/auth/mfa holds the pending challenge (5 minutes).
 */
export interface MfaRequiredResponse {
  mfaRequired: true;
  methods: MfaMethod[];
  /** Absent when the server offers recovery codes only; methods is then ["recovery_code"]. */
  passkeyOptions?: PublicKeyCredentialRequestOptionsJSON;
}

export type LoginResult =
  | { status: "authenticated"; user: CurrentUser }
  | { status: "mfa_required"; challenge: MfaRequiredResponse };

export interface PasskeySummary {
  id: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface MfaStatusResponse {
  /** False when the server has no usable WebAuthn relying-party config. */
  passkeyAvailable: boolean;
  passkeys: PasskeySummary[];
  unusedRecoveryCodes: number;
}

export interface ChangePasswordResponse {
  user: CurrentUser;
}

/**
 * POST /api/auth/reset-password. The password is set and the link consumed
 * either way. A user with a passkey (or the break_glass emergency account)
 * gets no session and must sign in through /login and its second factor.
 */
export type ResetPasswordResponse =
  | { user: CurrentUser }
  | { passwordReset: true; signInRequired: true };

export type ResetPasswordResult =
  | { status: "authenticated"; user: CurrentUser }
  | { status: "sign_in_required" };

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
export type Classification = "public" | "internal" | "confidential" | "restricted";
export type DocumentLifecycleState =
  | "submitted"
  | "scanning"
  | "parsing"
  | "pending_review"
  | "active"
  | "retired"
  | "quarantined"
  | "rejected"
  | "revoked"
  | "failed";

export interface SecurityFinding {
  category: "file_validation" | "malware" | "pii" | "secret" | "prompt_injection";
  ruleId: string;
  severity: "low" | "medium" | "high" | "critical";
  count: number;
  message: string;
  blocking: boolean;
}

export interface ContentSourceItem {
  id: string;
  name: string;
  originType: string;
  baseUri: string | null;
  ownerName: string;
}

export interface DocumentListItem {
  documentId: string;
  title: string;
  versionId: string | null;
  parseStatus: ParseStatus | null;
  /** ISO timestamp string (or null). */
  uploadedAt: string | null;
  lifecycleState: DocumentLifecycleState;
  scanStatus: string;
  classification: Classification;
  isActive: boolean;
  sourceName: string | null;
  sourceOriginUri: string | null;
  sourceOwner: string | null;
  uploadedById: string | null;
  uploadedByName: string | null;
  approvedByName: string | null;
  findings: SecurityFinding[];
  canApprove: boolean;
  canReject: boolean;
  canRevoke: boolean;
  canRescan: boolean;
}

export interface DocumentListResponse {
  items: DocumentListItem[];
  sources: ContentSourceItem[];
  controlsReady: boolean;
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
  /** When the document was first added (ISO), or null. */
  createdAt: string | null;
  /** True when the document was added or got a new version in the last 14 days. */
  isNew: boolean;
  /** Reader opens by anyone in the program over the last 30 days. */
  viewCount: number;
  /** Answers that cited this document over the last 30 days. */
  citationCount: number;
  /** The current user's last open of this document (ISO), or null. */
  lastViewedByMeAt: string | null;
  /** Personal pin time (ISO); null when not pinned by the current user. */
  pinnedAt: string | null;
  /** The current user's private note, or null. */
  note: string | null;
  noteUpdatedAt: string | null;
  /** The current user's private color label, or null. */
  myColor: KbLibraryColor | null;
  /** Team pin order (0-based) set by a manager; null when not team-pinned. */
  featuredPosition: number | null;
  /**
   * Order (0-based) in the viewer's team list: for a CSR their supervisor's
   * list, for a supervisor their own; null when not on it or no list applies.
   */
  teamPinPosition: number | null;
  /** Every category the document belongs to. */
  categoryIds: string[];
  tagIds: string[];
}

export type KbLibraryColor =
  | "slate"
  | "blue"
  | "green"
  | "amber"
  | "red"
  | "violet"
  | "teal"
  | "pink";

/** A manager-made category. Categories nest through parentId (max 4 levels). */
export interface KbCategory {
  id: string;
  parentId: string | null;
  name: string;
  /** Team color set by a manager. */
  color: KbLibraryColor;
  /** The current user's private override of the team color, or null. */
  myColor: KbLibraryColor | null;
  /** Order among siblings (0-based). */
  position: number;
  /** Member document ids in the manager's order. */
  documentIds: string[];
}

export interface KbTag {
  id: string;
  name: string;
  color: KbLibraryColor;
}

/** The current user's own name for one of their colors ("Read before quoting fees"). */
export interface KbColorLabel {
  color: KbLibraryColor;
  name: string;
}

export interface KbDocumentListResponse {
  items: KbDocumentListItem[];
  categories: KbCategory[];
  tags: KbTag[];
  /** The current user's color names; colors without a name are absent. */
  labels: KbColorLabel[];
  /** True for manager+ non-demo accounts: may edit categories, tags and team pins. */
  canOrganize: boolean;
  /** True for supervisors: may recommend sources to their own team. */
  canPinForTeam: boolean;
  /** Same sentinel contract as DocumentListResponse. */
  noProgramSelected?: boolean;
}

/** Personal pin, note and color state returned by the pin, note and color endpoints. */
export interface KbSourceUserState {
  documentId: string;
  pinnedAt: string | null;
  note: string | null;
  noteUpdatedAt: string | null;
  color: KbLibraryColor | null;
}

export interface CreateKbCategoryRequest {
  name: string;
  parentId?: string | null;
  color?: KbLibraryColor;
}

export interface UpdateKbCategoryRequest {
  name?: string;
  color?: KbLibraryColor;
  /** Move under another category (null = top level). Appends at the end of the new siblings. */
  parentId?: string | null;
}

export interface CreateKbTagRequest {
  name: string;
  color?: KbLibraryColor;
}

export interface UpdateKbTagRequest {
  name?: string;
  color?: KbLibraryColor;
}

/** Source usage analytics (manager+). Window counts come from query_log citations. */
export interface SourceUsageSource {
  documentId: string;
  /** Null when the viewer's clearance is below the document's classification. */
  title: string | null;
  /** False when the document is retired or has no active version now. */
  isLive: boolean;
  /** Answers that cited the document at least once. */
  citationCount: number;
  /** Distinct normalized questions among those answers. */
  questionCount: number;
  /** Distinct users whose answers cited it. */
  userCount: number;
  /** Reader opens in the window (all users, or the selected user). */
  viewCount: number;
  /** Answers citing it that got a thumbs-down. */
  negativeCount: number;
  lastCitedAt: string | null;
}

export interface SourceUsageUser {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  questionCount: number;
  /** Answers with at least one citation (not refused). */
  answeredCount: number;
  refusedCount: number;
  negativeCount: number;
  /** Up to 3 most-cited sources for this user's questions. */
  topSources: { documentId: string; title: string | null; count: number }[];
  lastAskedAt: string | null;
}

/** A program member, listed whether or not they asked anything in the window. */
export interface SourceUsagePerson {
  userId: string;
  name: string;
  role: UserRole;
  /** Questions in the window (0 for people who asked nothing). */
  questionCount: number;
}

/**
 * People x sources: how many answers for each person cited each of the top
 * sources. Columns are the window's top 10 sources by citations (title-gated
 * like `sources`); rows are people with at least one question, same order as
 * `users`. counts[i] belongs to documentIds[i].
 */
export interface SourceUsageMatrix {
  documentIds: string[];
  rows: { userId: string; counts: number[] }[];
}

/**
 * A source to suggest to the selected person: teammates cited it in the
 * window in the same top-level categories as the sources behind this
 * person's thumbs-down answers, or behind teammates' answers to the same
 * question (case, spaces and trailing ?.! ignored) as one of this person's
 * refused answers; and this person never cited it. Ties: more team citations,
 * then the latest team citation, then document id.
 * Fallback when that yields nothing: the team's most-cited sources this
 * person never cited, each with at least 3 team answers in the window. The
 * two reasons are never mixed in one response. Only sources both the viewer
 * and the person can open; restricted titles are omitted.
 */
export interface SourceUsageSuggestion {
  documentId: string;
  title: string;
  /** "related" = same top-level category as a refused/thumbs-down topic; "team_top" = fallback. */
  reason: "related" | "team_top";
  /** Answers by other people that cited it in the window. */
  teamCitations: number;
}

export interface SourceUsageResponse {
  windowDays: number;
  /** Up to 3 suggestions for the selected person; empty when userId is null. */
  suggestions: SourceUsageSuggestion[];
  /** Echo of the userId filter, or null for everyone. */
  userId: string | null;
  /** The filtered person's identity (any window, even with 0 questions); null when userId is null. */
  person: { userId: string; name: string; email: string; role: UserRole } | null;
  /** Every active member of the program with role csr or above, for the person picker. Sorted by name. */
  people: SourceUsagePerson[];
  /** Always computed for everyone in the window (ignores userId). */
  matrix: SourceUsageMatrix;
  totals: {
    questions: number;
    answered: number;
    refused: number;
    /** Distinct documents cited at least once. */
    sourcesCited: number;
    /** Live documents in the program never cited in the window. */
    sourcesNeverCited: number;
    activeUsers: number;
  };
  /** Ranked by citationCount desc, then lastCitedAt desc. Max 100. */
  sources: SourceUsageSource[];
  /** Ranked by questionCount desc. Every program user with >= 1 question. */
  users: SourceUsageUser[];
  noProgramSelected?: boolean;
}

export interface SourceUsageQuestion {
  queryLogId: string;
  question: string;
  askedAt: string;
  userId: string | null;
  userName: string | null;
  refused: boolean;
  /** 1, -1, or null. */
  feedback: number | null;
  sources: { documentId: string; title: string | null }[];
}

export interface SourceUsageQuestionsResponse {
  items: SourceUsageQuestion[];
  /** True when more rows matched than the limit returned. */
  truncated: boolean;
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
  /** The current user's personal state for this document (same as the list item). */
  pinnedAt: string | null;
  note: string | null;
  noteUpdatedAt: string | null;
  myColor: KbLibraryColor | null;
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
  lifecycleState: DocumentLifecycleState;
  scanStatus: string;
  findings: SecurityFinding[];
  classification: Classification;
  sourceName: string | null;
  sourceOriginUri: string | null;
  sourceOwner: string | null;
  uploadedByName: string | null;
  approvedByName: string | null;
  approvalNotes: string | null;
  isActive: boolean;
  canApprove: boolean;
  canReject: boolean;
  canRevoke: boolean;
  canRescan: boolean;
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
  /** Absent on runs recorded before protected questions existed. */
  isProtected?: boolean;
}

export interface EvalSplitStat {
  total: number;
  passed: number;
  passRatePct: number | null;
}

export interface EvalSummary {
  totalQuestions: number;
  passed: number;
  failed: number;
  /** Held-out (protected) vs tunable (open) pass rates. Absent on older runs. */
  splits?: {
    protected: EvalSplitStat;
    open: EvalSplitStat;
  };
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
  /** True only when every required OIDC/PKCE server setting is present. */
  oidcEnabled: boolean;
  /** Password login posture. Fully configured OIDC defaults to super-user break-glass. */
  localLoginMode: "enabled" | "break_glass" | "disabled";
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
  role: "csr" | "supervisor" | "manager";
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
  /**
   * Present only for an account that signs in with company SSO (the
   * server's LOCAL_LOGIN_MODE does not allow local login for its role).
   * Such an account has no usable password and no tempPassword; the user
   * was emailed a link to the sign-in page when `emailSent` is true.
   */
  invitation?: { kind: "sso"; emailSent: boolean };
}

/**
 * "password_setup": each email carries a one-time link to set a password.
 * "sso": each email links to the sign-in page and says to use company SSO.
 */
export type InvitationKind = "password_setup" | "sso";

export interface BulkCreateUsersResponse {
  created: UserListItem[];
  skippedEmails: string[];
  /**
   * How many created users were emailed an invitation. No plaintext
   * password is ever returned, so the admin distributes nothing.
   */
  invitedCount: number;
  invitationKind: InvitationKind;
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
 * Teams shapes. Mirror of the api-server's routes/admin/teams.ts.
 * Active users only, sorted by name. A supervisor actor gets
 * `supervisors: [themselves]`, only their own team's CSRs, and
 * `canEdit: false`; manager and above get the whole program.
 */
export interface TeamsSupervisor {
  id: string;
  name: string;
  email: string;
}

export interface TeamsCsr {
  id: string;
  name: string;
  email: string;
  lastLoginAt: string | null;
  /** Null when the CSR has no supervisor. */
  supervisorId: string | null;
}

export interface TeamsResponse {
  supervisors: TeamsSupervisor[];
  csrs: TeamsCsr[];
  canEdit: boolean;
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

export interface SecurityDashboardResponse {
  malwareScanning: {
    enabled: boolean;
    /** End of the running bypass (24 hours after it was set); null while enforced. */
    disabledUntil: string | null;
    /** When the last bypass lapsed on its own; null if none did. */
    bypassExpiredAt: string | null;
    persistenceReady: boolean;
    disabledStatusReady: boolean;
    scannerConfigured: boolean;
    scannerTransportSecure: boolean;
    updatedAt: string | null;
    updatedByName: string | null;
    updatedByEmail: string | null;
  };
  /** Master switch for the demo-account limits; on (enabled) by default. */
  demoLimits: {
    enabled: boolean;
    persistenceReady: boolean;
    /** False when this deployment publishes no demo logins. */
    demoAccountsConfigured: boolean;
    updatedAt: string | null;
    updatedByName: string | null;
    updatedByEmail: string | null;
  };
  summary: {
    quarantined: number;
    unavailable: number;
    errors: number;
    infected: number;
    disabled: number;
    /** Parsed versions that never got an external verdict (bypass or legacy). */
    awaitingScan: number;
  };
  scans: Array<{
    versionId: string;
    title: string;
    programName: string;
    lifecycleState: string;
    scanStatus: string;
    findings: SecurityFinding[];
    occurredAt: string | null;
  }>;
  controlEvents: Array<{
    id: string;
    occurredAt: string | null;
    action: string;
    actorEmail: string | null;
    details: unknown;
  }>;
}

/** GET /api/compliance/documents (super users only). */
export interface ComplianceDocumentSummary {
  slug: string;
  title: string;
  version: string;
  /** YYYY-MM-DD */
  date: string;
  sha256: string;
  size: number;
}

export interface ComplianceDocumentListResponse {
  documents: ComplianceDocumentSummary[];
}

/** GET /api/compliance/documents/:slug (super users only). */
export interface ComplianceDocumentResponse {
  slug: string;
  title: string;
  version: string;
  date: string;
  sha256: string;
  markdown: string;
}
