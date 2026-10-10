import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_REQUEST_HEADER,
  getObservability,
  listDocuments,
  listErrors,
  listEvalRuns,
  SESSION_EXPIRED_EVENT,
  UnauthorizedError,
  type RequestOptions
} from "@/lib/api";

const fetchMock = vi.fn();
let sessionExpired = 0;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function sentHeaders(): Headers {
  const [, init] = fetchMock.mock.calls[0]!;
  return new Headers((init as RequestInit).headers);
}

beforeEach(() => {
  sessionExpired = 0;
  const win = Object.assign(new EventTarget(), {
    localStorage: { getItem: () => null }
  });
  win.addEventListener(SESSION_EXPIRED_EVENT, () => {
    sessionExpired += 1;
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const helpers: Array<[string, (options?: RequestOptions) => Promise<unknown>]> = [
  ["listErrors", (options) => listErrors({ hours: 24 }, options)],
  ["getObservability", (options) => getObservability(24, options)],
  ["listEvalRuns", (options) => listEvalRuns(options)],
  ["listDocuments", (options) => listDocuments(options)]
];

describe("background request header", () => {
  it("matches the api-server header name", () => {
    expect(BACKGROUND_REQUEST_HEADER).toBe("X-Truenote-Background");
  });

  it.each(helpers)("%s omits the header by default", async (_name, call) => {
    fetchMock.mockResolvedValueOnce(reply(200, { items: [] }));
    await call();
    expect(sentHeaders().has(BACKGROUND_REQUEST_HEADER)).toBe(false);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe("include");
  });

  it.each(helpers)("%s omits the header when background is false", async (_name, call) => {
    fetchMock.mockResolvedValueOnce(reply(200, { items: [] }));
    await call({ background: false });
    expect(sentHeaders().has(BACKGROUND_REQUEST_HEADER)).toBe(false);
  });

  it.each(helpers)("%s sends the header when asked", async (_name, call) => {
    fetchMock.mockResolvedValueOnce(reply(200, { items: [] }));
    await call({ background: true });
    expect(sentHeaders().get(BACKGROUND_REQUEST_HEADER)).toBe("1");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe("include");
  });

  it("keeps the request's query parameters with the object options", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { items: [] }));
    await getObservability(168, { limit: 5, background: true });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admin/observability?hours=168&limit=5");
    fetchMock.mockResolvedValueOnce(reply(200, { items: [] }));
    await listEvalRuns({ limit: 7 });
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/admin/evaluations/runs?limit=7");
  });

  it("treats a 401 on a background request as an expired session", async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { error: "Unauthorized" }));
    await expect(listErrors({ hours: 24 }, { background: true })).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    expect(sessionExpired).toBe(1);
  });
});
