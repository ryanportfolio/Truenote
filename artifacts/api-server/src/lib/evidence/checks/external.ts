import { promises as dns } from "node:dns";
import tls from "node:tls";
import type { CheckOutcome } from "../receipts.js";

/**
 * Passive checks of the public site: TLS, redirects, response headers, CSP,
 * security.txt, DNS and /health. Only requests any visitor could make; no
 * active scanning. No database or app imports, so the outside-vantage
 * watcher (scripts/src/evidence-outside.ts, run by a scheduled GitHub
 * Action) runs the same code from GitHub's network.
 */

export const PUBLIC_ORIGIN = "https://truenote.org";
export const PUBLIC_HOSTS = ["truenote.org", "www.truenote.org"] as const;
const HSTS_MIN_SECONDS = 31_536_000;
const CERT_MIN_DAYS = 14;
const SECURITY_TXT_MIN_DAYS = 30;
const DAY_MS = 86_400_000;
const USER_AGENT = "truenote-evidence-harness (+https://truenote.org/.well-known/security.txt)";

function outcome(failures: string[], okSummary: string, outputs: Record<string, unknown>, inputs: Record<string, unknown>): CheckOutcome {
  return {
    result: failures.length === 0 ? "pass" : "fail",
    summary: failures.length === 0 ? okSummary : `${failures.length} condition(s) not met.`,
    failures,
    inputs,
    outputs
  };
}

async function get(url: string): Promise<Response> {
  return fetch(url, {
    redirect: "manual",
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000)
  });
}

// --------------------------------------------------------------------- TLS

export interface TlsObservation {
  host: string;
  protocol: string | null;
  authorized: boolean;
  authorizationError: string | null;
  subject: string | null;
  issuer: string | null;
  validTo: string | null;
  daysToExpiry: number | null;
  /** Error code from a handshake capped at TLSv1.1; null if it succeeded. */
  legacyHandshakeError: string | null;
  legacyHandshakeSucceeded: boolean;
}

function handshake(
  host: string,
  options: tls.ConnectionOptions
): Promise<{ socket: tls.TLSSocket } | { error: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, ...options });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) });
    }, 10_000);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      resolve({ socket });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ error });
    });
  });
}

const CERTIFICATE_ERROR = /CERT|ALTNAME|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/;

export async function observeTls(host: string, now = new Date()): Promise<TlsObservation> {
  // Default verification: an untrusted, expired or mismatched certificate
  // fails the handshake and its error code is recorded as the failure.
  const modern = await handshake(host, { minVersion: "TLSv1.2" });
  let observation: TlsObservation = {
    host,
    protocol: null,
    authorized: false,
    authorizationError: null,
    subject: null,
    issuer: null,
    validTo: null,
    daysToExpiry: null,
    legacyHandshakeError: null,
    legacyHandshakeSucceeded: false
  };
  if ("socket" in modern) {
    const cert = modern.socket.getPeerCertificate();
    const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
    observation = {
      ...observation,
      protocol: modern.socket.getProtocol(),
      authorized: modern.socket.authorized,
      authorizationError: modern.socket.authorizationError
        ? String(modern.socket.authorizationError)
        : null,
      subject: cert.subject?.CN ? String(cert.subject.CN) : null,
      issuer: cert.issuer ? [cert.issuer.O, cert.issuer.CN].filter(Boolean).join(" / ") : null,
      validTo: validTo?.toISOString() ?? null,
      daysToExpiry: validTo ? Math.floor((validTo.getTime() - now.getTime()) / DAY_MS) : null
    };
    modern.socket.destroy();
  } else {
    observation.authorizationError = modern.error.code ?? modern.error.message;
  }
  // SECLEVEL=0 lets this client offer TLS 1.0/1.1 at all, so a failure means
  // the server refused, not that local OpenSSL declined to try.
  const legacy = await handshake(host, {
    minVersion: "TLSv1",
    maxVersion: "TLSv1.1",
    ciphers: "DEFAULT@SECLEVEL=0"
  });
  if ("socket" in legacy) {
    observation.legacyHandshakeSucceeded = true;
    legacy.socket.destroy();
  } else {
    observation.legacyHandshakeError = legacy.error.code ?? legacy.error.message;
    // Certificate verification runs only after the server agreed to the
    // legacy protocol version, so a certificate error still means it accepted.
    if (CERTIFICATE_ERROR.test(observation.legacyHandshakeError)) observation.legacyHandshakeSucceeded = true;
  }
  return observation;
}

