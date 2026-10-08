import type {
  AppConfig,
  AskHistoryTurn,
  AskResponse,
  AskStage,
  BulkCreateUsersResponse,
  ChangePasswordResponse,
  CreateUserRequest,
  CreateUserResponse,
  CurrentUser,
  CreateKbCategoryRequest,
  CreateKbHighlightRequest,
  CreateKbTagRequest,
  DocumentListResponse,
  KbCategory,
  KbColorLabel,
  KbLibraryColor,
  KbSourceUserState,
  KbTag,
  SourceUsageQuestionsResponse,
  SourceUsageResponse,
  UpdateKbCategoryRequest,
  UpdateKbTagRequest,
  EvalQuestionItem,
  EvalQuestionListResponse,
  EvalRunDetailResponse,
  EvalRunListItem,
  EvalRunListResponse,
  ErrorLogResponse,
  ErrorLogSeverity,
  SaveEvalQuestionRequest,
  KbDocumentListResponse,
  KbDocumentResponse,
  KbGapsResponse,
  KbHighlight,
  KbHighlightColor,
  KbHighlightListResponse,
  LoginResponse,
  ModelRoutingConfig,
  ObservabilityResponse,
  PreviewResponse,
  Program,
  ProgramListResponse,
  QueryLogFilter,
  QueryLogListResponse,
  ResetPasswordResponse,
  SecurityDashboardResponse,
  SessionDetailResponse,
  SessionListResponse,
  ResetUserPasswordResponse,
  UpdateUserRequest,
  UploadResponse,
  UserListItem,
  UserListResponse
} from "@/types/api";
import { getSelectedProgramIdRaw } from "@/lib/selectedProgram";

/**
 * Thin fetch wrappers. Vite proxies /api → the Express api-server (see
 * vite.config.ts). In production the same path-relative URL is served by
 * the platform's reverse proxy, so no env-driven base URL is needed.
 *
 * `credentials: "include"` is the default for same-origin requests but is
 * REQUIRED here because Vite's dev proxy presents a different origin to
 * the browser; without it, the session cookie isn't sent and every
 * authenticated request 401s.
 */

/**
 * Build a RequestInit with cookies + the X-Program-Id header (when a
 * super_user has selected a program). Non-super_user roles also get
 * the header sent if something happens to write to the storage slot;
 * the server silently ignores it for them, so this is safe.
 *
 * Pass any caller-provided init through — headers from the caller
 * win so a Content-Type override (e.g. multipart for upload) keeps
 * the right Content-Type the browser builds for FormData.
 */
function withDefaults(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  const programId = getSelectedProgramIdRaw();
  if (programId !== null && !headers.has("X-Program-Id")) {
    headers.set("X-Program-Id", programId);
  }
  return {
    ...init,
    credentials: "include",
    headers
  };
}

/**
 * Distinct error so callers can branch on "I need to redirect to /login"
 * vs a generic network failure. The fetchMe call uses this to return null
 * cleanly; other calls bubble it up.
 */
export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/**
 * Fired whenever any authenticated API call comes back 401 — typically a
 * mid-shift session expiry. App.tsx listens for this and flips the auth
 * state machine back to "unauthenticated," which re-renders the login
 * screen. Without this hook, the user sees a raw "Unauthorized" string
 * in a page-level error toast and has no path forward except a manual
 * reload.
 */
export const SESSION_EXPIRED_EVENT = "rag-csr:session-expired";

let authSession = 0;

/**
 * Changes whenever this tab's sign-in ends (logout, a 401) or a new one
 * starts. A save queued before the change checks it, so it never goes out
 * under someone else's sign-in.
 */
export function currentAuthSession(): number {
  return authSession;
}

function notifySessionExpired(): void {
  authSession += 1;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
}

async function asJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) {
      notifySessionExpired();
      throw new UnauthorizedError();
    }
    const body = await response.text().catch(() => "");
    // Server errors are JSON with a human-readable `error` field (e.g.
    // "Demo accounts can't do this"). Surface that string directly —
    // pages render err.message in their alert boxes, and a raw
    // "HTTP 403: {json}" dump there reads like a crash, not a notice.
    let message = "";
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // non-JSON body — fall through to the status-line message
    }
    throw new Error(
      message || `HTTP ${response.status}: ${body.slice(0, 500) || response.statusText}`
    );
  }
  return (await response.json()) as T;
}

