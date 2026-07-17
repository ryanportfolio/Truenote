import { describe, expect, it } from "vitest";
import { protectProviderText } from "../provider-input-firewall.js";

describe("protectProviderText", () => {
  it("redacts deterministic sensitive-data classes before provider calls", () => {
    const raw = [
      "email csr@example.com",
      "phone +1 212-555-0198",
      "SSN 123-45-6789",
      "card 4242 4242 4242 4242",
      "IPv4 192.0.2.10",
      "IPv6 2001:db8::8a2e:370:7334",
      "key sk-proj-abcdefghijklmnopqrstuvwxyz"
    ].join("; ");

    const result = protectProviderText(raw);

    expect(result.redacted).toBe(true);
    for (const value of [
      "csr@example.com",
      "+1 212-555-0198",
      "123-45-6789",
      "4242 4242 4242 4242",
      "192.0.2.10",
      "2001:db8::8a2e:370:7334",
      "sk-proj-abcdefghijklmnopqrstuvwxyz"
    ]) {
      expect(result.text).not.toContain(value);
    }
    expect(result.findings.map((item) => item.ruleId)).toEqual(
      expect.arrayContaining([
        "pii.email",
        "pii.structured_phone",
        "pii.us_ssn",
        "pii.payment_card",
        "pii.ipv4",
        "pii.ipv6",
        "secret.openai_key"
      ])
    );
    expect(JSON.stringify(result.findings)).not.toContain("csr@example.com");
  });

  it("does not misclassify invalid IPs or bare business identifiers", () => {
    const raw = "Policy 1234567890 uses version 999.999.999.999.";
    expect(protectProviderText(raw)).toEqual({ text: raw, redacted: false, findings: [] });
  });

  it("leaves names and street addresses untouched because contextual DLP is required", () => {
    const raw = "Jane Doe lives at 123 Main Street.";
    expect(protectProviderText(raw).text).toBe(raw);
  });
});
