import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature
} from "node:crypto";

export type LocalLoginMode = "enabled" | "break_glass" | "disabled";

export interface OidcConfig {
  configured: boolean;
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
  requiredAcr: string | null;
  requireMfa: boolean;
  allowedDomains: string[];
  /** OIDC_TENANT_ID, lowercased; id tokens must carry a matching `tid`. */
  tenantId: string | null;
  /** OIDC_ALLOWED_PROGRAM_IDS, lowercased UUIDs; empty when unset or invalid. */
  allowedProgramIds: string[];
  localLoginMode: LocalLoginMode;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * Every host a Microsoft Entra issuer can use. For each one the first path
 * segment is the tenant: https://<host>/<tid>/v2.0 for v2.0 tokens and
 * https://<host>/<tid>/ for v1.0 tokens. Matching is on the exact hostname
 * (lowercased, one trailing dot removed), so a look-alike such as
 * login.microsoftonline.com.evil.example or evilsts.windows.net is not Entra
 * and needs no tenant.
 *
 * Sources (checked 2026-10-10):
 * - National cloud endpoints (global .com, US Government .us, China
 *   login.partner.microsoftonline.cn):
 *   https://learn.microsoft.com/en-us/entra/identity-platform/authentication-national-cloud
 * - Older China login host login.chinacloudapi.cn:
 *   https://learn.microsoft.com/en-us/graph/deployments
 * - Global aliases login.microsoft.com, login.windows.net and the US
 *   Government login-us.microsoftonline.com (endpoint set 56):
 *   https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges
 * - iss carries the tenant GUID; v2.0 issuers end in /v2.0:
 *   https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
 *   https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
 * - v1.0 issuer hosts sts.windows.net (global and US Government) and
 *   sts.chinacloudapi.cn (China); the claims references do not name the v1
 *   host, this community answer does:
 *   https://learn.microsoft.com/en-us/answers/questions/1190472/what-are-the-token-issuers-for-the-sovereign-cloud
 * Azure Germany (login.microsoftonline.de) closed on 2021-10-29 and is left out.
 */
const ENTRA_ISSUER_HOSTS = new Set([
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.windows.net",
  "sts.windows.net",
  "login.microsoftonline.us",
  "login-us.microsoftonline.com",
  "login.partner.microsoftonline.cn",
  "login.chinacloudapi.cn",
  "sts.chinacloudapi.cn"
]);

/**
 * Parse OIDC_ALLOWED_PROGRAM_IDS (comma-separated UUIDs). One malformed entry
 * rejects the whole list, which leaves OIDC disabled: a typo must not quietly
 * shrink or widen which programs may sign in through SSO.
 */
function parseAllowedProgramIds(value: string | undefined): string[] {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (entries.some((entry) => !UUID_PATTERN.test(entry))) return [];
  return [...new Set(entries)];
}

/**
 * An Entra issuer is tenant specific (https://login.microsoftonline.com/<tid>/v2.0,
 * https://sts.windows.net/<tid>/, or the same on a national-cloud host).
 * It is accepted only when OIDC_TENANT_ID is a tenant GUID naming that same
 * tenant, so a multi-tenant endpoint (/common, /organizations, /consumers) or
 * a copy-paste from another tenant stays disabled.
 */
function entraTenantMatches(issuerUrl: string, tenantId: string | null): boolean {
  let url: URL;
  try {
    url = new URL(issuerUrl);
  } catch {
    return false;
  }
  // Strip every trailing dot: `sts.windows.net..` must not escape the gate.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!ENTRA_ISSUER_HOSTS.has(host)) return true;
  const issuerTenant = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  return Boolean(tenantId && UUID_PATTERN.test(tenantId) && issuerTenant === tenantId);
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function isAllowedOidcUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return process.env.NODE_ENV !== "production" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getOidcConfig(): OidcConfig {
  const issuerUrl = process.env.OIDC_ISSUER_URL?.trim().replace(/\/$/, "") ?? "";
  const clientId = process.env.OIDC_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.OIDC_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = process.env.OIDC_REDIRECT_URI?.trim() ?? "";
  const stateSecret = process.env.OIDC_STATE_SECRET?.trim() ?? "";
  const tenantId = process.env.OIDC_TENANT_ID?.trim().toLowerCase() || null;
  const allowedProgramIds = parseAllowedProgramIds(process.env.OIDC_ALLOWED_PROGRAM_IDS);
  const configured = Boolean(
    issuerUrl || clientId || clientSecret || redirectUri || stateSecret
  );
  // No allowed program means no SSO user could pass the per-login program
  // check, so the integration counts as not configured.
  const enabled = Boolean(
    isAllowedOidcUrl(issuerUrl) &&
    isAllowedOidcUrl(redirectUri) &&
    clientId &&
    clientSecret &&
    stateSecret.length >= 32 &&
    allowedProgramIds.length > 0 &&
    entraTenantMatches(issuerUrl, tenantId)
  );
  const requestedMode = process.env.LOCAL_LOGIN_MODE?.trim();
  let localLoginMode: LocalLoginMode;
  if (
    requestedMode === "enabled" ||
    requestedMode === "break_glass" ||
    requestedMode === "disabled"
  ) {
    // Local access policy remains binding even when the IdP is unusable.
    localLoginMode = requestedMode;
  } else if (requestedMode || (configured && !enabled)) {
    // A typo or incomplete SSO setup must not silently permit local access.
    localLoginMode = "disabled";
  } else {
    localLoginMode = enabled ? "break_glass" : "enabled";
  }
  return {
    configured,
    enabled,
    issuerUrl,
    clientId,
    clientSecret,
    redirectUri,
    stateSecret,
    requiredAcr: process.env.OIDC_REQUIRED_ACR?.trim() || null,
    requireMfa:
      process.env.OIDC_REQUIRE_MFA === undefined
        ? configured
        : truthy(process.env.OIDC_REQUIRE_MFA),
    allowedDomains: (process.env.OIDC_ALLOWED_DOMAINS ?? "")
      .split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
    tenantId,
    allowedProgramIds,
    localLoginMode
  };
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discoveryCache: { issuerUrl: string; value: OidcDiscovery } | null = null;

export async function loadOidcDiscovery(config: OidcConfig): Promise<OidcDiscovery> {
  if (discoveryCache?.issuerUrl === config.issuerUrl) return discoveryCache.value;
  const response = await fetch(`${config.issuerUrl}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}`);
  const body = (await response.json()) as Partial<OidcDiscovery>;
  if (
    typeof body.issuer !== "string" ||
    typeof body.authorization_endpoint !== "string" ||
    typeof body.token_endpoint !== "string" ||
    typeof body.jwks_uri !== "string"
  ) {
    throw new Error("OIDC discovery response is incomplete");
  }
  const value: OidcDiscovery = {
    issuer: body.issuer.replace(/\/$/, ""),
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    jwks_uri: body.jwks_uri
  };
  if (value.issuer !== config.issuerUrl) {
    throw new Error("OIDC discovery issuer does not match configured issuer");
  }
  if (
    !isAllowedOidcUrl(value.authorization_endpoint) ||
    !isAllowedOidcUrl(value.token_endpoint) ||
    !isAllowedOidcUrl(value.jwks_uri)
  ) {
    throw new Error("OIDC discovery contains an insecure endpoint");
  }
  discoveryCache = { issuerUrl: config.issuerUrl, value };
  return value;
}

export interface OidcState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
  /**
   * Set when this sign-in follows an idle expiry (lib/auth/idle-reauth.ts):
   * epoch seconds at /start. The id_token's auth_time must not be earlier.
   */
  authenticatedAfter?: number;
}

export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/api/") ||
    value.includes("\\")
  ) {
    return "/chat";
  }
  return value;
}