/**
 * Errors that show the server itself refused the TLS 1.0/1.1 handshake: a
 * protocol_version or handshake_failure alert, or a reply in a newer record
 * version. Any other error (timeouts, resets, unreachable hosts, local
 * OpenSSL refusing to offer the version) proves nothing about the server.
 */
const SERVER_REFUSED_LEGACY = new Set([
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_TLSV1_ALERT_INSUFFICIENT_SECURITY",
  "ERR_SSL_WRONG_VERSION_NUMBER"
]);

export function evaluateTls(observations: TlsObservation[]): CheckOutcome {
  const failures: string[] = [];
  let inconclusive = false;
  for (const o of observations) {
    if (o.protocol !== "TLSv1.2" && o.protocol !== "TLSv1.3") {
      failures.push(`${o.host}: negotiated ${o.protocol ?? "nothing"}`);
    }
    if (!o.authorized) failures.push(`${o.host}: certificate not trusted (${o.authorizationError ?? "unknown"})`);
    if (o.daysToExpiry === null || o.daysToExpiry < CERT_MIN_DAYS) {
      failures.push(`${o.host}: certificate expires in ${o.daysToExpiry ?? "?"} day(s)`);
    }
    if (o.legacyHandshakeSucceeded) failures.push(`${o.host}: accepted a TLSv1.1-capped handshake`);
    if (!o.legacyHandshakeSucceeded && !SERVER_REFUSED_LEGACY.has(o.legacyHandshakeError ?? "")) inconclusive = true;
  }
  const result = outcome(failures, "TLS 1.2+ with trusted certificates; TLS 1.0/1.1 refused.", { hosts: observations }, { hosts: observations.map((o) => o.host), certMinDays: CERT_MIN_DAYS });
  if (failures.length === 0 && inconclusive) {
    return { ...result, result: "error", summary: "Legacy-TLS refusal could not be attributed to the server." };
  }
  return result;
}

export async function checkTls(): Promise<CheckOutcome> {
  const observations = [];
  for (const host of PUBLIC_HOSTS) observations.push(await observeTls(host));
  return evaluateTls(observations);
}

// --------------------------------------------------------------- redirects

export interface RedirectObservation {
  url: string;
  status: number;
  location: string | null;
}

export function evaluateRedirects(observations: RedirectObservation[]): CheckOutcome {
  const failures: string[] = [];
  const redirect = new Set([301, 302, 307, 308]);
  for (const o of observations) {
    if (!redirect.has(o.status)) {
      failures.push(`${o.url}: answered ${o.status}, expected a redirect`);
      continue;
    }
    if (!o.location?.startsWith("https://")) failures.push(`${o.url}: redirects to ${o.location ?? "nothing"}`);
    if (o.url.startsWith("https://www.") && !o.location?.startsWith(`${PUBLIC_ORIGIN}/`)) {
      failures.push(`${o.url}: does not redirect to ${PUBLIC_ORIGIN}`);
    }
  }
  return outcome(failures, "HTTP and www redirect to https://truenote.org.", { redirects: observations }, {});
}

export async function checkRedirects(): Promise<CheckOutcome> {
  const urls = ["http://truenote.org/", "http://www.truenote.org/", "https://www.truenote.org/"];
  const observations: RedirectObservation[] = [];
  for (const url of urls) {
    const response = await get(url);
    observations.push({ url, status: response.status, location: response.headers.get("location") });
  }
  return evaluateRedirects(observations);
}

