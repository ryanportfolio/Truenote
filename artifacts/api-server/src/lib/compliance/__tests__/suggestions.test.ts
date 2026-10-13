import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryObjectStorage } from "../../storage/object-storage.js";
import type { CompliancePassage } from "../chunking.js";
import type { ComplianceSearchIndex } from "../search-index.js";

const calls = vi.hoisted(() => ({
  completions: [] as Array<{ user: readonly string[]; route: string }>,
  reply: (user: readonly string[]) =>
    JSON.stringify({ questions: user.map((_, i) => ({ excerpt: `P${i + 1}`, question: `Question about item ${i + 1}?` })) }),
  retrieval: (_question: string) => ({ refused: false, slug: "plan" as string })
}));

vi.mock("../../generation/utility-model.js", () => ({
  runUtilityCompletionDetailed: async (input: { user: readonly string[] }, deps: { route: { id: string } }) => {
    calls.completions.push({ user: input.user, route: deps.route.id });
    return { text: calls.reply(input.user) };
  }
}));
vi.mock("../ask.js", () => ({
  retrieveCompliance: async (question: string) => {
    const result = calls.retrieval(question);
    return {
      refused: result.refused,
      passages: [{ passage: { slug: result.slug }, score: 0.9, neighbor: false }]
    };
  }
}));
vi.mock("../../observability/error-log.js", () => ({ recordAppError: async () => undefined }));

const suggestions = await import("../suggestions.js");
const { APPROVED_MODEL_ROUTES } = await import("../../generation/model-routing.js");

function passage(slug: string, ordinal: number, length = 300): CompliancePassage {
  return {
    id: `${slug}-${ordinal}`,
    slug,
    title: slug,
    version: "1",
    sha256: "a".repeat(64),
    section: "",
    ordinal,
    content: "x".repeat(length),
    sourceStart: 0,
    sourceEnd: length
  };
}

function index(passages: CompliancePassage[]): ComplianceSearchIndex {
  return { manifestHash: "m".repeat(64), passages, vectors: [], bm25: { search: () => [] } };
}

beforeEach(async () => {
  await suggestions.__resetComplianceSuggestionsForTests();
  calls.completions = [];
  calls.retrieval = () => ({ refused: false, slug: "plan" });
});

describe("pickPassages", () => {
  it("spreads over documents and skips short passages", () => {
    const passages = [
      ...Array.from({ length: 40 }, (_, i) => passage("plan", i)),
      ...Array.from({ length: 3 }, (_, i) => passage("policy", i)),
      passage("tiny", 0, 50),
      passage("short", 0, 100)
    ];
    const picked = suggestions.pickPassages(passages, 6);
    expect(picked.filter((item) => item.slug === "policy")).toHaveLength(3);
    expect(picked.some((item) => item.slug === "tiny")).toBe(false);
    // Short passages fill in only when long ones run out.
    expect(picked.some((item) => item.slug === "short")).toBe(false);
    const all = suggestions.pickPassages(passages, 100);
    expect(all.some((item) => item.slug === "short")).toBe(true);
    expect(all.some((item) => item.slug === "tiny")).toBe(false);
  });
});

describe("cleanQuestion", () => {
  it.each([
    ["  How often are\naccess reviews run?  ", "How often are access reviews run?"],
    ["No question mark here", null],
    ["Short?", null],
    [`${"Very long question ".repeat(10)}?`, null],
    ["Who can reach ops@example.com about incidents?", null],
    ["Which server at 10.0.0.12 holds the backups?", null]
  ])("cleans %j", (raw, expected) => {
    expect(suggestions.cleanQuestion(raw)).toBe(expected);
  });
});

describe("parseSuggestionReply", () => {
  it("reads the JSON object, a bare array and numbered refs", () => {
    expect(suggestions.parseSuggestionReply('x {"questions":[{"excerpt":"P2","question":"Q?"}]} y').get(2)).toBe("Q?");
    expect(suggestions.parseSuggestionReply('[{"excerpt":3,"question":"R?"}]').get(3)).toBe("R?");
    expect(suggestions.parseSuggestionReply("not json").size).toBe(0);
  });
});

describe("getComplianceSuggestions", () => {
  const chain = [APPROVED_MODEL_ROUTES[0]!];

  it("writes questions in the background, keeps those answered from the same document, and caches them", async () => {
    const storage = new InMemoryObjectStorage();
    const passages = Array.from({ length: 20 }, (_, i) => passage(i % 2 === 0 ? "plan" : "policy", i));
    calls.retrieval = (question) => ({ refused: question.includes("item 3?"), slug: "plan" });
    const deps = { storage, chain };
    expect(suggestions.getComplianceSuggestions(index(passages), deps)).toEqual({ status: "pending", questions: [] });
    await vi.waitFor(() => expect(suggestions.getComplianceSuggestions(index(passages), deps).status).toBe("ready"));
    const { questions } = suggestions.getComplianceSuggestions(index(passages), deps);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.length).toBeLessThanOrEqual(suggestions.MAX_SUGGESTIONS);
    expect(questions).not.toContain("Question about item 3?");
    // Every user message carries one excerpt.
    for (const call of calls.completions) expect(call.user.every((message) => message.startsWith("P"))).toBe(true);
    expect(await storage.exists(suggestions.complianceSuggestionsKey("m".repeat(64)))).toBe(true);

    // After a restart the storage cache answers without writing questions again.
    const completionsBefore = calls.completions.length;
    await suggestions.__resetComplianceSuggestionsForTests();
    suggestions.getComplianceSuggestions(index(passages), deps);
    await vi.waitFor(() => expect(suggestions.getComplianceSuggestions(index(passages), deps).status).toBe("ready"));
    expect(suggestions.getComplianceSuggestions(index(passages), deps).questions).toEqual(questions);
    expect(calls.completions.length).toBe(completionsBefore);
  });

  it("reports unavailable after a failed run and does not retry at once", async () => {
    const storage = new InMemoryObjectStorage();
    calls.retrieval = () => ({ refused: true, slug: "plan" });
    const deps = { storage, chain };
    const passages = [passage("plan", 0)];
    suggestions.getComplianceSuggestions(index(passages), deps);
    await vi.waitFor(() =>
      expect(suggestions.getComplianceSuggestions(index(passages), deps).status).toBe("unavailable")
    );
    const before = calls.completions.length;
    expect(suggestions.getComplianceSuggestions(index(passages), deps).status).toBe("unavailable");
    expect(calls.completions.length).toBe(before);
  });
});