export function createOidcState(
  returnTo: string,
  options: { reauthenticate?: boolean } = {}
): OidcState {
  const now = Date.now();
  return {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    codeVerifier: randomBytes(48).toString("base64url"),
    returnTo: safeReturnTo(returnTo),
    expiresAt: now + 10 * 60 * 1000,
    ...(options.reauthenticate ? { authenticatedAfter: Math.floor(now / 1000) } : {})
  };
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function sealOidcState(state: OidcState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function openOidcState(value: string, secret: string): OidcState | null {
  const [payload, provided] = value.split(".");
  if (!payload || !provided) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(provided, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as
      Partial<OidcState>;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.codeVerifier !== "string" ||
      typeof parsed.returnTo !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt < Date.now() ||
      (parsed.authenticatedAfter !== undefined &&
        typeof parsed.authenticatedAfter !== "number")
    ) {
      return null;
    }
    return {
      state: parsed.state,
      nonce: parsed.nonce,
      codeVerifier: parsed.codeVerifier,
      returnTo: safeReturnTo(parsed.returnTo),
      expiresAt: parsed.expiresAt,
      ...(parsed.authenticatedAfter !== undefined
        ? { authenticatedAfter: parsed.authenticatedAfter }
        : {})
    };
  } catch {
    return null;
  }
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
}

export interface OidcClaims {
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  nbf?: unknown;
  nonce?: unknown;
  sub?: unknown;
  tid?: unknown;
  oid?: unknown;
  xms_edov?: unknown;
  email?: unknown;
  preferred_username?: unknown;
  upn?: unknown;
  name?: unknown;
  acr?: unknown;
  amr?: unknown;
  auth_time?: unknown;
}

/**
 * A sign-in after an idle expiry whose id_token does not show a fresh
 * authentication. `reason` is the short code recorded in the audit event.
 */
export class OidcReauthError extends Error {
  constructor(readonly reason: "auth_time_missing" | "auth_time_stale") {
    super(
      reason === "auth_time_missing"
        ? "OIDC id_token has no auth_time; add the auth_time optional claim to the ID token"
        : "OIDC sign-in after an idle expiry did not re-authenticate"
    );
  }
}

let jwksCache: { uri: string; keys: Record<string, unknown>[]; expiresAt: number } | null = null;

async function loadJwks(uri: string, force = false): Promise<Record<string, unknown>[]> {
  if (!force && jwksCache?.uri === uri && jwksCache.expiresAt > Date.now()) {
    return jwksCache.keys;
  }
  const response = await fetch(uri, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`OIDC JWKS returned HTTP ${response.status}`);
  const body = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error("OIDC JWKS response has no keys");
  const keys = body.keys.filter(
    (key): key is Record<string, unknown> => typeof key === "object" && key !== null
  );
  jwksCache = { uri, keys, expiresAt: Date.now() + 60 * 60 * 1000 };
  return keys;
}

function readJwtPart<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function includesAudience(audience: unknown, clientId: string): boolean {
  return audience === clientId ||
    (Array.isArray(audience) && audience.some((item) => item === clientId));
}

export async function verifyOidcIdToken(input: {
  idToken: string;
  nonce: string;
  config: OidcConfig;
  discovery: OidcDiscovery;
  /** OidcState.authenticatedAfter; when set, auth_time must not be earlier. */
  authenticatedAfter?: number;
}): Promise<{
  claims: OidcClaims;
  subject: string;
  tenantId: string | null;
  objectId: string | null;
  email: string;
  name: string | null;
}> {
  const parts = input.idToken.split(".");
  if (parts.length !== 3) throw new Error("OIDC id_token is malformed");
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (!encodedHeader || !encodedClaims || !encodedSignature) {
    throw new Error("OIDC id_token is malformed");
  }
  const header = readJwtPart<JwtHeader>(encodedHeader);
  const claims = readJwtPart<OidcClaims>(encodedClaims);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("OIDC id_token must use RS256 with a key id");
  }
  let keys = await loadJwks(input.discovery.jwks_uri);
  let jwk = keys.find((key) => key["kid"] === header.kid);
  if (!jwk) {
    keys = await loadJwks(input.discovery.jwks_uri, true);
    jwk = keys.find((key) => key["kid"] === header.kid);
  }
  if (!jwk) throw new Error("OIDC signing key was not found");
  const publicKey = createPublicKey({ key: jwk as never, format: "jwk" });
  const validSignature = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    publicKey,
    Buffer.from(encodedSignature, "base64url")
  );
  if (!validSignature) throw new Error("OIDC id_token signature is invalid");

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== input.discovery.issuer) throw new Error("OIDC issuer mismatch");
  if (!includesAudience(claims.aud, input.config.clientId)) {
    throw new Error("OIDC audience mismatch");
  }
  if (
    Array.isArray(claims.aud) &&
    claims.aud.length > 1 &&
    claims.azp !== input.config.clientId
  ) {
    throw new Error("OIDC authorized party mismatch");
  }
  if (typeof claims.exp !== "number" || claims.exp <= now - 60) {
    throw new Error("OIDC id_token is expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) {
    throw new Error("OIDC id_token is not active yet");
  }
  if (claims.nonce !== input.nonce) throw new Error("OIDC nonce mismatch");
  if (input.authenticatedAfter !== undefined) {
    // prompt=login was sent; a silent SSO sign-in carries the auth_time of
    // the earlier Entra sign-in. Same 60-second clock allowance as exp/nbf.
    if (typeof claims.auth_time !== "number") {
      throw new OidcReauthError("auth_time_missing");
    }
    if (claims.auth_time < input.authenticatedAfter - 60) {
      throw new OidcReauthError("auth_time_stale");
    }
  }
  // `sub` is the stable per-app identifier the account binding keys on.
  if (typeof claims.sub !== "string" || claims.sub.trim() === "") {
    throw new Error("OIDC id_token has no subject");
  }
  const tokenTenant = typeof claims.tid === "string" ? claims.tid.trim().toLowerCase() : null;
  if (input.config.tenantId && tokenTenant !== input.config.tenantId) {
    throw new Error("OIDC tenant mismatch");
  }
  if (input.config.requiredAcr && claims.acr !== input.config.requiredAcr) {
    throw new Error("OIDC authentication context does not meet policy");
  }
  const amr = Array.isArray(claims.amr)
    ? claims.amr.filter((item): item is string => typeof item === "string")
    : [];
  if (input.config.requireMfa && !amr.includes("mfa")) {
    throw new Error("OIDC token does not contain MFA evidence");
  }
  const rawEmail = [claims.email, claims.preferred_username, claims.upn].find(
    (value): value is string => typeof value === "string" && value.includes("@")
  );
  if (!rawEmail) throw new Error("OIDC token has no email claim");
  const email = rawEmail.trim().toLowerCase();
  if (input.config.allowedDomains.length > 0) {
    const domain = email.split("@")[1] ?? "";
    if (!input.config.allowedDomains.includes(domain)) {
      throw new Error("OIDC email domain is not allowed");
    }
  }
  return {
    claims,
    subject: claims.sub,
    tenantId: tokenTenant,
    objectId: typeof claims.oid === "string" && claims.oid ? claims.oid : null,
    email,
    name: typeof claims.name === "string" ? claims.name.trim().slice(0, 200) : null
  };
}
