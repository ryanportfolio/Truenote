import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
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
import { tokenize } from "../../lib/compliance/bm25.js";

const audit = vi.hoisted(() => ({ events: [] as SecurityEventInput[], fail: false, during: null as null | (() => Promise<void>) }));
const appErrors = vi.hoisted(() => ({ rows: [] as unknown[] }));
const sqlSeen = vi.hoisted(() => ({ queries: [] as string[] }));
const providers = vi.hoisted(() => ({
  embedCalls: [] as Array<{ kind: string; count: number }>,
  rerankCalls: 0,
  rerankFails: false,
  /** Score for a passage: overlap of question words, scaled into [0, 1]. */
  scoreScale: 1,
  duringRerank: null as null | (() => Promise<void>)
}));
const llm = vi.hoisted(() => ({ calls: 0, system: "", reply: "" as string | ((userPrompt: string) => string) }));

vi.mock("../../lib/security/audit.js", () => ({
  recordSecurityEvent: async (input: SecurityEventInput) => {
    if (audit.fail) throw new Error("audit store unavailable");
    if (audit.during) await audit.during();
    audit.events.push(input);
    return { id: "evt" };
  },
  recordSecurityEventBestEffort: (input: SecurityEventInput) => {
    audit.events.push(input);
  }
}));

vi.mock("../../lib/observability/error-log.js", () => ({
  recordAppError: async (row: unknown) => {
    appErrors.rows.push(row);
  }
}));

// Any database access is recorded; compliance answers must never read
// customer knowledge tables.
vi.mock("../../lib/db-client.js", () => ({
  db: {
    execute: async (query: unknown) => {
      sqlSeen.queries.push(JSON.stringify(query));
      return { rows: [] };
    }
  }
}));

vi.mock("../../lib/generation/model-routing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/generation/model-routing.js")>();
  return { ...actual, getActiveModelChain: async () => [actual.DEFAULT_MODEL_ROUTE] };
});

vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: async (request: { messages: Array<{ role: string; content: string }> }) => {
          llm.calls += 1;
          llm.system = request.messages.find((message) => message.role === "system")?.content ?? "";
          const user = request.messages.find((message) => message.role === "user")?.content ?? "";
          const content = typeof llm.reply === "function" ? llm.reply(user) : llm.reply;
          return { choices: [{ message: { content } }], usage: null };
        }
      }
    };
  }
}));

function bagOfWords(text: string): number[] {
  const vector = new Array(64).fill(0);
  for (const token of tokenize(text)) {
    let hash = 0;
    for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) % 64;
    vector[hash] += 1;
  }
  return vector;
}

vi.mock("../../lib/compliance/providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/compliance/providers.js")>();
  return {
    ...actual,
    embedComplianceTexts: async (texts: string[], kind: string) => {
      providers.embedCalls.push({ kind, count: texts.length });
      return texts.map(bagOfWords);
    },
    rerankComplianceTexts: async (question: string, documents: string[], topN: number) => {
      providers.rerankCalls += 1;
      if (providers.duringRerank) await providers.duringRerank();
      if (providers.rerankFails) {
        throw new actual.ComplianceProviderError("rerank", 503, "rerank returned HTTP 503");
      }
      const asked = new Set(tokenize(question));
      return documents
        .map((text, index) => {
          const words = new Set(tokenize(text));
          let shared = 0;
          for (const word of asked) if (words.has(word)) shared += 1;
          return { index, score: Math.min(1, (shared / Math.max(1, asked.size)) * providers.scoreScale) };
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, topN);
    }
  };
});

const { complianceRouter } = await import("../compliance.js");
const { resetDeadlineConfigForTests } = await import("../../lib/deadlines.js");
const { __resetComplianceSearchIndexForTests } = await import("../../lib/compliance/search-index.js");

