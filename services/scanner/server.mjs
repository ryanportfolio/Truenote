// HTTP wrapper around clamd for the Truenote `scanner` service.
//
// Contract (client: artifacts/api-server/src/lib/security/content-scan.ts):
//   POST /scan, raw bytes, Content-Type application/octet-stream
//   Authorization: Bearer <SCANNER_TOKEN>
//   X-Truenote-Signature: sha256=<hex HMAC-SHA256 of the body with SCANNER_HMAC_KEY>
//   X-Content-SHA256: <hex SHA-256 of the body>
//   200 {verdict: "clean"|"infected", engine, scanId, signature}
// Every other outcome is a non-200 status, which the app treats as a failed
// scan and quarantines the upload.
//
// GET /health answers 200 only when clamd responds and its daily signature
// database is younger than SCANNER_MAX_SIGNATURE_AGE_HOURS.
//
// Logging: one line per request with scan id, outcome, byte count, SHA-256
// and duration. Never file contents, never the original filename.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";

const MiB = 1024 * 1024;

export function loadConfig(env = process.env) {
  const token = env.SCANNER_TOKEN ?? "";
  const hmacKey = env.SCANNER_HMAC_KEY ?? "";
  if (token.length < 32 || hmacKey.length < 32) {
    throw new Error("SCANNER_TOKEN and SCANNER_HMAC_KEY must each be set to at least 32 characters");
  }
  return {
    token,
    hmacKey,
    port: Number(env.PORT ?? 8080),
    // Matches the app's upload cap (artifacts/api-server/src/routes/documents.ts, MAX_BYTES).
    maxBytes: Number(env.SCANNER_MAX_BYTES ?? 20 * MiB),
    maxSignatureAgeHours: Number(env.SCANNER_MAX_SIGNATURE_AGE_HOURS ?? 48),
    clamdSocket: env.CLAMD_SOCKET ?? "/tmp/clamd.sock",
    clamdTimeoutMs: Number(env.CLAMD_TIMEOUT_MS ?? 50_000),
    maxConcurrentScans: Number(env.SCANNER_MAX_CONCURRENT ?? 4)
  };
}

/** `tcp://host:port` for tests, otherwise a Unix socket path. */
function clamdConnectOptions(address) {
  const tcp = /^tcp:\/\/([^:]+):(\d+)$/.exec(address);
  return tcp ? { host: tcp[1], port: Number(tcp[2]) } : { path: address };
}

/** Sends one clamd command (null-terminated `z` form) and returns the reply. */
function clamdRequest(config, command, body) {
  return new Promise((resolve, reject) => {
    const socket = connect(clamdConnectOptions(config.clamdSocket));
    const chunks = [];
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("clamd timed out")), config.clamdTimeoutMs);
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () =>
      finish(null, Buffer.concat(chunks).toString("utf8").replace(/\0+$/, "").trim())
    );
    socket.on("connect", () => {
      socket.write(`z${command}\0`);
      if (body) {
        // INSTREAM: 4-byte big-endian length before each chunk, zero length ends.
        for (let offset = 0; offset < body.length; offset += 64 * 1024) {
          const chunk = body.subarray(offset, Math.min(offset + 64 * 1024, body.length));
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      }
    });
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Parses clamd's VERSION reply, e.g. "ClamAV 1.4.6/27790/Thu Oct  9 07:24:01 2026".
 * The date is the daily database's build time; the container runs in UTC.
 */
export function parseClamdVersion(reply) {
  const match =
    /^ClamAV ([\w.-]+)\/(\d+)\/\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(reply);
  if (!match) return null;
  const [, engineVersion, signatureVersion, month, day, hour, minute, second, year] = match;
  const monthIndex = MONTHS.indexOf(month);
  if (monthIndex < 0) return null;
  return {
    engine: `ClamAV ${engineVersion} signatures ${signatureVersion}`,
    signaturesBuiltAt: new Date(
      Date.UTC(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second))
    )
  };
}

/** Parses an INSTREAM reply: "stream: OK" or "stream: <name> FOUND". */
export function parseScanReply(reply) {
  if (reply === "stream: OK") return { verdict: "clean", signature: null };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) return { verdict: "infected", signature: found[1] };
  return null;
}

