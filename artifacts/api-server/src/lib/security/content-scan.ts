import { createHmac } from "node:crypto";

export type FindingSeverity = "low" | "medium" | "high" | "critical";
export type FindingCategory =
  | "file_validation"
  | "malware"
  | "pii"
  | "secret"
  | "prompt_injection";

export interface SecurityFinding {
  category: FindingCategory;
  ruleId: string;
  severity: FindingSeverity;
  count: number;
  message: string;
  blocking: boolean;
}

export interface MalwareScanResult {
  status: "clean" | "infected" | "unavailable" | "error";
  engine: string | null;
  scanId: string | null;
  findings: SecurityFinding[];
}

const EICAR_MARKER = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE";

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((value, index) => buffer[index] === value);
}

/**
 * Cheap deterministic boundary checks. These do not replace malware scanning;
 * they catch mislabeled/polyglot inputs before an external parser sees them.
 */
export function validateFileSignature(
  buffer: Buffer,
  mimeType: string
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const signatureMatches = (() => {
    switch (mimeType) {
      case "application/pdf":
        return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
      case "image/png":
        return startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      case "image/jpeg":
      case "image/jpg":
        return startsWith(buffer, [0xff, 0xd8, 0xff]);
      case "image/webp":
        return (
          buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
          buffer.subarray(8, 12).toString("ascii") === "WEBP"
        );
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]);
      case "text/markdown":
      case "text/plain":
        return !buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0);
      default:
        return false;
    }
  })();
  if (!signatureMatches) {
    findings.push({
      category: "file_validation",
      ruleId: "file.signature_mismatch",
      severity: "critical",
      count: 1,
      message: "File bytes do not match the declared file type.",
      blocking: true
    });
  }
  if (buffer.toString("ascii").includes(EICAR_MARKER)) {
    findings.push({
      category: "malware",
      ruleId: "malware.eicar_test_file",
      severity: "critical",
      count: 1,
      message: "Antivirus test signature detected.",
      blocking: true
    });
  }
  return findings;
}

interface PatternRule {
  category: Extract<FindingCategory, "pii" | "secret" | "prompt_injection">;
  ruleId: string;
  severity: FindingSeverity;
  pattern: RegExp;
  message: string;
  blocking: boolean;
}

const TEXT_RULES: PatternRule[] = [
  {
    category: "secret",
    ruleId: "secret.private_key",
    severity: "critical",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
    message: "Private-key material detected.",
    blocking: true
  },
  {
    category: "secret",
    ruleId: "secret.aws_access_key",
    severity: "high",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    message: "AWS-style access key detected.",
    blocking: true
  },
  {
    category: "secret",
    ruleId: "secret.openai_key",
    severity: "high",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    message: "API-key-shaped secret detected.",
    blocking: true
  },
  {
    category: "pii",
    ruleId: "pii.us_ssn",
    severity: "high",
    pattern: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g,
    message: "US Social Security number pattern detected.",
    blocking: true
  },
  {
    category: "prompt_injection",
    ruleId: "prompt.ignore_instructions",
    severity: "high",
    pattern: /\bignore (?:all |any |the )?(?:previous|prior|above|system|developer) instructions?\b/gi,
    message: "Instruction-override language detected in source content.",
    blocking: false
  },
  {
    category: "prompt_injection",
    ruleId: "prompt.system_prompt_exfiltration",
    severity: "high",
    pattern: /\b(?:reveal|print|repeat|show|extract) (?:the )?(?:system|developer) (?:prompt|message|instructions?)\b/gi,
    message: "System-prompt extraction language detected in source content.",
    blocking: false
  },
  {
    category: "prompt_injection",
    ruleId: "prompt.role_impersonation",
    severity: "medium",
    pattern: /(?:^|\n)\s*(?:system|assistant|developer)\s*:\s*/gi,
    message: "Model-role impersonation marker detected in source content.",
    blocking: false
  }
];

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(new RegExp(pattern.source, pattern.flags));
  return matches?.length ?? 0;
}

