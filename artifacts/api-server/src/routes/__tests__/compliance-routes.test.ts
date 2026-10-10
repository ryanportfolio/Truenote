import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { CurrentUser } from "../../lib/auth/current-user.js";
import type { SecurityEventInput } from "../../lib/security/audit.js";
import {
  InMemoryObjectStorage,
  __resetObjectStorageForTests
} from "../../lib/storage/object-storage.js";
import {
  COMPLIANCE_MANIFEST_KEY,
  complianceDocumentKey,
  sha256Hex
} from "../../lib/compliance/documents.js";
import {
  listPublicCompliancePages,
  publicCompliancePageFile
} from "../../lib/compliance/public-pages.js";

const audit = vi.hoisted(() => ({
  events: [] as SecurityEventInput[],
  fail: false
}));

vi.mock("../../lib/security/audit.js", () => ({
  recordSecurityEvent: async (input: SecurityEventInput) => {
    if (audit.fail) throw new Error("audit store unavailable");
    audit.events.push(input);
    return { id: "evt" };
  },
  recordSecurityEventBestEffort: (input: SecurityEventInput) => {
    audit.events.push(input);
  }
}));

const { complianceRouter } = await import("../compliance.js");

function userWith(role: CurrentUser["role"], overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    email: `${role}@example.com`,
    role,
    programId: null,
    name: role,
    mustResetPassword: false,
    ...overrides
  };
}

const PLAN = "# Plan of action\n\n| Item | Status |\n| --- | --- |\n| Fixture weakness | Open |\n";
const PLAN_SHA = sha256Hex(Buffer.from(PLAN, "utf8"));

let storage: InMemoryObjectStorage;
let actor: CurrentUser | null = null;
let server: Server;
let baseUrl = "";

async function seed(markdown = PLAN, manifestSha = PLAN_SHA): Promise<void> {
  await storage.put(
    COMPLIANCE_MANIFEST_KEY,
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        documents: [
          {
            slug: "plan-of-action",
            title: "Plan of action and milestones",
            version: "0.1",
            date: "2026-10-10",
            sha256: manifestSha,
            size: Buffer.byteLength(markdown)
          }
        ]
      })
    )
  );
  await storage.put(
    complianceDocumentKey({ slug: "plan-of-action", sha256: manifestSha }),
    Buffer.from(markdown, "utf8")
  );
}

async function get(pathname: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = actor;
    next();
  });
  app.use("/api/compliance", complianceRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : "error" });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __resetObjectStorageForTests();
});

beforeEach(() => {
  storage = new InMemoryObjectStorage();
  __resetObjectStorageForTests(storage);
  audit.events = [];
  audit.fail = false;
  actor = userWith("super_user");
});

describe("/api/compliance access", () => {
  it.each(["/api/compliance/documents", "/api/compliance/documents/plan-of-action"])(
    "returns 401 to a signed-out request for %s",
    async (pathname) => {
      await seed();
      actor = null;
      const result = await get(pathname);
      expect(result.status).toBe(401);
      expect(JSON.stringify(result.body)).not.toContain("Fixture weakness");
      expect(audit.events).toEqual([]);
    }
  );

  it.each(["csr", "supervisor", "manager", "senior_manager"] as const)(
    "returns 403 to a %s",
    async (role) => {
      await seed();
      actor = userWith(role);
      for (const pathname of [
        "/api/compliance/documents",
        "/api/compliance/documents/plan-of-action"
      ]) {
        const result = await get(pathname);
        expect(result.status).toBe(403);
        expect(JSON.stringify(result.body)).not.toContain("Fixture weakness");
      }
      expect(audit.events).toEqual([]);
    }
  );

  it("returns 423 to a super user who must reset their password", async () => {
    await seed();
    actor = userWith("super_user", { mustResetPassword: true });
    expect((await get("/api/compliance/documents/plan-of-action")).status).toBe(423);
  });
});