/** Constant-time comparison of two strings of possibly different length. */
function safeEqual(a, b) {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

async function engineStatus(config, now = new Date()) {
  const version = parseClamdVersion(await clamdRequest(config, "VERSION"));
  if (!version) throw new Error("clamd returned an unrecognized VERSION reply");
  const ageHours = (now.getTime() - version.signaturesBuiltAt.getTime()) / 3_600_000;
  return { ...version, ageHours, fresh: ageHours <= config.maxSignatureAgeHours };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function log(fields) {
  console.log(`[scanner] ${JSON.stringify({ at: new Date().toISOString(), ...fields })}`);
}

export function createScannerServer(config) {
  function rejectTooLarge(req, res) {
    // Answer first, then drop the connection instead of reading the rest.
    res.setHeader("Connection", "close");
    res.on("finish", () => req.destroy());
    sendJson(res, 413, { error: "too_large", maxBytes: config.maxBytes });
  }

  let activeScans = 0;

  async function handleHealth(res) {
    try {
      const status = await engineStatus(config);
      sendJson(res, status.fresh ? 200 : 503, {
        ok: status.fresh,
        engine: status.engine,
        signatureAgeHours: Math.round(status.ageHours * 10) / 10,
        ...(status.fresh ? {} : { error: "signatures_stale" })
      });
    } catch {
      sendJson(res, 503, { ok: false, error: "clamd_unavailable" });
    }
  }

  async function handleScan(req, res, scanId, started) {
    const auth = req.headers.authorization ?? "";
    if (!safeEqual(auth, `Bearer ${config.token}`)) {
      log({ scanId, outcome: "unauthorized" });
      sendJson(res, 401, { error: "unauthorized" });
      req.resume();
      return;
    }
    const declared = Number(req.headers["content-length"]);
    if (!Number.isFinite(declared) || declared < 0) {
      sendJson(res, 411, { error: "length_required" });
      req.resume();
      return;
    }
    if (declared > config.maxBytes) {
      log({ scanId, outcome: "too_large", bytes: declared });
      rejectTooLarge(req, res);
      return;
    }
    if (activeScans >= config.maxConcurrentScans) {
      log({ scanId, outcome: "busy" });
      sendJson(res, 503, { error: "busy" });
      req.resume();
      return;
    }

    activeScans += 1;
    try {
      const chunks = [];
      let received = 0;
      for await (const chunk of req) {
        received += chunk.length;
        if (received > config.maxBytes) {
          log({ scanId, outcome: "too_large", bytes: received });
          rejectTooLarge(req, res);
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);

      const signature = String(req.headers["x-truenote-signature"] ?? "");
      const expected = `sha256=${createHmac("sha256", config.hmacKey).update(body).digest("hex")}`;
      if (!safeEqual(signature, expected)) {
        log({ scanId, outcome: "bad_signature", bytes: body.length });
        sendJson(res, 401, { error: "bad_signature" });
        return;
      }
      const sha256 = createHash("sha256").update(body).digest("hex");
      const declaredSha = String(req.headers["x-content-sha256"] ?? "").toLowerCase();
      if (declaredSha !== sha256) {
        log({ scanId, outcome: "sha256_mismatch", bytes: body.length });
        sendJson(res, 400, { error: "sha256_mismatch" });
        return;
      }

      const status = await engineStatus(config);
      if (!status.fresh) {
        log({ scanId, outcome: "signatures_stale", ageHours: Math.round(status.ageHours) });
        sendJson(res, 503, { error: "signatures_stale" });
        return;
      }
      const reply = await clamdRequest(config, "INSTREAM", body);
      const result = parseScanReply(reply);
      if (!result) {
        // clamd error text names no file; safe to log for diagnosis.
        log({ scanId, outcome: "clamd_error", reply: reply.slice(0, 200), bytes: body.length });
        sendJson(res, 503, { error: "scan_failed" });
        return;
      }
      log({
        scanId,
        outcome: result.verdict,
        signature: result.signature,
        bytes: body.length,
        sha256,
        ms: Date.now() - started
      });
      sendJson(res, 200, {
        verdict: result.verdict,
        engine: status.engine,
        scanId,
        signature: result.signature
      });
    } catch (error) {
      log({ scanId, outcome: "error", error: error instanceof Error ? error.message : "unknown" });
      if (!res.headersSent) sendJson(res, 503, { error: "scan_failed" });
    } finally {
      activeScans -= 1;
    }
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health" && req.method === "GET") {
      void handleHealth(res);
      return;
    }
    if (path === "/scan" && req.method === "POST") {
      void handleScan(req, res, randomUUID(), Date.now());
      return;
    }
    req.resume();
    sendJson(res, 404, { error: "not_found" });
  });
  // Bound slow uploads; the app's client gives up after 60 s.
  server.requestTimeout = 65_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  // "::" accepts IPv6 and IPv4; Railway's private network uses IPv6.
  createScannerServer(config).listen(config.port, "::", () => {
    log({ outcome: "listening", port: config.port, maxBytes: config.maxBytes });
  });
}
