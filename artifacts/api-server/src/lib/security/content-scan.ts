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
  status: "clean" | "infected" | "unavailable" | "error" | "disabled";
  engine: string | null;
  scanId: string | null;
  findings: SecurityFinding[];
}

export function disabledMalwareScanResult(): MalwareScanResult {
  return {
    status: "disabled",
    engine: null,
    scanId: null,
    findings: []
  };
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
  /**
   * Skip a match when its clause, up to the end of the match, holds a
   * negation ("never ask for the full card number"). The clause starts after
   * the last `. ! ? ; : ,` or line break before the match.
   */
  skipNegated?: boolean;
}

/** Words a model or assistant is addressed by. Not "agent", "bot" or "model", which name people and products in support content. */
const ASSISTANT = String.raw`(?:ai|assistants?|ai\s+assistants?|language\s+models?|llms?|chatbots?)`;
/** Not a human role such as "assistant manager". */
const NOT_A_HUMAN_ROLE = String.raw`(?!\s+(?:manager|supervisor|director|team|lead)s?\b)`;
/** Card data a customer must never read out: the full number or the card security code. */
const CARD_DATA = String.raw`(?:(?:full|entire|complete|whole|long)\s+(?:(?:credit|debit|payment|bank)\s+)?card\s+number|all\s+(?:15|16|fifteen|sixteen)\s+digits|cvv2?|cvc2?|card\s+(?:security|verification)\s+(?:code|value|number)|(?:3|three)[-\s]digit\s+(?:security\s+)?code|security\s+code\s+on\s+the\s+back)`;

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
    pattern: /\b(?!000|666|9\d\d)\d{3}[- ./\u2010-\u2015\u2212](?!00)\d{2}[- ./\u2010-\u2015\u2212](?!0000)\d{4}\b/g,
    message: "US Social Security number pattern detected.",
    blocking: true
  },
  {
    category: "prompt_injection",
    ruleId: "prompt.ignore_instructions",
    severity: "high",
    pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:(?:of\s+)?(?:the|your|these|those)\s+)?(?:previous|prior|above|earlier|preceding|original|system|developer|your)\s+(?:instructions?|rules|guidelines|prompts?|directions)\b/gi,
    message: "Instruction-override language detected in source content.",
    blocking: false
  },
  {
    category: "prompt_injection",
    ruleId: "prompt.system_prompt_exfiltration",
    severity: "high",
    pattern: /\b(?:reveal|print|repeat|show|extract|output|display|list) (?:the |your )?(?:full )?(?:system|developer|hidden|initial) (?:prompt|message|instructions?)\b/gi,
    message: "System-prompt extraction language detected in source content.",
    blocking: false
  },
  {
    // Text written to the assistant rather than to the agent: "Note to the
    // AI", "Instruction for the assistant:", "Formatting requirement for
    // assistants", "If you are an AI".
    category: "prompt_injection",
    ruleId: "prompt.assistant_directive",
    severity: "high",
    pattern: new RegExp(
      String.raw`\b(?:(?:notes?|instructions?|directives?|requirements?|rules?|reminders?|messages?|guidance|commands?)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+|every\s+)?${ASSISTANT}${NOT_A_HUMAN_ROLE}|if\s+you\s+are\s+(?:an?\s+)?${ASSISTANT}${NOT_A_HUMAN_ROLE}|(?:attention|dear)(?:\s*,\s*|\s+)${ASSISTANT}${NOT_A_HUMAN_ROLE}|${ASSISTANT}\s+(?:reading|processing|summari[sz]ing)\s+this)\b`,
      "gi"
    ),
    message: "Instructions addressed to an AI assistant detected in source content.",
    blocking: false
  },
  {
    category: "prompt_injection",
    ruleId: "prompt.citation_suppression",
    severity: "high",
    pattern: /\b(?:(?:do\s+not|don't|never)\s+(?:include|add|show|use|give|cite|provide)\s+(?:any\s+)?(?:\S+\s+style\s+)?(?:citations?|source\s+tokens?)|(?:answer|reply|respond)\s+without\s+(?:any\s+)?(?:citations?|sources))\b/gi,
    message: "Instruction to drop answer citations detected in source content.",
    blocking: false
  },
  {
    category: "prompt_injection",
    ruleId: "prompt.fabrication_request",
    severity: "high",
    pattern: /\b(?:make\s+up|invent|fabricate)\s+(?:(?:a|an|one|some)\s+)?(?:plausible|realistic|believable|convincing|fake|fictional|fictitious)\b/gi,
    message: "Instruction to invent information detected in source content.",
    blocking: false,
    skipNegated: true
  },
  {
    // A customer reading out a full card number or security code, or an agent
    // collecting one. "Never ask for the full card number" is skipped.
    category: "prompt_injection",
    ruleId: "prompt.card_data_request",
    severity: "high",
    pattern: new RegExp(
      String.raw`\b(?:ask|request|collect|obtain|capture|record|read|say|recite|provide|share|spell|repeat|dictate|give)(?:s|ed|ing)?\b[^.!?;:,\n]{0,60}?\b${CARD_DATA}\b`,
      "gi"
    ),
    message: "Instruction to collect a full card number or card security code detected in source content.",
    blocking: false,
    skipNegated: true
  },
  {
    category: "prompt_injection",
    ruleId: "prompt.active_markup",
    severity: "medium",
    // The tag body excludes `<` and is capped, so a long line of unclosed
    // tags stays linear.
    pattern: /<\s*script\b|\bjavascript\s*:|<[a-z][^<>\n]{0,200}?\bon(?:error|load|click|mouseover|focus)\s*=/gi,
    message: "Script or event-handler markup detected in source content.",
    blocking: false
  },
  {
    category: "prompt_injection",
    ruleId: "prompt.role_impersonation",
    severity: "medium",
    // Horizontal whitespace only after the line break: `\s*` there also
    // matched later line breaks, so a long run of blank lines backtracked
    // quadratically (80 KB took over 8 s).
    pattern: /(?:^|\n)[^\S\n]*(?:system|assistant|developer)\s*:\s*/gi,
    message: "Model-role impersonation marker detected in source content.",
    blocking: false
  }
];

// NFKC keeps the typographic apostrophe, so "don’t" needs U+2019 here.
const NEGATION = /\b(?:never|not|no|cannot|avoid|prohibited|forbidden)\b|n['’]t\b/gi;
const CLAUSE_BREAK = /[.!?;:,\n]/g;

/** Start offsets of every match of a global pattern, in order. */
function matchStarts(text: string, pattern: RegExp): number[] {
  return Array.from(text.matchAll(new RegExp(pattern.source, pattern.flags)), (m) => m.index ?? 0);
}

/** Index of the first value >= target in an ascending array, or its length. */
function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid]! < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Clause-break and negation offsets of one text, built on first use. */
interface NegationIndex {
  breaks: number[];
  negations: number[];
}

function negationIndex(text: string, cache: Map<string, NegationIndex>): NegationIndex {
  let index = cache.get(text);
  if (!index) {
    index = { breaks: matchStarts(text, CLAUSE_BREAK), negations: matchStarts(text, NEGATION) };
    cache.set(text, index);
  }
  return index;
}

function countMatches(
  text: string,
  rule: Pick<PatternRule, "pattern" | "skipNegated">,
  cache: Map<string, NegationIndex> = new Map()
): number {
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
  if (!rule.skipNegated) return text.match(pattern)?.length ?? 0;
  // Breaks and negations are located once per text, and only when a
  // negation-aware rule matches, so long text stays near-linear however
  // many matches it holds and costs nothing extra when nothing matches.
  let count = 0;
  for (const match of text.matchAll(pattern)) {
    const { breaks, negations } = negationIndex(text, cache);
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const breakIndex = lowerBound(breaks, start) - 1;
    const clauseStart = breakIndex >= 0 ? breaks[breakIndex]! + 1 : 0;
    const negation = negations[lowerBound(negations, clauseStart)];
    if (negation === undefined || negation >= end) count += 1;
  }
  return count;
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

/**
 * A run of digit groups joined by card separators. Only spaces and tabs count
 * as whitespace, so numbers on separate lines (or in separate fields joined
 * by newlines) never join. The scan also reads the NFKC form, which turns
 * no-break and other wide spaces into a space and fullwidth digits into ASCII
 * digits.
 */
const CARD_SEPARATOR = String.raw`(?:(?:[ \t]*[./_\-\u2010-\u2015\u2212])+[ \t]*|[ \t]+)`;
const CARD_SPAN_PATTERN = new RegExp(String.raw`\b\d+(?:${CARD_SEPARATOR}\d+)*\b`, "g");
const CARD_DIGIT_GROUP = /\d+/g;
/** Separators that may sit between any digits; others need card-shaped groups. */
const LOOSE_CARD_SEPARATOR = /^[ \t\-\u2010-\u2015\u2212]+$/;

/** 4-4-4-1..7 (most brands) or 4-6-4..5 (15-digit cards). */
function isCardShaped(groupLengths: readonly number[]): boolean {
  const [a, b, c, d] = groupLengths;
  if (groupLengths.length === 4) return a === 4 && b === 4 && c === 4 && d! >= 1 && d! <= 7;
  if (groupLengths.length === 3) return a === 4 && b === 6 && (c === 4 || c === 5);
  return false;
}

/**
 * Character ranges of payment-card numbers. Every window of whole digit
 * groups holding 13 to 19 digits is a candidate, longest first from each
 * start, so a number next to a card (`Row 1234<tab>4111 1111 1111 1111`)
 * cannot hide it by joining it into a longer candidate that fails the Luhn
 * check. Spaces, tabs and dashes may separate any digits; dots, slashes and
 * underscores count only between card-shaped groups, so lists of IP
 * addresses or version numbers do not read as one long number.
 *
 * Each window is checked from its last group backwards with a running Luhn
 * sum, so every group costs at most 19 digit steps and the scan stays linear
 * in the text.
 */
function findPaymentCards(text: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (const span of text.matchAll(CARD_SPAN_PATTERN)) {
    const offset = span.index ?? 0;
    const starts: number[] = [];
    const ends: number[] = [];
    const digits: string[] = [];
    // strictBefore[k]: separators up to group k that are not spaces, tabs or dashes.
    const strictBefore: number[] = [];
    let strictCount = 0;
    for (const group of span[0].matchAll(CARD_DIGIT_GROUP)) {
      const start = offset + (group.index ?? 0);
      if (ends.length > 0 && !LOOSE_CARD_SEPARATOR.test(text.slice(ends[ends.length - 1], start))) {
        strictCount += 1;
      }
      starts.push(start);
      ends.push(start + group[0].length);
      digits.push(group[0]);
      strictBefore.push(strictCount);
    }

    // longestEnd[k]: last group of the longest valid window starting at group k.
    const longestEnd = new Int32Array(digits.length).fill(-1);
    for (let j = 0; j < digits.length; j += 1) {
      let sum = 0;
      let count = 0;
      for (let k = j; k >= 0; k -= 1) {
        const group = digits[k]!;
        if (count + group.length > 19) break;
        for (let p = group.length - 1; p >= 0; p -= 1) {
          let value = group.charCodeAt(p) - 48;
          if (count % 2 === 1) {
            value *= 2;
            if (value > 9) value -= 9;
          }
          sum += value;
          count += 1;
        }
        if (count < 13 || sum % 10 !== 0 || j <= longestEnd[k]!) continue;
        const looseOnly = strictBefore[j] === strictBefore[k];
        if (looseOnly || isCardShaped(digits.slice(k, j + 1).map((g) => g.length))) {
          longestEnd[k] = j;
        }
      }
    }

    for (let i = 0; i < digits.length; ) {
      const end = longestEnd[i]!;
      if (end < 0) {
        i += 1;
        continue;
      }
      found.push({ start: starts[i]!, end: ends[end]! });
      i = end + 1;
    }
  }
  return found;
}

function redactPaymentCards(text: string): string {
  let redacted = text;
  for (const card of findPaymentCards(text).reverse()) {
    redacted = `${redacted.slice(0, card.start)}[REDACTED_PII_PAYMENT_CARD]${redacted.slice(card.end)}`;
  }
  return redacted;
}

/**
 * Redacts detected secret/PII values without returning the matched text.
 * Text comes back unchanged apart from the redactions, unless a value is
 * only visible after NFKC normalization (fullwidth digits, no-break spaces);
 * then the normalized text comes back with that value redacted.
 */
export function redactSensitiveText(text: string): string {
  const redacted = redactExactText(text);
  const normalized = redacted.normalize("NFKC");
  if (normalized === redacted) return redacted;
  const normalizedRedacted = redactExactText(normalized);
  return normalizedRedacted === normalized ? redacted : normalizedRedacted;
}

function redactExactText(text: string): string {
  let redacted = text.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|$)/g,
    "[REDACTED_SECRET_PRIVATE_KEY]"
  );
  for (const rule of TEXT_RULES) {
    if (rule.category === "prompt_injection") continue;
    const label = rule.ruleId.replace(/[^a-z0-9]+/gi, "_").toUpperCase();
    redacted = redacted.replace(
      new RegExp(rule.pattern.source, rule.pattern.flags),
      `[REDACTED_${label}]`
    );
  }
  return redactPaymentCards(redacted);
}

