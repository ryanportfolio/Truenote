/**
 * Shared helpers for building the URLs we embed in outgoing email.
 *
 * Extracted from routes/auth.ts so every email-sending path (password
 * reset, bulk-import invites) resolves the public base URL through ONE
 * security-reviewed implementation rather than a copy. Duplicating the
 * X-Forwarded-Host rationale below is exactly the kind of drift that
 * turns into a token-exfiltration bug.
 */

/**
 * Resolve the public base URL we should embed in outgoing emails.
 *
 * Production posture (NODE_ENV=production): APP_BASE_URL is the ONLY
 * source. We refuse to fall back to request headers because
 * X-Forwarded-Host is attacker-controlled — a request with a spoofed
 * header would otherwise embed the attacker's domain into a victim's
 * email, delivering the plaintext token to the attacker on click.
 * Returning null causes the email send to abort (logged warning), which
 * is strictly better than mailing a compromised link.
 *
 * Dev posture: APP_BASE_URL still wins if set; otherwise fall back to
 * X-Forwarded-Proto / X-Forwarded-Host / req.get("host") so a
 * developer running on localhost without env vars gets a clickable
 * link in their terminal-logged email.
 *
 * The startup check in index.ts also refuses to boot in production
 * without APP_BASE_URL, so the null branch is defense-in-depth — the
 * exploit window only opens if the startup check is bypassed.
 */
export function resolveAppBaseUrl(
  req: import("express").Request
): string | null {
  const fromEnv = process.env.APP_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") {
    return null;
  }
  const forwardedProto =
    req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  const forwardedHost =
    req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host");
  return `${forwardedProto}://${forwardedHost}`.replace(/\/$/, "");
}