// ----------------------------------------------------------------- headers

export function parseCsp(header: string | null): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of (header ?? "").split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), values);
  }
  return directives;
}

function recordedHeaders(headers: Headers): Record<string, string> {
  const names = [
    "strict-transport-security",
    "content-security-policy",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "permissions-policy",
    "cross-origin-opener-policy",
    "x-powered-by",
    "server"
  ];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) {
      // The CSP nonce changes per response; keep the policy shape stable.
      out[name] = name === "content-security-policy" ? value.replace(/'nonce-[^']+'/g, "'nonce-…'") : value;
    }
  }
  return out;
}

export function evaluateSecurityHeaders(status: number, headers: Record<string, string>): CheckOutcome {
  const failures: string[] = [];
  if (status !== 200) failures.push(`GET / answered ${status}`);
  const hsts = headers["strict-transport-security"] ?? "";
  const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
  if (maxAge < HSTS_MIN_SECONDS) failures.push(`HSTS max-age ${maxAge} < ${HSTS_MIN_SECONDS}`);
  if (!/includesubdomains/i.test(hsts)) failures.push("HSTS lacks includeSubDomains");
  if ((headers["x-content-type-options"] ?? "").toLowerCase() !== "nosniff") failures.push("X-Content-Type-Options is not nosniff");
  const frameAncestors = parseCsp(headers["content-security-policy"] ?? null).get("frame-ancestors");
  const xfo = (headers["x-frame-options"] ?? "").toUpperCase();
  if (xfo !== "DENY" && !(frameAncestors?.length === 1 && frameAncestors[0] === "'none'")) {
    failures.push("framing is not denied (X-Frame-Options or CSP frame-ancestors)");
  }
  if (!headers["referrer-policy"]) failures.push("no Referrer-Policy");
  if (!headers["permissions-policy"]) failures.push("no Permissions-Policy");
  if (headers["x-powered-by"]) failures.push(`X-Powered-By is sent: ${headers["x-powered-by"]}`);
  return outcome(failures, "Security headers present with required values.", { status, headers }, { url: `${PUBLIC_ORIGIN}/`, hstsMinSeconds: HSTS_MIN_SECONDS });
}

