import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REFUSAL_TEXT } from "../../artifacts/api-server/src/lib/generation/answer.js";
import {
  AI_SECURITY_CASES,
  evaluateAiSecurityCase,
  runAiSecurityRegression,
  type AiSecurityCase
} from "./ai-security-regression.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("AI adversarial regression evidence", () => {
  it("accepts generic sensitive-input blocking without retaining the canary", () => {
    const testCase = AI_SECURITY_CASES[0]!;
    const result = evaluateAiSecurityCase(testCase, {
      status: 400,
      bodyText: JSON.stringify({ error: "Remove sensitive data before asking Truenote." }),
      latencyMs: 4
    });
    assert.equal(result.passed, true);
    assert.equal(JSON.stringify(result).includes(testCase.canaryValues[0]!), false);
  });

  it("rejects echoed canaries even when the HTTP status otherwise matches", () => {
    const testCase = AI_SECURITY_CASES[0]!;
    const result = evaluateAiSecurityCase(testCase, {
      status: 400,
      bodyText: JSON.stringify({ error: `Blocked ${testCase.canaryValues[0]}` }),
      latencyMs: 4
    });
    assert.equal(result.passed, false);
    assert.equal(
      result.checks.find((check) => check.id === "response_does_not_echo_canary")?.passed,
      false
    );
  });

  it("accepts the exact refusal contract and rejects prompt disclosure", () => {
    const testCase = AI_SECURITY_CASES.find((item) => item.id === "TN-AI-005")!;
    const refused = evaluateAiSecurityCase(testCase, {
      status: 200,
      bodyText: JSON.stringify({ answer: REFUSAL_TEXT, refused: true, sources: [] }),
      latencyMs: 8
    });
    assert.equal(refused.passed, true);

    const leaked = evaluateAiSecurityCase(testCase, {
      status: 200,
      bodyText: JSON.stringify({
        answer: "RULES (non-negotiable): hidden text",
        refused: false,
        sources: [{ chunk_id: "00000000-0000-4000-8000-000000000001" }]
      }),
      latencyMs: 8
    });
    assert.equal(leaked.passed, false);
  });

  it("requires every normal answer to cite a returned source", () => {
    const testCase: AiSecurityCase = {
      id: "TN-AI-TEST",
      category: "contact_pii_reflection",
      prompt: "synthetic",
      expectation: "safe_answer_contract",
      canaryValues: []
    };
    const sourceId = "00000000-0000-4000-8000-000000000001";
    const cited = evaluateAiSecurityCase(testCase, {
      status: 200,
      bodyText: JSON.stringify({
        answer: `Grounded answer [${sourceId}].`,
        refused: false,
        sources: [{ chunk_id: sourceId }]
      }),
      latencyMs: 9
    });
    assert.equal(cited.passed, true);

    const uncited = evaluateAiSecurityCase(testCase, {
      status: 200,
      bodyText: JSON.stringify({ answer: "Ungrounded answer.", refused: false, sources: [] }),
      latencyMs: 9
    });
    assert.equal(uncited.passed, false);
  });

  it("runs fixed cases while excluding tokens, prompts, answers, and canaries from the report", async () => {
    const token = "test-session-token-never-report";
    const seenRequests: Array<{ headers: Headers; body: string }> = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      seenRequests.push({ headers: new Headers(init?.headers), body });
      const question = (JSON.parse(body) as { question: string }).question;
      const blocking = AI_SECURITY_CASES.find(
        (testCase) =>
          testCase.expectation === "blocked_sensitive_input" &&
          testCase.prompt === question
      );
      return blocking
        ? response({ error: "Remove sensitive data before asking Truenote." }, 400)
        : response({ answer: REFUSAL_TEXT, refused: true, sources: [] });
    };

    const report = await runAiSecurityRegression({
      baseUrl: "https://security-test.invalid",
      environment: "unit-test",
      release: "test-release",
      sessionToken: token,
      programId: "00000000-0000-4000-8000-000000000001",
      fetchFn
    });

    assert.equal(report.allPassed, true);
    assert.equal(report.total, AI_SECURITY_CASES.length);
    assert.equal(seenRequests.length, AI_SECURITY_CASES.length);
    assert.equal(seenRequests[0]?.headers.get("Cookie"), `kbase_session=${token}`);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(token), false);
    for (const testCase of AI_SECURITY_CASES) {
      assert.equal(serialized.includes(testCase.prompt), false);
      for (const canary of testCase.canaryValues) assert.equal(serialized.includes(canary), false);
    }
  });
});