/**
 * Fetch the current user, or return null if the request is
 * unauthenticated. Distinct from network errors (which still throw) so
 * the App router can deterministically branch to /login on null.
 */
/**
 * Fetch public, non-secret config (currently just minPasswordLength).
 * Called pre-auth from the change-password page so the UI mirrors the
 * server's validation floor without requiring a login round-trip.
 */
export async function fetchConfig(): Promise<AppConfig> {
  const response = await fetch("/api/config", withDefaults());
  return asJson<AppConfig>(response);
}

export async function fetchMe(): Promise<CurrentUser | null> {
  // /api/me never consumes program scope. Keep this request header-free so
  // it exactly matches index.html's credentialed fetch preload.
  const response = await fetch("/api/me", { credentials: "include" });
  if (response.status === 401) return null;
  const json = await asJson<{ user: CurrentUser }>(response);
  return json.user;
}

export async function login(
  email: string,
  password: string
): Promise<CurrentUser> {
  authSession += 1;
  const response = await fetch(
    "/api/auth/login",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    })
  );
  if (response.status === 401) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? "Invalid credentials");
  }
  const json = await asJson<LoginResponse>(response);
  return json.user;
}

export async function logout(): Promise<void> {
  authSession += 1;
  await fetch("/api/auth/logout", withDefaults({ method: "POST" }));
}

/**
 * Request a password-reset email. Returns void regardless of whether
 * the email is known — the server always 204s to avoid leaking which
 * emails have accounts. Network errors still throw so the form can
 * show "couldn't reach the server", which is distinct from "ok we'll
 * send a link if you have an account."
 *
 * Schema failures (400) surface the server's JSON `{ error: "..." }`
 * body rather than the raw HTTP status text — matches the pattern
 * every other client wrapper here uses, so the UI shows e.g.
 * "Invalid request" instead of "HTTP 400: Bad Request".
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const response = await fetch(
    "/api/auth/forgot-password",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    })
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
}

/**
 * Consume a reset link and set a new password. On success the server
 * sets the session cookie and returns the user payload — the SPA can
 * route straight into the app without a follow-up login.
 */
export async function consumeResetToken(
  token: string,
  newPassword: string
): Promise<CurrentUser> {
  const response = await fetch(
    "/api/auth/reset-password",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword })
    })
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  const json = (await response.json()) as ResetPasswordResponse;
  return json.user;
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<CurrentUser> {
  const response = await fetch(
    "/api/auth/change-password",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword })
    })
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  const json = (await response.json()) as ChangePasswordResponse;
  return json.user;
}

export async function askQuestion(
  question: string,
  history: AskHistoryTurn[] = [],
  sessionId: string | null = null
): Promise<AskResponse> {
  const response = await fetch(
    "/api/ask",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history, sessionId: sessionId ?? undefined })
    })
  );
  return asJson<AskResponse>(response);
}

/**
 * Streaming ask: consumes /api/ask/stream NDJSON. Stage events fire at
 * real pipeline checkpoints while the CSR waits; the complete answer
 * arrives atomically in the final "result" event (no token streaming —
 * CSRs need the whole answer before they speak).
 */
export async function askQuestionStream(
  question: string,
  history: AskHistoryTurn[],
  onStage: (stage: AskStage) => void,
  signal?: AbortSignal,
  sessionId: string | null = null
): Promise<AskResponse> {
  const response = await fetch(
    "/api/ask/stream",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history, sessionId: sessionId ?? undefined }),
      signal
    })
  );
  if (!response.ok || !response.body) {
    if (response.status === 401) {
      notifySessionExpired();
      throw new UnauthorizedError();
    }
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}: ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AskResponse | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      const event = JSON.parse(line) as
        | { type: "stage"; stage: AskStage }
        | { type: "result"; result: AskResponse }
        | { type: "error"; message: string };
      if (event.type === "stage") {
        onStage(event.stage);
      } else if (event.type === "result") {
        result = event.result;
      } else {
        throw new Error(event.message);
      }
    }
  }
  if (!result) throw new Error("The answer stream ended early. Try again.");
  return result;
}

/**
 * CSR marks a refusal as "the knowledge base should have had this."
 * Feeds the admin content-gaps queue (query_log.flagged_missing).
 */
export async function flagMissingContent(queryLogId: string): Promise<void> {
  const response = await fetch(
    "/api/flag-missing",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queryLogId })
    })
  );
  await asJson<{ ok: boolean }>(response);
}

