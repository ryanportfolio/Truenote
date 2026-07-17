import { isIP } from "node:net";
import {
  redactSensitiveText,
  scanTextForSensitiveContent,
  type SecurityFinding
} from "./content-scan.js";

/**
 * Deterministic, synchronous protection applied immediately before text leaves
 * the application for an AI provider. Findings contain only rule ids/counts;
 * matched values are never returned or logged.
 *
 * This intentionally does not claim person-name or street-address detection.
 * Those classes require an approved contextual entity detector; OpenRouter's
 * configured guardrail covers its own route, but direct providers must not be
 * represented as having that coverage.
 */
export interface ProviderInputProtection {
  text: string;
  redacted: boolean;
  findings: SecurityFinding[];
}

export class ProviderInputFirewallError extends Error {
  readonly code = "PROVIDER_INPUT_FIREWALL_FAILED";

  constructor(ruleIds: string[]) {
    super(`Provider input firewall could not remove sensitive content (${ruleIds.join(", ")}).`);
    this.name = "ProviderInputFirewallError";
  }
}

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi;

// Require recognizable separators/parentheses. Bare 10-digit values are often
// policy/account ids and are not safe to classify as phone numbers by regex.
const PHONE_PATTERN =
  /(?<!\w)(?:\+?\d{1,3}[ .-])?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?!\w)/g;

const IPV4_CANDIDATE_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_CANDIDATE_PATTERN = /[A-Fa-f0-9:]{2,}/g;

function finding(ruleId: string, count: number, message: string): SecurityFinding {
  return {
    category: "pii",
    ruleId,
    severity: "medium",
    count,
    message,
    blocking: false
  };
}

function replacePattern(
  text: string,
  pattern: RegExp,
  replacement: string,
  predicate: (candidate: string) => boolean = () => true
): { text: string; count: number } {
  let count = 0;
  const protectedText = text.replace(
    new RegExp(pattern.source, pattern.flags),
    (candidate) => {
      if (!predicate(candidate)) return candidate;
      count += 1;
      return replacement;
    }
  );
  return { text: protectedText, count };
}

export function protectProviderText(text: string): ProviderInputProtection {
  const sensitiveFindings = scanTextForSensitiveContent(text).filter(
    (item) => item.category === "pii" || item.category === "secret"
  );
  let protectedText = redactSensitiveText(text);
  const findings: SecurityFinding[] = [...sensitiveFindings];

  const email = replacePattern(protectedText, EMAIL_PATTERN, "[REDACTED_PII_EMAIL]");
  protectedText = email.text;
  if (email.count > 0) {
    findings.push(finding("pii.email", email.count, "Email address pattern redacted."));
  }

  const phone = replacePattern(protectedText, PHONE_PATTERN, "[REDACTED_PII_PHONE]");
  protectedText = phone.text;
  if (phone.count > 0) {
    findings.push(
      finding("pii.structured_phone", phone.count, "Structured phone number pattern redacted.")
    );
  }

  const ipv4 = replacePattern(
    protectedText,
    IPV4_CANDIDATE_PATTERN,
    "[REDACTED_PII_IP_ADDRESS]",
    (candidate) => isIP(candidate) === 4
  );
  protectedText = ipv4.text;
  if (ipv4.count > 0) {
    findings.push(finding("pii.ipv4", ipv4.count, "IPv4 address pattern redacted."));
  }

  const ipv6 = replacePattern(
    protectedText,
    IPV6_CANDIDATE_PATTERN,
    "[REDACTED_PII_IP_ADDRESS]",
    (candidate) => isIP(candidate) === 6
  );
  protectedText = ipv6.text;
  if (ipv6.count > 0) {
    findings.push(finding("pii.ipv6", ipv6.count, "IPv6 address pattern redacted."));
  }

  // Defense against a future scanner rule being added without a matching
  // redactor. Never send text that still matches a blocking PII/secret rule.
  const unresolved = scanTextForSensitiveContent(protectedText).filter(
    (item) =>
      item.blocking && (item.category === "pii" || item.category === "secret")
  );
  if (unresolved.length > 0) {
    throw new ProviderInputFirewallError(unresolved.map((item) => item.ruleId));
  }

  return {
    text: protectedText,
    redacted: protectedText !== text,
    findings
  };
}

export function protectProviderTexts(texts: string[]): string[] {
  return texts.map((text) => protectProviderText(text).text);
}
