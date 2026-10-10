/**
 * WebAuthn relying-party settings for break-glass passkeys.
 *
 *   WEBAUTHN_RP_ID    RP ID (a host name, no scheme or port)
 *   WEBAUTHN_ORIGINS  comma list of origins allowed to sign assertions
 *
 * Each falls back to the host name / origin of APP_BASE_URL. Outside
 * production, with none of the three set, the local SPA preview is used
 * (`localhost`, `http://localhost:5180`).
 *
 * Returns null when nothing usable is configured: no RP ID, no origin, an
 * origin that does not parse, a plain-http origin in production, or an origin
 * whose host is neither the RP ID nor a subdomain of it. Callers then refuse
 * enrollment and fail the login MFA step closed.
 */

export const WEBAUTHN_RP_NAME = "Truenote";

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  origins: string[];
}

const LOCAL_RP_ID = "localhost";
const LOCAL_ORIGIN = "http://localhost:5180";

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hostMatchesRpId(host: string, rpId: string): boolean {
  return host === rpId || host.endsWith(`.${rpId}`);
}

export function getWebAuthnConfig(): WebAuthnConfig | null {
  const production = process.env.NODE_ENV === "production";
  const rawRpId = process.env.WEBAUTHN_RP_ID?.trim().toLowerCase() ?? "";
  const rawOrigins = (process.env.WEBAUTHN_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const baseUrl = parseUrl(process.env.APP_BASE_URL?.trim() ?? "");

  let rpId = rawRpId || baseUrl?.hostname.toLowerCase() || "";
  let origins = rawOrigins.length > 0 ? rawOrigins : baseUrl ? [baseUrl.origin] : [];

  if (!production && !rpId && origins.length === 0) {
    rpId = LOCAL_RP_ID;
    origins = [LOCAL_ORIGIN];
  }
  if (!rpId || origins.length === 0) return null;
  if (rpId.includes("/") || rpId.includes(":")) return null;

  const normalized: string[] = [];
  for (const origin of origins) {
    const url = parseUrl(origin);
    if (!url) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (production && url.protocol !== "https:") return null;
    if (!hostMatchesRpId(url.hostname.toLowerCase(), rpId)) return null;
    normalized.push(url.origin);
  }

  return { rpId, rpName: WEBAUTHN_RP_NAME, origins: [...new Set(normalized)] };
}