export async function submitFeedback(queryLogId: string, feedback: -1 | 0 | 1): Promise<void> {
  await fetch(
    "/api/feedback",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queryLogId, feedback })
    })
  );
}

export async function listDocuments(): Promise<DocumentListResponse> {
  const response = await fetch("/api/documents", withDefaults());
  return asJson<DocumentListResponse>(response);
}

/** The CSR's own chat sessions, newest first, scoped to the effective program. */
export async function listSessions(): Promise<SessionListResponse> {
  const response = await fetch("/api/sessions", withDefaults());
  return asJson<SessionListResponse>(response);
}

/** One past session with its reconstructed exchanges. Throws on 404 (not owned / wrong program). */
export async function getSession(sessionId: string): Promise<SessionDetailResponse> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    withDefaults()
  );
  return asJson<SessionDetailResponse>(response);
}

/** CSR-facing knowledge base: browsable list of live (active + parsed) docs. */
export async function listKbDocuments(): Promise<KbDocumentListResponse> {
  const response = await fetch("/api/kb/documents", withDefaults());
  return asJson<KbDocumentListResponse>(response);
}

/** Full parsed markdown of one live document. Throws on 404 (wrong program / not live). */
export async function getKbDocument(
  documentId: string,
  citation?: { versionId: string; queryLogId?: string; sourceIndex?: number }
): Promise<KbDocumentResponse> {
  const params = new URLSearchParams();
  if (citation) {
    params.set("version", citation.versionId);
    if (citation.queryLogId !== undefined) params.set("query", citation.queryLogId);
    if (citation.sourceIndex !== undefined) {
      params.set("source", String(citation.sourceIndex));
    }
  }
  const search = params.toString();
  const suffix = search ? `?${search}` : "";
  const response = await fetch(
    `/api/kb/documents/${encodeURIComponent(documentId)}${suffix}`,
    withDefaults()
  );
  return asJson<KbDocumentResponse>(response);
}

/** Personal highlights for the active parsed version of one scoped document. */
export async function listKbHighlights(
  documentId: string
): Promise<KbHighlightListResponse> {
  const response = await fetch(
    `/api/kb/documents/${encodeURIComponent(documentId)}/highlights`,
    withDefaults()
  );
  return asJson<KbHighlightListResponse>(response);
}

export async function createKbHighlight(
  documentId: string,
  payload: CreateKbHighlightRequest
): Promise<KbHighlight> {
  const response = await fetch(
    `/api/kb/documents/${encodeURIComponent(documentId)}/highlights`,
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
  const json = await asJson<{ item: KbHighlight }>(response);
  return json.item;
}

export async function updateKbHighlight(
  highlightId: string,
  color: KbHighlightColor
): Promise<KbHighlight> {
  const response = await fetch(
    `/api/kb/highlights/${encodeURIComponent(highlightId)}`,
    withDefaults({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color })
    })
  );
  const json = await asJson<{ item: KbHighlight }>(response);
  return json.item;
}

export async function deleteKbHighlight(highlightId: string): Promise<void> {
  const response = await fetch(
    `/api/kb/highlights/${encodeURIComponent(highlightId)}`,
    withDefaults({ method: "DELETE" })
  );
  await asJson<{ ok: true }>(response);
}

