import { describe, expect, it } from "vitest";
import { blockingAskContentFindings } from "../ask-content-policy.js";

describe("ask sensitive-input policy", () => {
  it("blocks deterministic sensitive question classes without retaining raw values", () => {
    const values = [
      "123-45-6789",
      "4242 4242 4242 4242",
      "sk-proj-abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN PRIVATE KEY-----\nc2Vuc2l0aXZlLWtleS1ib2R5\n-----END PRIVATE KEY-----"
    ];
    const findings = blockingAskContentFindings(values.join("\n"), []);

    expect(new Set(findings.map((finding) => finding.ruleId))).toEqual(new Set([
      "pii.us_ssn",
      "pii.payment_card",
      "secret.openai_key",
      "secret.private_key"
    ]));
    const serialized = JSON.stringify(findings);
    for (const value of values) expect(serialized).not.toContain(value);
  });

  it("scans every client-supplied history question and answer", () => {
    const findings = blockingAskContentFindings("What did we discuss?", [
      { question: "Earlier question", answer: "Use SSN 123-45-6789" },
      { question: "Card 4242 4242 4242 4242", answer: "Earlier answer" }
    ]);

    expect(new Set(findings.map((finding) => finding.ruleId))).toEqual(new Set([
      "pii.us_ssn",
      "pii.payment_card"
    ]));
  });

  it("keeps contextual and approved-contact classes outside this blocking claim", () => {
    expect(blockingAskContentFindings(
      "Contact Jane Doe at csr@example.com, +1 212-555-0198, 123 Main Street, or 192.0.2.10.",
      []
    )).toEqual([]);
  });
});
