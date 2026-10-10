// Contract tests for server.mjs against a fake clamd. No ClamAV needed:
//   node --test services/scanner/test/
// The real engine is exercised by smoke.mjs against the built image.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { createScannerServer, parseClamdVersion, parseScanReply } from "../server.mjs";

const TOKEN = "t".repeat(40);
const HMAC_KEY = "k".repeat(40);
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clamdDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
}

/** Minimal clamd: VERSION and INSTREAM, flags EICAR. */
function startFakeClamd(state) {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let command = null;
    const received = [];
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (command === null) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        command = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 1);
        if (command === "zVERSION") {
          socket.end(`ClamAV 1.4.6/27790/${clamdDate(state.signaturesBuiltAt)}\0`);
          return;
        }
      }
      if (command !== "zINSTREAM") return;
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const body = Buffer.concat(received).toString("latin1");
          socket.end(
            body.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")
              ? "stream: Eicar-Test-Signature FOUND\0"
              : "stream: OK\0"
          );
          return;
        }
        if (buffer.length < 4 + size) return;
        received.push(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function headersFor(body, overrides = {}) {
  return {
    "Content-Type": "application/octet-stream",
    Authorization: `Bearer ${TOKEN}`,
    "X-Content-SHA256": createHash("sha256").update(body).digest("hex"),
    "X-Content-Type": "text/plain",
    "X-Original-Filename": encodeURIComponent("notes.txt"),
    "X-Truenote-Signature": `sha256=${createHmac("sha256", HMAC_KEY).update(body).digest("hex")}`,
    ...overrides
  };
}

describe("scanner wrapper", () => {
  const state = { signaturesBuiltAt: new Date(Date.now() - 3_600_000) };
  let clamd;
  let scanner;
  let base;

  before(async () => {
    clamd = await startFakeClamd(state);
    scanner = createScannerServer({
      token: TOKEN,
      hmacKey: HMAC_KEY,
      port: 0,
      maxBytes: 1024,
      maxSignatureAgeHours: 48,
      clamdSocket: `tcp://127.0.0.1:${clamd.address().port}`,
      clamdTimeoutMs: 5_000,
      maxConcurrentScans: 4
    });
    await new Promise((resolve) => scanner.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${scanner.address().port}`;
  });

  after(() => {
    scanner.close();
    clamd.close();
  });

  async function scan(body, overrides) {
    const response = await fetch(`${base}/scan`, {
      method: "POST",
      headers: headersFor(body, overrides),
      body
    });
    return { status: response.status, json: await response.json() };
  }

  it("returns clean for a clean file", async () => {
    const result = await scan(Buffer.from("plain policy text"));
    assert.equal(result.status, 200);
    assert.equal(result.json.verdict, "clean");
    assert.equal(result.json.signature, null);
    assert.equal(result.json.engine, "ClamAV 1.4.6 signatures 27790");
    assert.match(result.json.scanId, /^[0-9a-f-]{36}$/);
  });

  it("returns infected with the signature for EICAR", async () => {
    const result = await scan(Buffer.from(EICAR));
    assert.equal(result.status, 200);
    assert.equal(result.json.verdict, "infected");
    assert.equal(result.json.signature, "Eicar-Test-Signature");
  });

  it("refuses a missing or wrong bearer token", async () => {
    const body = Buffer.from("x");
    assert.equal((await scan(body, { Authorization: "Bearer wrong" })).status, 401);
    assert.equal((await scan(body, { Authorization: "" })).status, 401);
  });

  it("refuses a bad HMAC signature", async () => {
    const body = Buffer.from("x");
    const other = createHmac("sha256", "z".repeat(40)).update(body).digest("hex");
    const result = await scan(body, { "X-Truenote-Signature": `sha256=${other}` });
    assert.equal(result.status, 401);
    assert.equal(result.json.error, "bad_signature");
  });

  it("refuses a body whose SHA-256 header does not match", async () => {
    const result = await scan(Buffer.from("x"), { "X-Content-SHA256": "0".repeat(64) });
    assert.equal(result.status, 400);
  });

  it("refuses a body over the size limit", async () => {
    const result = await scan(Buffer.alloc(2048, 0x61)).catch(() => ({ status: "reset" }));
    // The server answers 413 and closes; a client may see the reset instead.
    assert.ok(result.status === 413 || result.status === "reset");
  });

  it("reports health and fails it when signatures are stale", async () => {
    let response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    state.signaturesBuiltAt = new Date(Date.now() - 49 * 3_600_000);
    response = await fetch(`${base}/health`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "signatures_stale");
    const result = await scan(Buffer.from("plain"));
    assert.equal(result.status, 503);
    state.signaturesBuiltAt = new Date(Date.now() - 3_600_000);
  });

  it("fails health when clamd is down", async () => {
    const down = createScannerServer({
      token: TOKEN,
      hmacKey: HMAC_KEY,
      port: 0,
      maxBytes: 1024,
      maxSignatureAgeHours: 48,
      clamdSocket: "tcp://127.0.0.1:1",
      clamdTimeoutMs: 2_000,
      maxConcurrentScans: 4
    });
    await new Promise((resolve) => down.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${down.address().port}/health`);
    assert.equal(response.status, 503);
    down.close();
  });
});

describe("clamd reply parsing", () => {
  it("parses VERSION with a space-padded day", () => {
    const parsed = parseClamdVersion("ClamAV 1.4.6/27790/Thu Oct  9 07:24:01 2026");
    assert.equal(parsed.engine, "ClamAV 1.4.6 signatures 27790");
    assert.equal(parsed.signaturesBuiltAt.toISOString(), "2026-10-09T07:24:01.000Z");
  });

  it("rejects unknown replies", () => {
    assert.equal(parseClamdVersion("ClamAV 1.4.6"), null);
    assert.equal(parseScanReply("INSTREAM size limit exceeded. ERROR"), null);
    assert.deepEqual(parseScanReply("stream: OK"), { verdict: "clean", signature: null });
  });
});
