import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import type { CohereClient } from "cohere-ai";
import { OpenAIEmbedder } from "../../artifacts/api-server/src/lib/ingestion/embedder.js";
import { rerankWithCohere } from "../../artifacts/api-server/src/lib/retrieval/rerank.js";
import {
  generateAnswer,
  validateGeneratedAnswer,
  type GenerateAnswerInput
} from "../../artifacts/api-server/src/lib/generation/answer.js";
import {
  runUtilityCompletion,
  UTILITY_MODEL_ROUTE
} from "../../artifacts/api-server/src/lib/generation/utility-model.js";
import { DEFAULT_MODEL_ROUTE } from "../../artifacts/api-server/src/lib/generation/model-routing.js";
import {
  protectProviderText,
  ProviderInputFirewallError
} from "../../artifacts/api-server/src/lib/security/provider-input-firewall.js";
import { scanTextForSensitiveContent } from "../../artifacts/api-server/src/lib/security/content-scan.js";

interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  provider?: unknown;
}

function chatClient(
  captured: ChatRequest[],
  responseText: string
): OpenAI {
  return {
    chat: {
      completions: {
        create: async (request: ChatRequest) => {
          captured.push(request);
          return { choices: [{ message: { content: responseText } }] };
        }
      }
    }
  } as unknown as OpenAI;
}

function userMessage(request: ChatRequest | undefined): string {
  return request?.messages.find((message) => message.role === "user")?.content ?? "";
}

const sensitiveValues = [
  "csr@example.com",
  "+1 212-555-0198",
  "123-45-6789",
  "4242 4242 4242 4242",
  "192.0.2.10",
  "2001:db8::8a2e:370:7334",
  "sk-proj-abcdefghijklmnopqrstuvwxyz"
] as const;