describe("/api/compliance/documents", () => {
  it("lists the manifest without storage details", async () => {
    await seed();
    const result = await get("/api/compliance/documents");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      documents: [
        {
          slug: "plan-of-action",
          title: "Plan of action and milestones",
          version: "0.1",
          date: "2026-10-10",
          sha256: PLAN_SHA,
          size: Buffer.byteLength(PLAN)
        }
      ]
    });
  });

  it("returns an empty list before anything is uploaded", async () => {
    const result = await get("/api/compliance/documents");
    expect(result).toEqual({ status: 200, body: { documents: [] } });
  });

  it("refuses a manifest that fails validation", async () => {
    await storage.put(
      COMPLIANCE_MANIFEST_KEY,
      Buffer.from(JSON.stringify({ schemaVersion: 1, documents: [{ slug: "../x" }] }))
    );
    const result = await get("/api/compliance/documents");
    expect(result.status).toBe(500);
  });
});

describe("/api/compliance/documents/:slug", () => {
  it("returns the document and records who read which version", async () => {
    await seed();
    const result = await get("/api/compliance/documents/plan-of-action");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      slug: "plan-of-action",
      title: "Plan of action and milestones",
      version: "0.1",
      date: "2026-10-10",
      sha256: PLAN_SHA,
      markdown: PLAN
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      action: "compliance.document_read",
      outcome: "success",
      actor: { id: actor!.id, email: actor!.email, role: "super_user" },
      resourceType: "compliance_document",
      resourceId: "plan-of-action",
      details: { slug: "plan-of-action", sha256: PLAN_SHA, version: "0.1" }
    });
  });

  it("returns 404 for a well-formed slug that is not in the manifest", async () => {
    await seed();
    const result = await get("/api/compliance/documents/system-security-plan");
    expect(result).toEqual({ status: 404, body: { error: "Not found" } });
    expect(audit.events).toEqual([]);
  });

  it.each([
    "Plan-Of-Action",
    "plan_of_action",
    "plan--of-action",
    "-plan",
    "plan.md",
    "..%2Fmanifest.json",
    "a".repeat(81)
  ])("rejects the malformed slug %s before reading storage", async (slug) => {
    await seed();
    const reads = vi.spyOn(storage, "get");
    const result = await get(`/api/compliance/documents/${slug}`);
    expect(result.status).toBe(400);
    expect(reads).not.toHaveBeenCalled();
    expect(audit.events).toEqual([]);
  });

  it("withholds a document whose bytes do not match the manifest hash", async () => {
    await seed("tampered text", PLAN_SHA);
    const result = await get("/api/compliance/documents/plan-of-action");
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain("tampered");
    expect(audit.events).toEqual([
      expect.objectContaining({ outcome: "failure", resourceId: "plan-of-action" })
    ]);
  });

  it("withholds the document when its read cannot be recorded", async () => {
    await seed();
    audit.fail = true;
    const result = await get("/api/compliance/documents/plan-of-action");
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain("Fixture weakness");
  });
});

describe("public compliance page lookup", () => {
  const dist = mkdtempSync(path.join(tmpdir(), "compliance-pages-"));
  mkdirSync(path.join(dist, "security", "compliance", "overview"), { recursive: true });
  writeFileSync(path.join(dist, "security", "compliance", "overview", "index.html"), "<p>ok</p>");
  mkdirSync(path.join(dist, "security", "compliance", "Bad_Name"), { recursive: true });
  writeFileSync(path.join(dist, "security", "compliance", "Bad_Name", "index.html"), "<p>no</p>");
  mkdirSync(path.join(dist, "security", "compliance", "empty"), { recursive: true });
  const pages = listPublicCompliancePages(dist);
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  it("returns the built page for a known slug", () => {
    expect([...pages.keys()]).toEqual(["overview"]);
    expect(publicCompliancePageFile(pages, "overview")).toBe(
      path.join(dist, "security", "compliance", "overview", "index.html")
    );
  });

  it.each(["missing", "..", "../security", "styles.css", "Overview", "Bad_Name", "empty", "", undefined])(
    "returns null for %s",
    (slug) => {
      expect(publicCompliancePageFile(pages, slug)).toBeNull();
    }
  );
});
