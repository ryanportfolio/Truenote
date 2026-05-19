import type {
  AskResponse,
  CurrentUser,
  DocumentListResponse,
  PreviewResponse,
  UploadResponse
} from "@/types/api";

/**
 * Thin fetch wrappers. Vite proxies /api → the Express api-server (see
 * vite.config.ts). In production the same path-relative URL is served by the
 * platform's reverse proxy, so no env-driven base URL is needed.
 */

async function asJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status}: ${body.slice(0, 500) || response.statusText}`
    );
  }
  return (await response.json()) as T;
}

export async function fetchMe(): Promise<CurrentUser> {
  const response = await fetch("/api/me");
  const json = await asJson<{ user: CurrentUser }>(response);
  return json.user;
}

export async function askQuestion(question: string): Promise<AskResponse> {
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question })
  });
  return asJson<AskResponse>(response);
}

export async function submitFeedback(queryLogId: string, feedback: -1 | 0 | 1): Promise<void> {
  await fetch("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queryLogId, feedback })
  });
}

export async function listDocuments(): Promise<DocumentListResponse> {
  const response = await fetch("/api/documents");
  return asJson<DocumentListResponse>(response);
}

export async function uploadDocument(formData: FormData): Promise<UploadResponse> {
  const response = await fetch("/api/documents/upload", {
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
  const response = await fetch(`/api/documents/${encodeURIComponent(versionId)}/preview`);
  return asJson<PreviewResponse>(response);
}

export async function deleteDocument(documentId: string): Promise<void> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
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
