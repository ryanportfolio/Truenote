// Smoke test against a running scanner (the real ClamAV engine):
//   SCANNER_TOKEN=... SCANNER_HMAC_KEY=... node services/scanner/test/smoke.mjs http://127.0.0.1:8080
// Waits for /health, then checks: clean text and a minimal PDF are clean,
// EICAR is infected, zips nested past ClamAV's recursion limit are flagged
// (AlertExceedsMax), a wrong token or HMAC gets 401, a body over
// 20 MiB is refused. Exits non-zero on the first failure.
import { createHash, createHmac } from "node:crypto";
import { crc32 } from "node:zlib";

const base = process.argv[2] ?? "http://127.0.0.1:8080";
const token = process.env.SCANNER_TOKEN ?? "";
const hmacKey = process.env.SCANNER_HMAC_KEY ?? "";
const healthWaitSeconds = Number(process.env.SMOKE_HEALTH_WAIT_SECONDS ?? 600);
if (!token || !hmacKey) throw new Error("Set SCANNER_TOKEN and SCANNER_HMAC_KEY");

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;

/** One-entry zip, stored (no compression). */
function storedZip(name, data) {
  const fileName = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(local.length + fileName.length + data.length, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

/** Zips nested 20 deep, past clamd's MaxRecursion (17). */
function nestedZip(depth = 20) {
  let data = Buffer.from("innermost");
  for (let level = 0; level < depth; level += 1) data = storedZip(`level${level}.zip`, data);
  return data;
}

async function scan(body, { authToken = token, key = hmacKey } = {}) {
  const response = await fetch(`${base}/scan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${authToken}`,
      "X-Content-SHA256": createHash("sha256").update(body).digest("hex"),
      "X-Content-Type": "application/octet-stream",
      "X-Original-Filename": encodeURIComponent("smoke-test"),
      "X-Truenote-Signature": `sha256=${createHmac("sha256", key).update(body).digest("hex")}`
    },
    body,
    signal: AbortSignal.timeout(60_000)
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

function check(label, condition, detail) {
  if (!condition) {
    console.error(`FAIL ${label}: ${JSON.stringify(detail)}`);
    process.exitCode = 1;
    throw new Error(label);
  }
  console.log(`ok   ${label}`);
}

const deadline = Date.now() + healthWaitSeconds * 1000;
let health = null;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
    health = { status: response.status, json: await response.json() };
    if (response.status === 200) break;
  } catch {
    health = null;
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
check("health 200", health?.status === 200, health);
console.log(`     engine ${health.json.engine}, signatures ${health.json.signatureAgeHours} h old`);

const clean = await scan(Buffer.from("Cancellation fee for plan X is listed in section 4."));
check("clean text -> clean", clean.status === 200 && clean.json.verdict === "clean", clean);

const pdf = await scan(Buffer.from(PDF));
check("clean PDF -> clean", pdf.status === 200 && pdf.json.verdict === "clean", pdf);

const eicar = await scan(Buffer.from(EICAR));
check(
  "EICAR -> infected",
  eicar.status === 200 && eicar.json.verdict === "infected" && /eicar/i.test(eicar.json.signature ?? ""),
  eicar
);

const bomb = await scan(nestedZip());
check(
  "zip nested past the recursion limit -> infected",
  bomb.status === 200 && bomb.json.verdict === "infected" && /Limits.Exceeded/.test(bomb.json.signature ?? ""),
  bomb
);

const badHmac = await scan(Buffer.from(EICAR), { key: "wrong-key-wrong-key-wrong-key-wrong" });
check("bad HMAC -> 401", badHmac.status === 401, badHmac);

const badToken = await scan(Buffer.from("x"), { authToken: "wrong" });
check("bad token -> 401", badToken.status === 401, badToken);

const oversize = await scan(Buffer.alloc(20 * 1024 * 1024 + 1, 0x61)).catch((error) => ({
  status: "connection closed",
  json: String(error)
}));
check("over 20 MiB -> refused", oversize.status === 413 || oversize.status === "connection closed", oversize);