function looksLikePaymentCard(candidate: string): boolean {
  const digits = candidate.replace(/[^0-9]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Findings contain rule/count only, never matching sensitive text. */
export function scanTextForSensitiveContent(text: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const rule of TEXT_RULES) {
    const count = countMatches(text, rule.pattern);
    if (count === 0) continue;
    findings.push({
      category: rule.category,
      ruleId: rule.ruleId,
      severity: rule.severity,
      count,
      message: rule.message,
      blocking: rule.blocking
    });
  }
  const cardCandidates = text.match(/\b(?:\d[ -]*?){13,19}\b/g) ?? [];
  const paymentCards = cardCandidates.filter(looksLikePaymentCard).length;
  if (paymentCards > 0) {
    findings.push({
      category: "pii",
      ruleId: "pii.payment_card",
      severity: "critical",
      count: paymentCards,
      message: "Payment-card number pattern detected.",
      blocking: true
    });
  }
  return findings;
}

export function hasBlockingFindings(findings: SecurityFinding[]): boolean {
  return findings.some((finding) => finding.blocking);
}

/**
 * Adapter contract for an organization-approved scanner. Raw bytes are sent
 * only when an HTTPS endpoint is configured. No public scanning vendor is
 * selected by the application.
 */
export async function scanForMalware(input: {
  buffer: Buffer;
  sha256: string;
  mimeType: string;
  originalFileName: string;
}): Promise<MalwareScanResult> {
  const url = process.env.MALWARE_SCANNER_URL?.trim();
  if (!url) {
    return {
      status: "unavailable",
      engine: null,
      scanId: null,
      findings: [
        {
          category: "malware",
          ruleId: "malware.scanner_unconfigured",
          severity: "critical",
          count: 1,
          message: "Approved malware scanner is not configured.",
          blocking: true
        }
      ]
    };
  }
  if (process.env.NODE_ENV === "production" && !url.startsWith("https://")) {
    return {
      status: "error",
      engine: null,
      scanId: null,
      findings: [
        {
          category: "malware",
          ruleId: "malware.scanner_insecure_transport",
          severity: "critical",
          count: 1,
          message: "Malware scanner URL must use HTTPS in production.",
          blocking: true
        }
      ]
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "X-Content-SHA256": input.sha256,
    "X-Content-Type": input.mimeType,
    "X-Original-Filename": encodeURIComponent(input.originalFileName)
  };
  const token = process.env.MALWARE_SCANNER_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const signingKey = process.env.MALWARE_SCANNER_HMAC_KEY?.trim();
  if (signingKey) {
    headers["X-Truenote-Signature"] = `sha256=${createHmac("sha256", signingKey)
      .update(input.buffer)
      .digest("hex")}`;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: input.buffer,
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`scanner returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      verdict?: unknown;
      engine?: unknown;
      scanId?: unknown;
      signature?: unknown;
    };
    const engine = typeof body.engine === "string" ? body.engine.slice(0, 120) : null;
    const scanId = typeof body.scanId === "string" ? body.scanId.slice(0, 200) : null;
    if (body.verdict === "clean") {
      return { status: "clean", engine, scanId, findings: [] };
    }
    if (body.verdict === "infected") {
      return {
        status: "infected",
        engine,
        scanId,
        findings: [
          {
            category: "malware",
            ruleId: "malware.detected",
            severity: "critical",
            count: 1,
            message:
              typeof body.signature === "string"
                ? `Malware detected (${body.signature.slice(0, 120)}).`
                : "Malware detected by the approved scanner.",
            blocking: true
          }
        ]
      };
    }
    throw new Error("scanner response has no recognized verdict");
  } catch (error) {
    return {
      status: "error",
      engine: null,
      scanId: null,
      findings: [
        {
          category: "malware",
          ruleId: "malware.scanner_error",
          severity: "critical",
          count: 1,
          message: "Approved malware scanner failed or returned an invalid response.",
          blocking: true
        }
      ]
    };
  }
}