/**
 * Findings contain rule/count only, never matching sensitive text. Each rule
 * reads both the text as given and its NFKC form and keeps the larger count:
 * NFKC exposes fullwidth digits and no-break spaces, but it can also hide a
 * value, for example by turning a trailing superscript into one more digit.
 */
export function scanTextForSensitiveContent(rawText: string): SecurityFinding[] {
  const normalized = rawText.normalize("NFKC");
  const findings: SecurityFinding[] = [];
  const negationCache = new Map<string, NegationIndex>();
  for (const rule of TEXT_RULES) {
    const count = Math.max(
      countMatches(rawText, rule, negationCache),
      countMatches(normalized, rule, negationCache)
    );
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
  const paymentCards = Math.max(
    findPaymentCards(rawText).length,
    findPaymentCards(normalized).length
  );
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
 * Production transport rule for the scanner URL: HTTPS, or plain HTTP to a
 * Railway private host (`<service>.railway.internal`), which only resolves
 * inside the project's private network and travels over Railway's encrypted
 * WireGuard mesh. Any other HTTP host is refused. Outside production every
 * URL is allowed so local tests can use a loopback scanner.
 */
export function isScannerTransportAllowed(
  url: string,
  nodeEnv: string | undefined = process.env.NODE_ENV
): boolean {
  if (nodeEnv !== "production") return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return (
    parsed.protocol === "http:" &&
    parsed.hostname.endsWith(".railway.internal") &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

const SCANNER_REQUEST_TIMEOUT_MS = 60_000;
const SCANNER_MAX_ATTEMPTS = 3;
const SCANNER_HEALTH_TIMEOUT_MS = 5_000;
const SCANNER_HEALTH_INTERVAL_MS = 2_000;
const DEFAULT_SCANNER_WAKE_TIMEOUT_MS = 300_000;
// 3 requests at 60 s plus a 10-minute wait stay inside the ingestion job's
// 15-minute pg-boss expiry (ingestion/queue.ts), so the job is not redelivered
// mid-scan.
const MAX_SCANNER_WAKE_TIMEOUT_MS = 600_000;
// Answers a sleeping or still-loading scanner gives: Railway's proxy returns
// 502 while it wakes a Serverless service, and the wrapper returns 503 until
// clamd has loaded its signatures.
const SCANNER_WAKING_STATUSES = new Set([502, 503, 504]);

function scannerError(message: string): MalwareScanResult {
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
        message,
        blocking: true
      }
    ]
  };
}

/**
 * How long to wait for a waking scanner; invalid values fall back to 5 minutes
 * and larger values are clamped to 10 minutes.
 */
function scannerWakeTimeoutMs(): number {
  const raw = process.env.MALWARE_SCANNER_WAKE_TIMEOUT_MS?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value > 0) return Math.min(value, MAX_SCANNER_WAKE_TIMEOUT_MS);
  }
  return DEFAULT_SCANNER_WAKE_TIMEOUT_MS;
}

