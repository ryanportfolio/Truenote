import { randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db-client.js";
import type { CheckOutcome } from "../receipts.js";
import { verifyTimestampToken, type TimestampVerification } from "./tsa-verify.js";

type Executor = { execute(query: SQL): Promise<{ rows: unknown[] }> };
const defaultExecutor = db as unknown as Executor;

/**
 * Chain verification for evidence_receipts and security_events, and a daily
 * RFC 3161 timestamp over the evidence chain head, accepted only when the
 * token's signature verifies to a pinned root (tsa-verify.ts). Chain
 * verification recomputes every hash in SQL with the same rule the append
 * functions use.
 */

interface ChainSummary {
  total: number;
  badPayload: number;
  badLink: number;
  badHash: number;
  firstBadSequence: number | null;
  headSequence: number | null;
  headHash: string | null;
  timeZone?: string;
}

export function evaluateChain(label: string, summary: ChainSummary): CheckOutcome {
  const failures: string[] = [];
  if (summary.badPayload > 0) failures.push(`${summary.badPayload} ${label} row(s) whose payload hash does not recompute`);
  if (summary.badLink > 0) failures.push(`${summary.badLink} ${label} row(s) whose previous_hash does not match the prior row`);
  if (summary.badHash > 0) failures.push(`${summary.badHash} ${label} row(s) whose hash does not recompute`);
  return {
    result: failures.length === 0 ? "pass" : "fail",
    summary:
      failures.length === 0
        ? `${summary.total} ${label} row(s) verified; head ${summary.headHash?.slice(0, 16) ?? "none"}.`
        : `${label} chain broken from sequence ${summary.firstBadSequence ?? "?"}.`,
    failures,
    outputs: { ...summary }
  };
}

function toSummary(row: Record<string, unknown>): ChainSummary {
  const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    total: Number(row.total ?? 0),
    badPayload: Number(row.bad_payload ?? 0),
    badLink: Number(row.bad_link ?? 0),
    badHash: Number(row.bad_hash ?? 0),
    firstBadSequence: num(row.first_bad),
    headSequence: num(row.head_sequence),
    headHash: (row.head_hash as string | null) ?? null,
    ...(row.time_zone ? { timeZone: String(row.time_zone) } : {})
  };
}

export async function checkEvidenceChain(executor: Executor = defaultExecutor): Promise<CheckOutcome> {
  const result = await executor.execute(sql`
    WITH r AS (
      SELECT sequence, receipt_hash, previous_hash,
             lag(receipt_hash) OVER (ORDER BY sequence) AS prior,
             payload_sha256 <> encode(sha256(convert_to(payload, 'UTF8')), 'hex') AS bad_payload,
             receipt_hash <> encode(sha256(convert_to(concat_ws('|',
               COALESCE(previous_hash, ''), id::text, recorded_at_text, payload_sha256), 'UTF8')), 'hex') AS bad_hash
      FROM evidence_receipts
    )
    SELECT count(*) AS total,
           count(*) FILTER (WHERE bad_payload) AS bad_payload,
           count(*) FILTER (WHERE previous_hash IS DISTINCT FROM prior) AS bad_link,
           count(*) FILTER (WHERE bad_hash) AS bad_hash,
           min(sequence) FILTER (WHERE bad_payload OR bad_hash OR previous_hash IS DISTINCT FROM prior) AS first_bad,
           max(sequence) AS head_sequence,
           (array_agg(receipt_hash ORDER BY sequence DESC))[1] AS head_hash
    FROM r
  `);
  return evaluateChain("evidence receipt", toSummary(result.rows[0] as Record<string, unknown>));
}

export async function checkSecurityEventsChain(executor: Executor = defaultExecutor): Promise<CheckOutcome> {
  // occurred_at::text follows the session TimeZone, as it did when each event
  // was appended; the setting used here is recorded with the result.
  const result = await executor.execute(sql`
    WITH r AS (
      SELECT sequence, event_hash, previous_hash,
             lag(event_hash) OVER (ORDER BY sequence) AS prior,
             event_hash <> encode(sha256(convert_to(concat_ws('|',
               COALESCE(previous_hash, ''), id::text, occurred_at::text, action, outcome,
               COALESCE(actor_user_id::text, ''), COALESCE(actor_email, ''), COALESCE(actor_role, ''),
               COALESCE(program_id::text, ''), COALESCE(resource_type, ''), COALESCE(resource_id, ''),
               COALESCE(request_id, ''), COALESCE(source_ip, ''), COALESCE(details, '{}'::jsonb)::text
             ), 'UTF8')), 'hex') AS bad_hash
      FROM security_events
    )
    SELECT count(*) AS total,
           0 AS bad_payload,
           count(*) FILTER (WHERE previous_hash IS DISTINCT FROM prior) AS bad_link,
           count(*) FILTER (WHERE bad_hash) AS bad_hash,
           min(sequence) FILTER (WHERE bad_hash OR previous_hash IS DISTINCT FROM prior) AS first_bad,
           max(sequence) AS head_sequence,
           (array_agg(event_hash ORDER BY sequence DESC))[1] AS head_hash,
           current_setting('TimeZone') AS time_zone
    FROM r
  `);
  return evaluateChain("security event", toSummary(result.rows[0] as Record<string, unknown>));
}

// ---------------------------------------------------------- RFC 3161

