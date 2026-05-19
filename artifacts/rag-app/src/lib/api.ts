import type {
  AskResponse,
  ChangePasswordResponse,
  CurrentUser,
  DocumentListResponse,
  LoginResponse,
  PreviewResponse,
  UploadResponse
} from "@/types/api";

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

const fetchOptions: RequestInit = { credentials: "include" };

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

async function asJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) throw new UnauthorizedError();
    const body = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status}: ${body.slice(0, 500) || response.statusText}`
    );
  }
  return (await response.json()) as T;
}

/**
 * Fetch the current user, or return null if the request is
 * unauthenticated. Distinct from network errors (which still throw) so
 * the App router can deterministically branch to /login on null.
 */
export async function fetchMe(): Promise<CurrentUser | null> {
  const response = await fetch("/api/me", fetchOptions);
  if (response.status === 401) return null;
  const json = await asJson<{ user: CurrentUser }>(response);
  return json.user;
}

export async function login(
  email: string,
  password: string
): Promise<CurrentUser> {
  const response = await fetch("/api/auth/login", {
    ...fetchOptions,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
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
  await fetch("/api/auth/logout", { ...fetchOptions, method: "POST" });
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<CurrentUser> {
  const response = await fetch("/api/auth/change-password", {
    ...fetchOptions,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword })
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  const json = (await response.json()) as ChangePasswordResponse;
  return json.user;
}

export async function askQuestion(question: string): Promise<AskResponse> {
  const response = await fetch("/api/ask", {
    ...fetchOptions,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question })
  });
  return asJson<AskResponse>(response);
}

export async function submitFeedback(queryLogId: string, feedback: -1 | 0 | 1): Promise<void> {
  await fetch("/api/feedback", {
    ...fetchOptions,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queryLogId, feedback })
  });
}

export async function listDocuments(): Promise<DocumentListResponse> {
  const response = await fetch("/api/documents", fetchOptions);
  return asJson<DocumentListResponse>(response);
}

export async function uploadDocument(formData: FormData): Promise<UploadResponse> {
  const response = await fetch("/api/documents/upload", {
    ...fetchOptions,
    method: "POST",
    body: formData
  });
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
    fetchOptions
  );
  return asJson<PreviewResponse>(response);
}

export async function deleteDocument(documentId: string): Promise<void> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
    ...fetchOptions,
    method: "DELETE"
  });
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
