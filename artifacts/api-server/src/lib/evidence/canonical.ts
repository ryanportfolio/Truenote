import { createHash } from "node:crypto";

/**
 * Deterministic JSON for evidence payloads: object keys sorted by UTF-16 code
 * unit order at every depth, no whitespace, `undefined` members dropped.
 * The database stores this string byte for byte and hashes it, so anyone can
 * re-serialize a parsed payload with this function and get the same sha256.
 *
 * Non-finite numbers, functions, symbols and bigints are refused rather than
 * silently turned into null: a receipt must say exactly what was observed.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case "object": {
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      if (Array.isArray(value)) {
        return `[${value
          .map((item, index) =>
            item === undefined ? "null" : serialize(item, `${path}[${index}]`)
          )
          .join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries
        .map(([key, member]) => `${JSON.stringify(key)}:${serialize(member, `${path}.${key}`)}`)
        .join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The chain rule from lib/db/sql/0011_evidence_receipts.sql, for verifiers
 * outside the database (the monthly export, tests).
 */
export function receiptHash(
  previousHash: string | null,
  id: string,
  recordedAtText: string,
  payload: string
): string {
  return sha256Hex(
    [previousHash ?? "", id, recordedAtText, sha256Hex(payload)].join("|")
  );
}