export const TIMESTAMP_AUTHORITIES = [
  "https://freetsa.org/tsr",
  "http://timestamp.digicert.com"
] as const;

const SHA256_OID = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

/** DER TimeStampReq (RFC 3161 section 2.4.1) for a sha256 digest, certReq true. */
export function buildTimestampRequest(digest: Buffer, nonce: Buffer): Buffer {
  if (digest.length !== 32) throw new Error("sha256 digest must be 32 bytes");
  // INTEGER is signed: a leading 0x00 keeps the nonce positive.
  const nonceValue = nonce[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), nonce]) : nonce;
  const messageImprint = tlv(0x30, Buffer.concat([
    tlv(0x30, Buffer.concat([SHA256_OID, Buffer.from([0x05, 0x00])])),
    tlv(0x04, digest)
  ]));
  return tlv(0x30, Buffer.concat([
    tlv(0x02, Buffer.from([0x01])),
    messageImprint,
    tlv(0x02, nonceValue),
    Buffer.from([0x01, 0x01, 0xff])
  ]));
}

function readTlv(buffer: Buffer, offset: number): { tag: number; start: number; end: number } {
  const tag = buffer[offset];
  let length = buffer[offset + 1];
  if (tag === undefined || length === undefined) throw new Error("truncated DER");
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i += 1) length = (length << 8) | (buffer[start + i] ?? 0);
    start += count;
  }
  const end = start + length;
  if (end > buffer.length) throw new Error("truncated DER");
  return { tag, start, end };
}

/** PKIStatus from a TimeStampResp and the raw token (ContentInfo) if granted. */
export function parseTimestampResponse(response: Buffer): { status: number; token: Buffer | null } {
  const outer = readTlv(response, 0);
  if (outer.tag !== 0x30) throw new Error("TimeStampResp is not a SEQUENCE");
  const statusInfo = readTlv(response, outer.start);
  if (statusInfo.tag !== 0x30) throw new Error("PKIStatusInfo is not a SEQUENCE");
  const statusInt = readTlv(response, statusInfo.start);
  if (statusInt.tag !== 0x02) throw new Error("PKIStatus is not an INTEGER");
  const status = response.subarray(statusInt.start, statusInt.end).reduce((n, b) => (n << 8) | b, 0);
  const token = statusInfo.end < outer.end ? response.subarray(statusInfo.end, outer.end) : null;
  return { status, token };
}

export interface TimestampAttempt {
  authority: string;
  status: number | null;
  error: string | null;
  tokenBase64: string | null;
  verification: TimestampVerification | null;
}

export function evaluateTimestamp(headHash: string | null, attempts: TimestampAttempt[]): CheckOutcome {
  const withoutTokens = attempts.map(({ tokenBase64: _token, ...rest }) => rest);
  if (!headHash) {
    return { result: "error", summary: "No evidence receipts to timestamp yet.", failures: ["empty chain"], outputs: { attempts: withoutTokens } };
  }
  const granted = attempts.find(
    (a) => (a.status === 0 || a.status === 1) && a.tokenBase64 && a.verification?.verified === true
  );
  if (granted) {
    return {
      result: "pass",
      summary: `${granted.authority} timestamped chain head ${headHash.slice(0, 16)} at ${granted.verification!.genTime ?? "?"}.`,
      failures: [],
      inputs: { headHash },
      outputs: {
        authority: granted.authority,
        genTime: granted.verification!.genTime,
        signer: granted.verification!.signer,
        trustAnchor: granted.verification!.anchor,
        token: granted.tokenBase64,
        attempts: withoutTokens
      }
    };
  }
  return {
    result: "error",
    summary: "No time-stamping authority returned a token that verifies.",
    failures: attempts.map((a) => `${a.authority}: ${a.error ?? a.verification?.reason ?? `status ${a.status}`}`),
    inputs: { headHash },
    outputs: { attempts: withoutTokens }
  };
}

export async function checkChainTimestamp(): Promise<CheckOutcome> {
  const head = await db.execute(sql`
    SELECT sequence, receipt_hash FROM evidence_receipts ORDER BY sequence DESC LIMIT 1
  `);
  const row = head.rows[0] as { sequence?: unknown; receipt_hash?: string } | undefined;
  const headHash = row?.receipt_hash ?? null;
  const attempts: TimestampAttempt[] = [];
  if (headHash) {
    const digest = Buffer.from(headHash, "hex");
    for (const authority of TIMESTAMP_AUTHORITIES) {
      const nonce = randomBytes(8);
      try {
        const response = await fetch(authority, {
          method: "POST",
          headers: { "content-type": "application/timestamp-query" },
          body: buildTimestampRequest(digest, nonce),
          signal: AbortSignal.timeout(15_000)
        });
        const body = Buffer.from(await response.arrayBuffer());
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = parseTimestampResponse(body);
        const verification = parsed.token ? verifyTimestampToken(parsed.token, digest, nonce) : null;
        attempts.push({ authority, status: parsed.status, error: null, tokenBase64: parsed.token?.toString("base64") ?? null, verification });
        if (parsed.status <= 1 && verification?.verified) break;
      } catch (error) {
        attempts.push({ authority, status: null, error: (error as Error).message.slice(0, 200), tokenBase64: null, verification: null });
      }
    }
  }
  const outcome = evaluateTimestamp(headHash, attempts);
  return { ...outcome, inputs: { ...outcome.inputs, headSequence: row?.sequence === undefined ? null : Number(row.sequence) } };
}