export async function fetchKbGaps(windowDays: number): Promise<KbGapsResponse> {
  const response = await fetch(
    `/api/admin/insights/kb-gaps?days=${encodeURIComponent(windowDays)}`,
    withDefaults()
  );
  return asJson<KbGapsResponse>(response);
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return withDefaults({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export interface AskExamples {
  questions: string[];
  /** False when the program uses the built-in defaults. */
  custom: boolean;
}

/** Example questions shown on the empty Ask page for the current program. */
export async function fetchAskExamples(): Promise<AskExamples> {
  const response = await fetch("/api/ask-examples", withDefaults());
  return asJson<AskExamples>(response);
}

/**
 * Replace the program's example questions (manager+). An empty list restores
 * the defaults. Max 6. `programId` pins the write to the program whose list
 * was edited, whatever is selected by the time the request goes out.
 */
export async function saveAskExamples(
  questions: string[],
  programId: string | null
): Promise<AskExamples> {
  const init = jsonRequest("PUT", { questions });
  if (programId !== null) (init.headers as Headers).set("X-Program-Id", programId);
  const response = await fetch("/api/ask-examples", init);
  return asJson<AskExamples>(response);
}

/** Personal pin. Allowed for every role, demo accounts included. */
export async function setKbPin(
  documentId: string,
  pinned: boolean
): Promise<KbSourceUserState> {
  const response = await fetch(
    `/api/kb/documents/${encodeURIComponent(documentId)}/pin`,
    jsonRequest("PUT", { pinned })
  );
  const json = await asJson<{ item: KbSourceUserState }>(response);
  return json.item;
}

/** Private note. An empty or whitespace-only note deletes it. Max 4000 chars. */
export async function setKbNote(
  documentId: string,
  note: string
): Promise<KbSourceUserState> {
  const response = await fetch(
    `/api/kb/documents/${encodeURIComponent(documentId)}/note`,
    jsonRequest("PUT", { note })
  );
  const json = await asJson<{ item: KbSourceUserState }>(response);
  return json.item;
}

/** Private color label on a source (null clears it). Allowed for every role, demo included. */
/** Name one of the current user's colors; a null or blank name removes it. */
export async function setKbColorLabel(
  color: KbLibraryColor,
  name: string | null
): Promise<KbColorLabel | null> {
  const response = await fetch(
    `/api/kb/labels/${encodeURIComponent(color)}`,
    jsonRequest("PUT", { name })
  );
  const json = await asJson<{ item: KbColorLabel | null }>(response);
  return json.item;
}

export async function setKbSourceColor(
  documentId: string,
  color: KbLibraryColor | null
): Promise<KbSourceUserState> {
  const response = await fetch(
    `/api/kb/documents/${encodeURIComponent(documentId)}/color`,
    jsonRequest("PUT", { color })
  );
  const json = await asJson<{ item: KbSourceUserState }>(response);
  return json.item;
}

/** Private override of a category's team color (null resets to the team color). Every role, demo included. */
export async function setKbCategoryColor(
  categoryId: string,
  color: KbLibraryColor | null
): Promise<{ categoryId: string; myColor: KbLibraryColor | null }> {
  const response = await fetch(
    `/api/kb/categories/${encodeURIComponent(categoryId)}/color`,
    jsonRequest("PUT", { color })
  );
  const json = await asJson<{ item: { categoryId: string; myColor: KbLibraryColor | null } }>(
    response
  );
  return json.item;
}

// Library organization (manager+, not demo). All scoped to the effective program.

export async function createKbCategory(
  payload: CreateKbCategoryRequest
): Promise<KbCategory> {
  const response = await fetch("/api/kb/library/categories", jsonRequest("POST", payload));
  const json = await asJson<{ item: KbCategory }>(response);
  return json.item;
}

export async function updateKbCategory(
  categoryId: string,
  payload: UpdateKbCategoryRequest
): Promise<KbCategory> {
  const response = await fetch(
    `/api/kb/library/categories/${encodeURIComponent(categoryId)}`,
    jsonRequest("PATCH", payload)
  );
  const json = await asJson<{ item: KbCategory }>(response);
  return json.item;
}

/** Deletes the category. Its child categories move up to its parent; documents stay in the library. */
export async function deleteKbCategory(categoryId: string): Promise<void> {
  const response = await fetch(
    `/api/kb/library/categories/${encodeURIComponent(categoryId)}`,
    withDefaults({ method: "DELETE" })
  );
  await asJson<{ ok: true }>(response);
}

/** Reorder the children of one parent (null = top level). orderedIds must be exactly those siblings. */
export async function reorderKbCategories(
  parentId: string | null,
  orderedIds: string[]
): Promise<void> {
  const response = await fetch(
    "/api/kb/library/categories/order",
    jsonRequest("PUT", { parentId, orderedIds })
  );
  await asJson<{ ok: true }>(response);
}

/** Replace a category's members with this ordered list (add, remove, and reorder in one call). */
export async function setKbCategoryDocuments(
  categoryId: string,
  documentIds: string[]
): Promise<KbCategory> {
  const response = await fetch(
    `/api/kb/library/categories/${encodeURIComponent(categoryId)}/documents`,
    jsonRequest("PUT", { documentIds })
  );
  const json = await asJson<{ item: KbCategory }>(response);
  return json.item;
}

/** Replace the set of categories one document belongs to. New memberships append at the end. */
export async function setKbDocumentCategories(
  documentId: string,
  categoryIds: string[]
): Promise<void> {
  const response = await fetch(
    `/api/kb/library/documents/${encodeURIComponent(documentId)}/categories`,
    jsonRequest("PUT", { categoryIds })
  );
  await asJson<{ ok: true }>(response);
}

export async function createKbTag(payload: CreateKbTagRequest): Promise<KbTag> {
  const response = await fetch("/api/kb/library/tags", jsonRequest("POST", payload));
  const json = await asJson<{ item: KbTag }>(response);
  return json.item;
}

export async function updateKbTag(
  tagId: string,
  payload: UpdateKbTagRequest
): Promise<KbTag> {
  const response = await fetch(
    `/api/kb/library/tags/${encodeURIComponent(tagId)}`,
    jsonRequest("PATCH", payload)
  );
  const json = await asJson<{ item: KbTag }>(response);
  return json.item;
}

export async function deleteKbTag(tagId: string): Promise<void> {
  const response = await fetch(
    `/api/kb/library/tags/${encodeURIComponent(tagId)}`,
    withDefaults({ method: "DELETE" })
  );
  await asJson<{ ok: true }>(response);
}

/** Replace the set of tags on one document. */
export async function setKbDocumentTags(
  documentId: string,
  tagIds: string[]
): Promise<void> {
  const response = await fetch(
    `/api/kb/library/documents/${encodeURIComponent(documentId)}/tags`,
    jsonRequest("PUT", { tagIds })
  );
  await asJson<{ ok: true }>(response);
}

/**
 * Replace the team-pinned list with this ordered list (empty array clears it).
 * Max 12. `programId` pins the write to the program whose list was edited,
 * whatever is selected by the time the request goes out.
 */
export async function setKbFeatured(documentIds: string[], programId: string | null): Promise<void> {
  const init = jsonRequest("PUT", { documentIds });
  if (programId !== null) (init.headers as Headers).set("X-Program-Id", programId);
  const response = await fetch("/api/kb/library/featured", init);
  await asJson<{ ok: true }>(response);
}

export async function fetchSourceUsage(params: {
  windowDays: number;
  userId?: string | null;
}): Promise<SourceUsageResponse> {
  const search = new URLSearchParams({ days: String(params.windowDays) });
  if (params.userId) search.set("userId", params.userId);
  const response = await fetch(
    `/api/admin/insights/source-usage?${search.toString()}`,
    withDefaults()
  );
  return asJson<SourceUsageResponse>(response);
}

/** Questions behind the usage numbers, newest first. Filter by source, user, or both. Max 200. */
export async function fetchSourceUsageQuestions(params: {
  windowDays: number;
  userId?: string | null;
  documentId?: string | null;
  limit?: number;
}): Promise<SourceUsageQuestionsResponse> {
  const search = new URLSearchParams({ days: String(params.windowDays) });
  if (params.userId) search.set("userId", params.userId);
  if (params.documentId) search.set("documentId", params.documentId);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  const response = await fetch(
    `/api/admin/insights/source-usage/questions?${search.toString()}`,
    withDefaults()
  );
  return asJson<SourceUsageQuestionsResponse>(response);
}

export async function uploadDocument(formData: FormData): Promise<UploadResponse> {
  const response = await fetch(
    "/api/documents/upload",
    // Do NOT set Content-Type — the browser builds the multipart
    // boundary header from the FormData. withDefaults() leaves it
    // untouched when not explicitly provided.
    withDefaults({ method: "POST", body: formData })
  );
  // The upload endpoint always returns JSON (success or error), even on 4xx.
  // Parse regardless of status so callers see the error message.
  try {
    return (await response.json()) as UploadResponse;
  } catch {
    return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
  }
}

export async function getDocumentPreview(versionId: string): Promise<PreviewResponse> {
  const response = await fetch(
    `/api/documents/${encodeURIComponent(versionId)}/preview`,
    withDefaults()
  );
  return asJson<PreviewResponse>(response);
}

async function documentControlAction(
  versionId: string,
  action: "approve" | "reject" | "revoke" | "rescan",
  body?: object
): Promise<void> {
  const response = await fetch(
    `/api/documents/${encodeURIComponent(versionId)}/${action}`,
    withDefaults({
      method: "POST",
      ...(body
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {})
    })
  );
  await asJson<{ ok: true }>(response);
}

export function approveDocumentVersion(
  versionId: string,
  input: { notes: string; acknowledgeFindings: boolean }
): Promise<void> {
  return documentControlAction(versionId, "approve", input);
}

export function rejectDocumentVersion(versionId: string, reason: string): Promise<void> {
  return documentControlAction(versionId, "reject", { reason });
}

export function revokeDocumentVersion(versionId: string, reason: string): Promise<void> {
  return documentControlAction(versionId, "revoke", { reason });
}

export function rescanDocumentVersion(versionId: string): Promise<void> {
  return documentControlAction(versionId, "rescan");
}

export async function deleteDocument(documentId: string, reason: string): Promise<void> {
  const response = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}`,
    withDefaults({
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason })
    })
  );
  if (!response.ok) {
    // Try to surface the server's JSON error message if there is one.
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // ignore parse errors; fall through to statusText
    }
    throw new Error(detail || `HTTP ${response.status}: ${response.statusText}`);
  }
}

export async function listPrograms(): Promise<ProgramListResponse> {
  const response = await fetch("/api/admin/programs", withDefaults());
  return asJson<ProgramListResponse>(response);
}

export async function createProgram(name: string): Promise<Program> {
  const response = await fetch(
    "/api/admin/programs",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    })
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  const json = (await response.json()) as { item: Program };
  return json.item;
}

export async function getModelRouting(): Promise<ModelRoutingConfig> {
  const response = await fetch("/api/admin/model-routing", withDefaults());
  return asJson<ModelRoutingConfig>(response);
}

export async function updateModelRouting(
  order: string[]
): Promise<ModelRoutingConfig> {
  const response = await fetch(
    "/api/admin/model-routing",
    withDefaults({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order })
    })
  );
  return asJson<ModelRoutingConfig>(response);
}

export async function getObservability(
  hours: number,
  limit = 100
): Promise<ObservabilityResponse> {
  const params = new URLSearchParams({
    hours: String(hours),
    limit: String(limit)
  });
  const response = await fetch(
    `/api/admin/observability?${params.toString()}`,
    withDefaults()
  );
  return asJson<ObservabilityResponse>(response);
}

export async function listErrors(input: {
  hours: number;
  limit?: number;
  offset?: number;
  severity?: ErrorLogSeverity | "all";
  source?: string;
}): Promise<ErrorLogResponse> {
  const params = new URLSearchParams({
    hours: String(input.hours),
    limit: String(input.limit ?? 100),
    offset: String(input.offset ?? 0),
    severity: input.severity ?? "all"
  });
  if (input.source) params.set("source", input.source);
  const response = await fetch(
    `/api/admin/errors?${params.toString()}`,
    withDefaults()
  );
  return asJson<ErrorLogResponse>(response);
}

export async function clearErrorLog(): Promise<{ deletedCount: number }> {
  const response = await fetch(
    "/api/admin/errors",
    withDefaults({ method: "DELETE" })
  );
  return asJson<{ deletedCount: number }>(response);
}

export async function getSecurityDashboard(): Promise<SecurityDashboardResponse> {
  const response = await fetch("/api/admin/security", withDefaults());
  return asJson<SecurityDashboardResponse>(response);
}

export async function updateMalwareScanning(
  enabled: boolean
): Promise<SecurityDashboardResponse> {
  const response = await fetch(
    "/api/admin/security/malware-scanning",
    withDefaults({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    })
  );
  return asJson<SecurityDashboardResponse>(response);
}

/**
 * The user-admin endpoints. All authenticated, all behind the same
 * server-side capability gates (canManageUser / canAssignRole). The
 * fetch wrappers stay deliberately thin — server-side authorization is
 * the truth source; the UI mirrors visibility but doesn't pre-check.
 *
 * X-Program-Id propagation is handled by withDefaults(). For
 * super_user the list endpoint uses that header as a filter (no header
 * = all programs); other roles ignore it server-side.
 */
export async function listUsers(): Promise<UserListResponse> {
  const response = await fetch("/api/admin/users", withDefaults());
  return asJson<UserListResponse>(response);
}

/**
 * Content-gaps review list (manager+). Program scope rides X-Program-Id
 * via withDefaults(), same as every other admin list.
 */
export async function listQueryLog(
  filter: QueryLogFilter
): Promise<QueryLogListResponse> {
  const params = new URLSearchParams({ filter });
  const response = await fetch(
    `/api/admin/queries?${params.toString()}`,
    withDefaults()
  );
  return asJson<QueryLogListResponse>(response);
}

async function readJsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) {
      notifySessionExpired();
      throw new UnauthorizedError();
    }
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function createUser(
  payload: CreateUserRequest
): Promise<CreateUserResponse> {
  const response = await fetch(
    "/api/admin/users",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
  return readJsonOrThrow<CreateUserResponse>(response);
}

export async function bulkCreateUsers(
  emails: string[]
): Promise<BulkCreateUsersResponse> {
  const response = await fetch(
    "/api/admin/users/bulk",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails })
    })
  );
  return readJsonOrThrow<BulkCreateUsersResponse>(response);
}

export async function updateUser(
  id: string,
  payload: UpdateUserRequest
): Promise<UserListItem> {
  const response = await fetch(
    `/api/admin/users/${encodeURIComponent(id)}`,
    withDefaults({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
  const json = await readJsonOrThrow<{ item: UserListItem }>(response);
  return json.item;
}

export async function resetUserPassword(
  id: string
): Promise<ResetUserPasswordResponse> {
  const response = await fetch(
    `/api/admin/users/${encodeURIComponent(id)}/reset-password`,
    withDefaults({ method: "POST" })
  );
  return readJsonOrThrow<ResetUserPasswordResponse>(response);
}

/** Super-user evaluation questions for the currently selected program. */
export async function listEvalQuestions(): Promise<EvalQuestionListResponse> {
  const response = await fetch("/api/admin/evaluations/questions", withDefaults());
  return asJson<EvalQuestionListResponse>(response);
}

export async function createEvalQuestion(
  payload: SaveEvalQuestionRequest
): Promise<EvalQuestionItem> {
  const response = await fetch(
    "/api/admin/evaluations/questions",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
  return (await asJson<{ item: EvalQuestionItem }>(response)).item;
}

export async function updateEvalQuestion(
  id: string,
  payload: SaveEvalQuestionRequest
): Promise<EvalQuestionItem> {
  const response = await fetch(
    `/api/admin/evaluations/questions/${encodeURIComponent(id)}`,
    withDefaults({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
  return (await asJson<{ item: EvalQuestionItem }>(response)).item;
}

export async function deleteEvalQuestion(id: string): Promise<void> {
  const response = await fetch(
    `/api/admin/evaluations/questions/${encodeURIComponent(id)}`,
    withDefaults({ method: "DELETE" })
  );
  if (!response.ok) await asJson<never>(response);
}

export async function listEvalRuns(limit = 20): Promise<EvalRunListResponse> {
  const response = await fetch(
    `/api/admin/evaluations/runs?limit=${encodeURIComponent(limit)}`,
    withDefaults()
  );
  return asJson<EvalRunListResponse>(response);
}

export async function startEvalRun(input: {
  judge?: boolean;
  questionId?: string;
} = {}): Promise<EvalRunListItem> {
  const response = await fetch(
    "/api/admin/evaluations/runs",
    withDefaults({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    })
  );
  return (await asJson<{ item: EvalRunListItem }>(response)).item;
}

export async function getEvalRun(id: string): Promise<EvalRunDetailResponse> {
  const response = await fetch(
    `/api/admin/evaluations/runs/${encodeURIComponent(id)}`,
    withDefaults()
  );
  return asJson<EvalRunDetailResponse>(response);
}

export async function cancelEvalRun(id: string): Promise<EvalRunListItem> {
  const response = await fetch(
    `/api/admin/evaluations/runs/${encodeURIComponent(id)}/cancel`,
    withDefaults({ method: "POST" })
  );
  return (await asJson<{ item: EvalRunListItem }>(response)).item;
}

export async function setEvalBaseline(id: string): Promise<EvalRunListItem> {
  const response = await fetch(
    `/api/admin/evaluations/runs/${encodeURIComponent(id)}/baseline`,
    withDefaults({ method: "POST" })
  );
  return (await asJson<{ item: EvalRunListItem }>(response)).item;
}

/**
 * Permanently delete a user. Server returns 204 No Content on success, so
 * there's no body to parse — only decode + throw the error branch. The
 * server refuses (409) unless the target is already deactivated.
 */
export async function deleteUser(id: string): Promise<void> {
  const response = await fetch(
    `/api/admin/users/${encodeURIComponent(id)}`,
    withDefaults({ method: "DELETE" })
  );
  if (response.ok) return;
  if (response.status === 401) {
    notifySessionExpired();
    throw new UnauthorizedError();
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `HTTP ${response.status}`);
}
