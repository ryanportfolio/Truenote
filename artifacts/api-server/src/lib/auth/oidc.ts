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
  localLoginMode: LocalLoginMode;
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
  const configured = Boolean(
    issuerUrl || clientId || clientSecret || redirectUri || stateSecret
  );
  const enabled = Boolean(
    isAllowedOidcUrl(issuerUrl) &&
    isAllowedOidcUrl(redirectUri) &&
    clientId &&
    clientSecret &&
    stateSecret.length >= 32
  );
  const requestedMode = process.env.LOCAL_LOGIN_MODE?.trim();
  const localLoginMode: LocalLoginMode =
    requestedMode === "enabled" ||
    requestedMode === "break_glass" ||
    requestedMode === "disabled"
      ? requestedMode
      : enabled
        ? "break_glass"
        : "enabled";
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

export function createOidcState(returnTo: string): OidcState {
  return {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    codeVerifier: randomBytes(48).toString("base64url"),
    returnTo: safeReturnTo(returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000
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
      parsed.expiresAt < Date.now()
    ) {
      return null;
    }
    return {
      state: parsed.state,
      nonce: parsed.nonce,
      codeVerifier: parsed.codeVerifier,
      returnTo: safeReturnTo(parsed.returnTo),
      expiresAt: parsed.expiresAt
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
  email?: unknown;
  preferred_username?: unknown;
  upn?: unknown;
  name?: unknown;
  acr?: unknown;
  amr?: unknown;
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
}): Promise<{ claims: OidcClaims; email: string; name: string | null }> {
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
    email,
    name: typeof claims.name === "string" ? claims.name.trim().slice(0, 200) : null
  };
}