/** One scan POST. Resolves null when no HTTP answer arrived (network error or timeout). */
async function postToScanner(
  url: string,
  headers: Record<string, string>,
  body: Buffer
): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(SCANNER_REQUEST_TIMEOUT_MS)
    });
  } catch {
    return null;
  }
}

/** Polls the scanner's unauthenticated /health until it answers 200 or the deadline passes. */
async function waitForScannerReady(healthUrl: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(SCANNER_HEALTH_TIMEOUT_MS, deadline - Date.now()))
        )
      });
      await response.body?.cancel();
      if (response.status === 200) return true;
    } catch {
      // Not reachable yet; poll again.
    }
    const pause = Math.min(SCANNER_HEALTH_INTERVAL_MS, deadline - Date.now());
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
  return false;
}

/**
 * Adapter contract for an organization-approved scanner. Raw bytes are sent
 * only to an endpoint that passes isScannerTransportAllowed. Production uses
 * the self-hosted `scanner` Railway service (services/scanner/), which runs
 * with Railway Serverless: when the POST gets no answer or a 502, 503 or 504,
 * the scanner is treated as waking. The scan then polls its /health until it
 * answers 200 or MALWARE_SCANNER_WAKE_TIMEOUT_MS passes, and resends the same
 * request (at most SCANNER_MAX_ATTEMPTS POSTs). Every other failure is an
 * immediate error.
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
  if (!isScannerTransportAllowed(url)) {
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
          message:
            "Malware scanner URL must use HTTPS, or HTTP to a Railway private host, in production.",
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

  const wakeTimeoutMs = scannerWakeTimeoutMs();
  let waitStartedAt: number | null = null;
  const endWait = (outcome: string) => {
    if (waitStartedAt === null) return;
    console.log(
      `[malware-scan] stopped waiting for the scanner after ${Date.now() - waitStartedAt} ms: ${outcome}.`
    );
    waitStartedAt = null;
  };

  try {
    let response: Response | null = null;
    for (let attempt = 1; ; attempt += 1) {
      response = await postToScanner(url, headers, input.buffer);
      if (response && !SCANNER_WAKING_STATUSES.has(response.status)) break;
      const answer = response ? `HTTP ${response.status}` : "no response";
      await response?.body?.cancel();
      if (attempt >= SCANNER_MAX_ATTEMPTS) {
        endWait(`scanner still unavailable (${answer}) after ${attempt} attempts`);
        return scannerError("Approved malware scanner did not become ready in time.");
      }
      if (waitStartedAt === null) {
        waitStartedAt = Date.now();
        console.warn(
          `[malware-scan] scanner unavailable (${answer}); waiting up to ${wakeTimeoutMs} ms for it to wake.`
        );
      }
      const ready = await waitForScannerReady(
        `${new URL(url).origin}/health`,
        waitStartedAt + wakeTimeoutMs
      );
      if (!ready) {
        endWait("scanner did not report healthy before the deadline");
        return scannerError("Approved malware scanner did not become ready in time.");
      }
    }
    endWait(`scanner answered HTTP ${response.status}`);
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
  } catch {
    endWait("scan failed");
    return scannerError("Approved malware scanner failed or returned an invalid response.");
  }
}