describe("provider input firewall portable security gate", () => {
  it("redacts every claimed deterministic class without retaining raw findings", () => {
    const raw = [
      `email ${sensitiveValues[0]}`,
      `phone ${sensitiveValues[1]}`,
      `SSN ${sensitiveValues[2]}`,
      `card ${sensitiveValues[3]}`,
      `IPv4 ${sensitiveValues[4]}`,
      `IPv6 ${sensitiveValues[5]}`,
      `key ${sensitiveValues[6]}`
    ].join("; ");

    const result = protectProviderText(raw);

    assert.equal(result.redacted, true);
    for (const value of sensitiveValues) {
      assert.equal(result.text.includes(value), false);
      assert.equal(JSON.stringify(result.findings).includes(value), false);
    }
    assert.deepEqual(
      new Set(result.findings.map((finding) => finding.ruleId)),
      new Set([
        "secret.openai_key",
        "pii.us_ssn",
        "pii.payment_card",
        "pii.email",
        "pii.structured_phone",
        "pii.ipv4",
        "pii.ipv6"
      ])
    );
    assert.deepEqual(
      scanTextForSensitiveContent(result.text).filter(
        (finding) =>
          finding.blocking &&
          (finding.category === "pii" || finding.category === "secret")
      ),
      []
    );
  });

  it("documents contextual and ambiguity boundaries without false claims", () => {
    const raw =
      "Jane Doe lives at 123 Main Street; policy 1234567890; invalid IP 999.999.999.999.";
    assert.deepEqual(protectProviderText(raw), {
      text: raw,
      redacted: false,
      findings: []
    });
    assert.equal(new ProviderInputFirewallError(["future.rule"]).code, "PROVIDER_INPUT_FIREWALL_FAILED");
  });

  it("protects OpenAI embedding batches before client invocation", async () => {
    const inputs: string[][] = [];
    const client = {
      embeddings: {
        create: async (body: { input: string[] }) => {
          inputs.push(body.input);
          return { data: body.input.map((_, index) => ({ index, embedding: [index] })) };
        }
      }
    } as unknown as OpenAI;

    await new OpenAIEmbedder({ client }).embed([
      "Contact csr@example.com or 212-555-0198 from 192.0.2.10."
    ]);

    assert.deepEqual(inputs, [[
      "Contact [REDACTED_PII_EMAIL] or [REDACTED_PII_PHONE] from [REDACTED_PII_IP_ADDRESS]."
    ]]);
  });

  it("protects Cohere query and candidate documents before client invocation", async () => {
    let captured: { query: string; documents: string[] } | undefined;
    const client = {
      rerank: async (request: { query: string; documents: string[] }) => {
        captured = request;
        return { results: [{ index: 0, relevanceScore: 0.91 }] };
      }
    } as unknown as CohereClient;

    await rerankWithCohere(
      {
        question: "Find csr@example.com from 192.0.2.10",
        documents: ["Call 212-555-0198 about SSN 123-45-6789"]
      },
      { client }
    );

    assert.deepEqual(captured, {
      model: "rerank-english-v3.0",
      query: "Find [REDACTED_PII_EMAIL] from [REDACTED_PII_IP_ADDRESS]",
      documents: ["Call [REDACTED_PII_PHONE] about SSN [REDACTED_PII_US_SSN]"],
      topN: 1
    });
  });

  it("protects OpenRouter answer-generation prompts before client invocation", async () => {
    const captured: ChatRequest[] = [];
    const chunks: GenerateAnswerInput["chunks"] = [{
      id: "chunk-1",
      content: "Call 212-555-0198 or email csr@example.com.",
      documentVersionId: "version-1",
      documentId: "document-1",
      versionNumber: 1,
      programId: "program-1",
      docTitle: "Contact policy",
      metadata: {},
      relevanceScore: 0.9
    }];

    const result = await generateAnswer(
      {
        programName: "Test",
        question: "What is linked to 192.0.2.10?",
        chunks
      },
      {
        client: chatClient(captured, "Use the approved contact route [S1]."),
        routeChain: [DEFAULT_MODEL_ROUTE]
      }
    );

    const outbound = userMessage(captured[0]);
    assert.equal(outbound.includes("csr@example.com"), false);
    assert.equal(outbound.includes("212-555-0198"), false);
    assert.equal(outbound.includes("192.0.2.10"), false);
    assert.match(outbound, /\[REDACTED_PII_EMAIL\]/);
    assert.match(outbound, /\[REDACTED_PII_PHONE\]/);
    assert.match(outbound, /\[REDACTED_PII_IP_ADDRESS\]/);
    assert.equal(result.payload.refused, false);
  });

  it("protects OpenRouter utility prompts before client invocation", async () => {
    const captured: ChatRequest[] = [];

    await runUtilityCompletion(
      {
        system: "Rewrite safely.",
        user: "Follow up with csr@example.com at 212-555-0198.",
        timeoutMs: 1_000,
        maxRetries: 0
      },
      {
        client: chatClient(captured, "Safe rewrite"),
        route: UTILITY_MODEL_ROUTE
      }
    );

    assert.equal(
      userMessage(captured[0]),
      "Follow up with [REDACTED_PII_EMAIL] at [REDACTED_PII_PHONE]."
    );
  });

  it("blocks deterministic sensitive model output before return or persistence", () => {
    const chunks: GenerateAnswerInput["chunks"] = [{
      id: "chunk-1",
      content: "Use the approved customer-service workflow.",
      documentVersionId: "version-1",
      documentId: "document-1",
      versionNumber: 1,
      programId: "program-1",
      docTitle: "Customer-service workflow",
      metadata: {},
      relevanceScore: 0.9
    }];
    const sensitiveOutputs = [
      "The customer's SSN is 123-45-6789 [S1].",
      "Use payment card 4242 4242 4242 4242 [S1].",
      "The credential is sk-proj-abcdefghijklmnopqrstuvwxyz [S1].",
      "-----BEGIN PRIVATE KEY-----\nc2Vuc2l0aXZlLWtleS1ib2R5\n-----END PRIVATE KEY----- [S1]."
    ];

    for (const rawOutput of sensitiveOutputs) {
      const result = validateGeneratedAnswer(rawOutput, chunks);
      assert.equal(result.payload, null);
      assert.equal(result.failure?.reason, "sensitive_output");
      assert.equal(result.failure?.returnedText, "[redacted: sensitive output blocked]");
      assert.equal(JSON.stringify(result).includes(rawOutput), false);
    }
  });
});
