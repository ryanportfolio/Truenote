import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  contentSecurityPolicy,
  trustedMutationOriginMiddleware,
} from "../browser-security.js";

interface RunResult {
  nextCalled: boolean;
  statusCode: number | null;
  body: unknown;
}

function request(
  method: string,
  headers: Record<string, string> = {},
  protocol = "https",
): Request {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    method,
    protocol,
    get(name: string) {
      return normalized[name.toLowerCase()];
    },
  } as unknown as Request;
}

function run(
  method: string,
  headers: Record<string, string>,
  env: NodeJS.ProcessEnv,
  protocol = "https",
): RunResult {
  const state: RunResult = {
    nextCalled: false,
    statusCode: null,
    body: null,
  };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    state.nextCalled = true;
  };
  trustedMutationOriginMiddleware(env)(
    request(method, headers, protocol),
    res,
    next,
  );
  return state;
}

describe("trustedMutationOriginMiddleware", () => {
  const production = {
    NODE_ENV: "production",
    APP_BASE_URL: "https://truenote.org/app",
  };

  it("allows safe methods regardless of Origin", () => {
    expect(
      run("GET", { origin: "https://evil.example" }, production).nextCalled,
    ).toBe(true);
  });

  it("allows a configured same-origin mutation", () => {
    expect(
      run("POST", { origin: "https://truenote.org" }, production).nextCalled,
    ).toBe(true);
  });

  it("allows an explicitly configured credentialed CORS origin", () => {
    const result = run(
      "PATCH",
      { origin: "https://csr.company.example" },
      {
        ...production,
        CORS_ALLOWED_ORIGINS:
          "https://csr.company.example, https://admin.company.example",
      },
    );
    expect(result.nextCalled).toBe(true);
  });

  it("rejects foreign, opaque, and malformed Origin values", () => {
    for (const origin of [
      "https://evil.example",
      "null",
      "not an origin",
      "javascript:alert(1)",
    ]) {
      const result = run("DELETE", { origin }, production);
      expect(result.nextCalled).toBe(false);
      expect(result.statusCode).toBe(403);
      expect(result.body).toEqual({
        error: "Request origin is not allowed.",
        code: "csrf_origin_rejected",
      });
    }
  });

  it("rejects browser mutations from cross-site and same-site siblings", () => {
    for (const fetchSite of ["cross-site", "same-site"]) {
      const result = run(
        "POST",
        { "sec-fetch-site": fetchSite },
        production,
      );
      expect(result.statusCode).toBe(403);
      expect(result.nextCalled).toBe(false);
    }
  });

  it("allows same-origin browser requests and non-browser automation without Origin", () => {
    expect(
      run("POST", { "sec-fetch-site": "same-origin" }, production).nextCalled,
    ).toBe(true);
    expect(run("POST", {}, production).nextCalled).toBe(true);
  });

  it("derives the public request origin only outside production", () => {
    const headers = {
      origin: "https://dev-truenote.replit.dev",
      host: "localhost:3001",
      "x-forwarded-host": "dev-truenote.replit.dev",
      "x-forwarded-proto": "https",
    };
    expect(run("POST", headers, { NODE_ENV: "development" }).nextCalled).toBe(
      true,
    );
    expect(run("POST", headers, { NODE_ENV: "production" }).statusCode).toBe(
      403,
    );
  });
});

describe("contentSecurityPolicy", () => {
  it("locks active content to self while preserving required inline style attributes", () => {
    const policy = contentSecurityPolicy("production");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
    expect(policy).toContain("upgrade-insecure-requests");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("contains the exact LF and CRLF hashes of the source JSON-LD block", async () => {
    const indexPath = fileURLToPath(
      new URL("../../../../rag-app/index.html", import.meta.url),
    );
    const html = await readFile(indexPath, "utf8");
    const body = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    )?.[1];
    expect(body).toBeDefined();
    const variants = new Set([
      (body ?? "").replace(/\r\n/g, "\n"),
      (body ?? "").replace(/\r?\n/g, "\r\n"),
    ]);
    for (const variant of variants) {
      const hash = createHash("sha256").update(variant).digest("base64");
      expect(contentSecurityPolicy("production")).toContain(
        `'sha256-${hash}'`,
      );
    }
  });

  it("does not upgrade local development requests", () => {
    expect(contentSecurityPolicy("development")).not.toContain(
      "upgrade-insecure-requests",
    );
  });
});