export function evaluateCsp(header: string | null): CheckOutcome {
  const failures: string[] = [];
  const csp = parseCsp(header);
  if (!header) failures.push("no Content-Security-Policy");
  if (!csp.has("default-src")) failures.push("no default-src");
  if (csp.get("object-src")?.join(" ") !== "'none'") failures.push("object-src is not 'none'");
  if (!csp.has("base-uri")) failures.push("no base-uri");
  if (csp.get("frame-ancestors")?.join(" ") !== "'none'") failures.push("frame-ancestors is not 'none'");
  const script = csp.get("script-src") ?? csp.get("default-src") ?? [];
  if (script.includes("'unsafe-inline'")) failures.push("script-src allows 'unsafe-inline'");
  if (script.includes("'unsafe-eval'")) failures.push("script-src allows 'unsafe-eval'");
  return outcome(
    failures,
    "CSP restricts scripts, objects, base URI and framing.",
    { directives: Object.fromEntries([...csp].map(([k, v]) => [k, v.map((s) => s.replace(/^'nonce-[^']+'$/, "'nonce-…'"))])) },
    { url: `${PUBLIC_ORIGIN}/` }
  );
}

export async function checkSecurityHeaders(): Promise<CheckOutcome> {
  const response = await get(`${PUBLIC_ORIGIN}/`);
  return evaluateSecurityHeaders(response.status, recordedHeaders(response.headers));
}

export async function checkCsp(): Promise<CheckOutcome> {
  const response = await get(`${PUBLIC_ORIGIN}/`);
  return evaluateCsp(response.headers.get("content-security-policy"));
}

// ------------------------------------------------------------ security.txt

export function evaluateSecurityTxt(status: number, body: string, now = new Date()): CheckOutcome {
  const failures: string[] = [];
  const fields: Record<string, string[]> = {};
  for (const line of body.split(/\r?\n/)) {
    const match = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
    if (match) (fields[match[1]!.toLowerCase()] ??= []).push(match[2]!.trim());
  }
  if (status !== 200) failures.push(`security.txt answered ${status}`);
  if (!fields.contact?.length) failures.push("no Contact field");
  const expires = fields.expires?.[0] ? new Date(fields.expires[0]) : null;
  const daysLeft = expires && !Number.isNaN(expires.getTime()) ? Math.floor((expires.getTime() - now.getTime()) / DAY_MS) : null;
  if (daysLeft === null) failures.push("no valid Expires field");
  else if (daysLeft < SECURITY_TXT_MIN_DAYS) failures.push(`Expires in ${daysLeft} day(s)`);
  return outcome(failures, "security.txt has a contact and a future expiry.", { status, fields, daysToExpiry: daysLeft }, { url: `${PUBLIC_ORIGIN}/.well-known/security.txt` });
}

export async function checkSecurityTxt(): Promise<CheckOutcome> {
  const response = await get(`${PUBLIC_ORIGIN}/.well-known/security.txt`);
  return evaluateSecurityTxt(response.status, (await response.text()).slice(0, 8_000));
}

// --------------------------------------------------------------------- DNS

async function resolveOrEmpty<T>(lookup: () => Promise<T[]>): Promise<T[] | { error: string }> {
  try {
    return await lookup();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return [];
    return { error: code ?? String(error) };
  }
}

export function evaluateDnsCaa(caa: Array<Record<string, unknown>> | { error: string }, records: Record<string, unknown>): CheckOutcome {
  if (!Array.isArray(caa)) {
    return { result: "error", summary: `CAA lookup failed: ${caa.error}`, failures: [caa.error], outputs: { records } };
  }
  // issuewild restricts wildcard certificates only; the public hosts need an
  // issue record. Wildcard restrictions are recorded with the records.
  const issuers = caa.filter((r) => typeof r.issue === "string");
  const failures = issuers.length === 0 ? ["no CAA issue record for truenote.org"] : [];
  return outcome(failures, "CAA records limit certificate issuance.", { caa, records }, { domain: "truenote.org" });
}

export async function checkDnsCaa(): Promise<CheckOutcome> {
  const caa = await resolveOrEmpty(
    async () => (await dns.resolveCaa("truenote.org")).map((record) => ({ ...record }) as Record<string, unknown>)
  );
  const records: Record<string, unknown> = {};
  for (const host of PUBLIC_HOSTS) {
    records[host] = {
      a: await resolveOrEmpty(() => dns.resolve4(host)),
      aaaa: await resolveOrEmpty(() => dns.resolve6(host)),
      cname: await resolveOrEmpty(() => dns.resolveCname(host))
    };
  }
  return evaluateDnsCaa(caa, records);
}

// ------------------------------------------------------------------ health

export function evaluateHealth(status: number, body: string, latencyMs: number): CheckOutcome {
  const failures: string[] = [];
  if (status !== 200) failures.push(`/health answered ${status}`);
  let ok = false;
  try {
    ok = (JSON.parse(body) as { ok?: unknown }).ok === true;
  } catch {
    ok = false;
  }
  if (!ok) failures.push("/health body is not {\"ok\":true}");
  return outcome(failures, `/health answered ok in ${latencyMs} ms.`, { status, latencyMs }, { url: `${PUBLIC_ORIGIN}/health` });
}

export async function checkHealth(): Promise<CheckOutcome> {
  const started = performance.now();
  const response = await get(`${PUBLIC_ORIGIN}/health`);
  const body = (await response.text()).slice(0, 1_000);
  return evaluateHealth(response.status, body, Math.round(performance.now() - started));
}