// A fresh id per user keeps each test inside its own 10-a-minute ask budget.
let userCounter = 0;
function userWith(role: CurrentUser["role"], overrides: Partial<CurrentUser> = {}): CurrentUser {
  userCounter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(userCounter).padStart(12, "0")}`,
    email: `${role}@example.com`,
    role,
    programId: null,
    name: role,
    mustResetPassword: false,
    ...overrides
  };
}

const PLAN_V1 = [
  "# Plan of action",
  "",
  "## Access control",
  "",
  "Quarterly access reviews are performed by the security lead.",
  "",
  "## Fixture weakness",
  "",
  "| Item | Status |",
  "| --- | --- |",
  "| Fixture weakness alpha | Open |",
  ""
].join("\n");

const PLAN_V2 = PLAN_V1.replace("Quarterly access reviews", "Monthly access reviews");

const POLICY = [
  "# Incident response policy",
  "",
  "## Reporting",
  "",
  "Incidents are reported to the incident commander within one hour.",
  ""
].join("\n");

let storage: InMemoryObjectStorage;
let actor: CurrentUser | null = null;
let server: Server;
let baseUrl = "";

async function upload(documents: Array<{ slug: string; title: string; version: string; markdown: string }>): Promise<void> {
  const entries = [];
  for (const doc of documents) {
    const sha = sha256Hex(Buffer.from(doc.markdown, "utf8"));
    await storage.put(complianceDocumentKey({ slug: doc.slug, sha256: sha }), Buffer.from(doc.markdown, "utf8"));
    entries.push({
      slug: doc.slug,
      title: doc.title,
      version: doc.version,
      date: "2026-10-13",
      sha256: sha,
      size: Buffer.byteLength(doc.markdown)
    });
  }
  await storage.put(
    COMPLIANCE_MANIFEST_KEY,
    Buffer.from(JSON.stringify({ schemaVersion: 1, documents: entries }))
  );
}

const PLAN_DOC = { slug: "plan-of-action", title: "Plan of action and milestones", version: "1.0", markdown: PLAN_V1 };
const POLICY_DOC = { slug: "incident-response-policy", title: "Incident response policy", version: "1.0", markdown: POLICY };

async function ask(question: unknown): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${baseUrl}/api/compliance/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(typeof question === "string" ? { question } : question)
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text };
}

/** Cite the excerpt whose text contains `needle`, by its SOURCE token. */
function citing(needle: string, sentence: string): (userPrompt: string) => string {
  return (userPrompt) => {
    const blocks = userPrompt.split("\n\n---\n\n");
    const index = blocks.findIndex((block) => block.includes(needle));
    return index === -1 ? "no excerpt" : `${sentence} [S${index + 1}]`;
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
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

beforeEach(async () => {
  storage = new InMemoryObjectStorage();
  __resetObjectStorageForTests(storage);
  __resetComplianceSearchIndexForTests();
  audit.events = [];
  audit.fail = false;
  audit.during = null;
  appErrors.rows = [];
  sqlSeen.queries = [];
  providers.embedCalls = [];
  providers.rerankCalls = 0;
  providers.rerankFails = false;
  providers.scoreScale = 1;
  providers.duringRerank = null;
  llm.calls = 0;
  llm.reply = "";
  actor = userWith("super_user");
  await upload([PLAN_DOC, POLICY_DOC]);
});

describe("POST /api/compliance/ask access", () => {
  it("returns 401 to a signed-out request without calling a provider", async () => {
    actor = null;
    const result = await ask("How often are access reviews performed?");
    expect(result.status).toBe(401);
    expect(providers.embedCalls).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it.each(["csr", "supervisor", "manager", "senior_manager"] as const)(
    "returns 403 to a %s without calling a provider",
    async (role) => {
      actor = userWith(role);
      const result = await ask("How often are access reviews performed?");
      expect(result.status).toBe(403);
      expect(result.text).not.toContain("Fixture weakness");
      expect(providers.embedCalls).toEqual([]);
      expect(audit.events).toEqual([]);
    }
  );

  it("returns 423 to a super user who must reset their password", async () => {
    actor = userWith("super_user", { mustResetPassword: true });
    expect((await ask("How often are access reviews performed?")).status).toBe(423);
    expect(providers.embedCalls).toEqual([]);
  });

  it.each([{ question: "" }, { question: "   " }, { question: "x".repeat(1001) }, { question: 5 }, { question: "ok", programId: "x" }, {}])(
    "rejects the body %j",
    async (body) => {
      const result = await ask(body);
      expect(result.status).toBe(400);
      expect(providers.embedCalls).toEqual([]);
    }
  );
});

describe("POST /api/compliance/ask answers", () => {
  it("answers with a citation to document and section, and records the question without its text", async () => {
    llm.reply = citing("Quarterly access reviews", "Access reviews are **quarterly**, run by the security lead.");
    const question = "How often are access reviews performed?";
    const result = await ask(question);
    expect(result.status).toBe(200);
    expect(result.body.refused).toBe(false);
    expect(result.body.sources).toHaveLength(1);
    const [source] = result.body.sources;
    expect(source).toMatchObject({
      slug: "plan-of-action",
      title: "Plan of action and milestones",
      version: "1.0",
      sha256: sha256Hex(Buffer.from(PLAN_V1)),
      section: "Plan of action > Access control"
    });
    // The offsets point at the cited text in the served Markdown.
    expect(PLAN_V1.slice(source.source_start, source.source_end)).toBe(source.excerpt);
    expect(source.excerpt).toContain("Quarterly access reviews");
    expect(result.body.answer).toContain(`[${source.chunk_id}]`);
    expect(llm.system).toContain("compliance documentation assistant for Truenote");
    expect(llm.system).not.toContain("customer service");

    expect(audit.events).toHaveLength(1);
    const [event] = audit.events;
    expect(event).toMatchObject({
      action: "compliance.question",
      outcome: "success",
      actor: { id: actor!.id, role: "super_user" },
      resourceType: "compliance_question",
      details: {
        questionSha256: sha256Hex(Buffer.from(question)),
        questionLength: question.length,
        refused: false,
        cited: [{ slug: "plan-of-action", sha256: sha256Hex(Buffer.from(PLAN_V1)), version: "1.0" }]
      }
    });
    expect(JSON.stringify(audit.events)).not.toContain("access reviews");
  });

  it("refuses without calling the model when no passage clears the threshold", async () => {
    providers.scoreScale = 0.1;
    llm.reply = "should not be called [S1]";
    const result = await ask("What is the capital of France?");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      answer: "I couldn't find this in the knowledge base. Please escalate or check the source documents directly.",
      refused: true,
      sources: []
    });
    expect(llm.calls).toBe(0);
    expect(audit.events[0]).toMatchObject({ outcome: "success", details: { refused: true, cited: [] } });
  });

  it("refuses an answer without citations and keeps the answer text out of the error log", async () => {
    llm.reply = "Access reviews are quarterly, trust me.";
    const result = await ask("How often are access reviews performed?");
    expect(result.status).toBe(200);
    expect(result.body.refused).toBe(true);
    expect(result.body.sources).toEqual([]);
    expect(llm.calls).toBe(1);
    expect(JSON.stringify(appErrors.rows)).not.toContain("trust me");
    expect(JSON.stringify(appErrors.rows)).toContain("missing_inline_citation");
  });

  it("keeps prose from a malformed citation out of the error log", async () => {
    llm.reply = "Access reviews are quarterly [S1: privileged accounts have no rotation].";
    const result = await ask("How often are access reviews performed?");
    expect(result.body.refused).toBe(true);
    const logged = JSON.stringify(appErrors.rows);
    expect(logged).toContain("unknown_citation_ids");
    expect(logged).not.toContain("privileged accounts");
    expect(logged).not.toContain("quarterly");
  });

  it("refuses an answer whose figure is not in the cited excerpt", async () => {
    llm.reply = citing("Quarterly access reviews", "Access reviews happen every **90** days.");
    const result = await ask("How often are access reviews performed?");
    expect(result.body.refused).toBe(true);
  });

  it("withholds the answer when the question cannot be recorded", async () => {
    llm.reply = citing("Quarterly access reviews", "Access reviews are quarterly.");
    audit.fail = true;
    const result = await ask("How often are access reviews performed?");
    expect(result.status).toBe(500);
    expect(result.text).not.toContain("quarterly");
    expect(result.text).not.toContain("Quarterly");
  });

  it("answers 503 and gives no answer when rerank fails", async () => {
    providers.rerankFails = true;
    llm.reply = citing("Quarterly access reviews", "Access reviews are quarterly.");
    const result = await ask("How often are access reviews performed?");
    expect(result.status).toBe(503);
    expect(result.text).not.toContain("uarterly");
    expect(llm.calls).toBe(0);
    expect(audit.events).toEqual([
      expect.objectContaining({ outcome: "failure", details: expect.objectContaining({ reason: "unavailable" }) })
    ]);
  });

  it("withholds every passage when a document fails its hash check", async () => {
    const sha = sha256Hex(Buffer.from(PLAN_V1));
    await storage.put(complianceDocumentKey({ slug: "plan-of-action", sha256: sha }), Buffer.from("tampered"));
    const result = await ask("How often are access reviews performed?");
    expect(result.status).toBe(500);
    expect(providers.embedCalls).toEqual([]);
    expect(audit.events[0]).toMatchObject({ outcome: "failure", details: { reason: "hash_mismatch", slug: "plan-of-action" } });
  });
});

describe("POST /api/compliance/ask follows uploads", () => {
  it("rebuilds the index when the manifest changes and cites only the new version", async () => {
    llm.reply = citing("access reviews", "Access reviews are scheduled.");
    const first = await ask("How often are access reviews performed?");
    expect(first.body.sources[0].sha256).toBe(sha256Hex(Buffer.from(PLAN_V1)));

    await upload([{ ...PLAN_DOC, version: "1.1", markdown: PLAN_V2 }, POLICY_DOC]);
    const second = await ask("How often are access reviews performed?");
    expect(second.status).toBe(200);
    expect(second.body.sources[0]).toMatchObject({ sha256: sha256Hex(Buffer.from(PLAN_V2)), version: "1.1" });
    expect(second.text).not.toContain("Quarterly");
    // Two builds: the document passages were embedded once per manifest.
    expect(providers.embedCalls.filter((call) => call.kind === "document")).toHaveLength(2);
  });

  it("asks again instead of answering when the manifest changes mid-answer", async () => {
    llm.reply = citing("access reviews", "Access reviews are scheduled.");
    providers.duringRerank = async () => {
      providers.duringRerank = null;
      await upload([{ ...PLAN_DOC, version: "1.1", markdown: PLAN_V2 }, POLICY_DOC]);
    };
    const result = await ask("How often are access reviews performed?");
    expect(result.status).toBe(409);
    expect(result.text).not.toContain("uarterly");
    expect(audit.events).toEqual([
      expect.objectContaining({ outcome: "failure", details: expect.objectContaining({ reason: "manifest_changed" }) })
    ]);
  });

  it("asks again when an upload lands while the question is being recorded", async () => {
    llm.reply = citing("access reviews", "Access reviews are scheduled.");
    audit.during = async () => {
      audit.during = null;
      await upload([{ ...PLAN_DOC, version: "1.1", markdown: PLAN_V2 }, POLICY_DOC]);
    };
    const result = await ask("How often are access reviews performed?");
    expect(result.status).toBe(409);
    expect(result.text).not.toContain("scheduled");
    expect(audit.events.at(-1)).toMatchObject({
      outcome: "failure",
      details: { reason: "manifest_changed", stage: "after_record" }
    });
  });

  it("does not deliver an answer once the deadline passed during the record", async () => {
    llm.reply = citing("access reviews", "Access reviews are scheduled.");
    await ask("warm the index with the default deadline");
    process.env.ASK_DEADLINE_MS = "1000";
    resetDeadlineConfigForTests();
    try {
      audit.during = () => new Promise((resolve) => setTimeout(resolve, 1_500));
      const result = await ask("How often are access reviews performed?");
      expect(result.status).toBe(503);
      expect(result.text).not.toContain("scheduled");
    } finally {
      delete process.env.ASK_DEADLINE_MS;
      resetDeadlineConfigForTests();
    }
  });

  it("answers 503 at the deadline when the manifest read stalls", async () => {
    process.env.ASK_DEADLINE_MS = "1000";
    resetDeadlineConfigForTests();
    const realExists = storage.exists.bind(storage);
    storage.exists = () => new Promise<boolean>(() => undefined);
    try {
      const started = Date.now();
      const result = await ask("How often are access reviews performed?");
      expect(result.status).toBe(503);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      storage.exists = realExists;
      delete process.env.ASK_DEADLINE_MS;
      resetDeadlineConfigForTests();
    }
  });

  it("reuses cached passage vectors after a restart instead of embedding the documents again", async () => {
    llm.reply = citing("access reviews", "Access reviews are scheduled.");
    await ask("How often are access reviews performed?");
    expect(providers.embedCalls.filter((call) => call.kind === "document")).toHaveLength(1);
    const cacheKeys = [...((storage as unknown as { bucket: Map<string, Buffer> }).bucket.keys())].filter((key) =>
      key.startsWith("compliance/index/")
    );
    expect(cacheKeys).toHaveLength(1);
    // The cache holds vectors and hashes, never passage text.
    const cache = (storage as unknown as { bucket: Map<string, Buffer> }).bucket.get(cacheKeys[0]!)!.toString("utf8");
    expect(cache).not.toContain("access reviews");

    __resetComplianceSearchIndexForTests();
    const again = await ask("How often are access reviews performed?");
    expect(again.status).toBe(200);
    expect(providers.embedCalls.filter((call) => call.kind === "document")).toHaveLength(1);
  });

  it("answers from an empty manifest with the refusal", async () => {
    await storage.delete(COMPLIANCE_MANIFEST_KEY);
    const result = await ask("How often are access reviews performed?");
    expect(result.status).toBe(200);
    expect(result.body.refused).toBe(true);
    expect(providers.embedCalls).toEqual([]);
  });
});

describe("POST /api/compliance/ask rate limit", () => {
  it("refuses the eleventh question in a minute", async () => {
    providers.scoreScale = 0.1;
    for (let i = 0; i < 10; i += 1) {
      expect((await ask("What is the capital of France?")).status).toBe(200);
    }
    expect((await ask("What is the capital of France?")).status).toBe(429);
  });
});

describe("compliance answers never read customer knowledge", () => {
  it("runs a full answer without querying chunks, documents or versions", async () => {
    llm.reply = citing("Quarterly access reviews", "Access reviews are quarterly.");
    const result = await ask("How often are access reviews performed?");
    expect(result.status).toBe(200);
    for (const query of sqlSeen.queries) {
      expect(query).not.toMatch(/\b(chunks|documents|document_versions|query_log)\b/);
    }
  });
});
