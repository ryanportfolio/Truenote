import { afterEach, describe, expect, it, vi } from "vitest";
import { callLandingParse, parseLandingResponse } from "../landing-parse.js";

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Builds a fetch stub that returns the queued responses in order (one per
 * call) and records every request for assertion.
 */
function stubFetch(
  responses: Response[],
  captured: CapturedRequest[]
): typeof fetch {
  let call = 0;
  return (async (url: string | URL, init?: RequestInit) => {
    captured.push({ url: String(url), init });
    const response = responses[call] ?? responses[responses.length - 1];
    call += 1;
    return response;
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const OK_BODY = {
  markdown: "# Refund Policy\n\nThe cancellation fee is $25.",
  metadata: { page_count: 2, model_version: "dpt-3-pro-latest" }
};

afterEach(() => {
  vi.useRealTimers();
});

describe("parseLandingResponse", () => {
  it("extracts markdown, page count, and model version", () => {
    const result = parseLandingResponse(OK_BODY);
    expect(result.markdown).toBe("# Refund Policy\n\nThe cancellation fee is $25.");
    expect(result.pageCount).toBe(2);
    expect(result.model).toBe("dpt-3-pro-latest");
  });

  it("defaults page count and model when metadata is absent", () => {
    const result = parseLandingResponse({ markdown: "hello" });
    expect(result.pageCount).toBe(0);
    expect(result.model).toBe("dpt-3-pro-latest");
  });

  it("throws when markdown is missing", () => {
    expect(() => parseLandingResponse({ metadata: {} })).toThrow(/markdown/);
  });

  it("throws when markdown is empty or whitespace only", () => {
    expect(() => parseLandingResponse({ markdown: "   " })).toThrow(/markdown/);
  });

  it("throws when the body is not an object", () => {
    expect(() => parseLandingResponse("nope")).toThrow(/not an object/);
  });
});

describe("callLandingParse", () => {
  it("sends bearer auth plus the document and model multipart fields", async () => {
    const captured: CapturedRequest[] = [];
    const fetchImpl = stubFetch([jsonResponse(OK_BODY)], captured);

    const result = await callLandingParse(Buffer.from("%PDF-1.7 fake"), "application/pdf", {
      apiKey: "test-key",
      fetchImpl
    });

    expect(result.markdown).toContain("cancellation fee");
    expect(captured).toHaveLength(1);
    const { init } = captured[0]!;
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("dpt-3-pro-latest");
    expect(form.get("document")).toBeInstanceOf(Blob);
  });

  it("throws when the API key is missing", async () => {
    const previous = process.env.VISION_AGENT_API_KEY;
    delete process.env.VISION_AGENT_API_KEY;
    try {
      await expect(
        callLandingParse(Buffer.from("x"), "image/png", { fetchImpl: stubFetch([], []) })
      ).rejects.toThrow(/VISION_AGENT_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.VISION_AGENT_API_KEY = previous;
    }
  });

  it("retries once on a 429 then succeeds", async () => {
    vi.useFakeTimers();
    const captured: CapturedRequest[] = [];
    const fetchImpl = stubFetch(
      [new Response("rate limited", { status: 429 }), jsonResponse(OK_BODY)],
      captured
    );

    const promise = callLandingParse(Buffer.from("x"), "image/png", {
      apiKey: "k",
      fetchImpl,
      maxRetries: 1
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;

    expect(result.pageCount).toBe(2);
    expect(captured).toHaveLength(2);
  });

  it("throws on a non-retryable 400 with a body snippet", async () => {
    const fetchImpl = stubFetch(
      [new Response("unsupported file", { status: 400 })],
      []
    );
    await expect(
      callLandingParse(Buffer.from("x"), "image/png", { apiKey: "k", fetchImpl })
    ).rejects.toThrow(/HTTP 400: unsupported file/);
  });

  it("rejects immediately on an already-aborted signal without calling fetch", async () => {
    const captured: CapturedRequest[] = [];
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      callLandingParse(Buffer.from("x"), "image/png", {
        apiKey: "k",
        fetchImpl: stubFetch([jsonResponse(OK_BODY)], captured),
        signal: controller.signal
      })
    ).rejects.toThrow(/cancelled/);
    expect(captured).toHaveLength(0);
  });
});
