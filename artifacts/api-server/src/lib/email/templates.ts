/**
 * Transactional email templates. Hand-written HTML strings — keeps audit
 * logs readable, no template runtime dep. Each renderer returns an HTML
 * body plus a plaintext fallback for clients that block HTML.
 *
 * Every interpolation into the HTML goes through escapeHtml so a stray
 * quote or bracket in any input field can't escape an attribute or open a
 * tag. Plaintext bodies use raw values because text/plain has no markup.
 */

/**
 * Minimal HTML escape for splicing untrusted values into an email
 * template. Base URLs come from APP_BASE_URL (operator-set) but are still
 * env-strings, so a misconfigured value could include angle brackets or
 * quotes that escape an href attribute. User name fields are
 * control-char-stripped at the zod schema but Unicode is still allowed —
 * escape it the same way so a `<` or `&` in a future schema relaxation
 * doesn't quietly become an XSS bug.
 */
export function escapeHtml(input: string): string {
  return input.replace(/[<>"'&]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#x27;";
      case "&":
        return "&amp;";
    }
    return c;
  });
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Render the password-reset email (self-service "forgot password" flow).
 * Plain text fallback exists for clients that block HTML or render
 * preview snippets.
 */
export function renderResetEmail(args: {
  name: string;
  resetUrl: string;
  expiresAt: Date;
}): RenderedEmail {
  const subject = "Reset your password";
  const expiresIso = args.expiresAt.toISOString();
  const safeName = escapeHtml(args.name);
  const safeUrl = escapeHtml(args.resetUrl);
  const safeExpires = escapeHtml(expiresIso);
  // Inline styles only — most email clients strip <style> tags.
  const html = `
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #0f172a; background: #f8fafc; padding: 24px;">
    <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px;">
      <h1 style="margin: 0 0 16px; font-size: 18px;">Reset your password</h1>
      <p>Hi ${safeName},</p>
      <p>We received a request to reset your password. Click the button below to choose a new one. This link expires at ${safeExpires}.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${safeUrl}" style="display: inline-block; background: #0f172a; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 500;">Reset password</a>
      </p>
      <p style="font-size: 13px; color: #64748b;">If the button doesn't work, paste this URL into your browser:</p>
      <p style="font-size: 13px; word-break: break-all;"><a href="${safeUrl}">${safeUrl}</a></p>
      <p style="font-size: 13px; color: #64748b;">If you didn't request a reset, you can ignore this email — your password won't change.</p>
    </div>
  </body>
</html>`.trim();
  const text = [
    `Hi ${args.name},`,
    "",
    "We received a request to reset your password. Use the link below to choose a new one:",
    "",
    args.resetUrl,
    "",
    `This link expires at ${expiresIso}.`,
    "",
    "If you didn't request a reset, you can ignore this email — your password won't change."
  ].join("\n");
  return { subject, html, text };
}

/**
 * Render the account-invitation email (admin bulk-import / create flow).
 *
 * Distinct from renderResetEmail because the framing is different: the
 * recipient did NOT request anything — an admin created an account for
 * them — so the copy is "an account was created for you, set your
 * password" rather than "we received a reset request." Both land on the
 * same /reset-password?token=… page and consume the same one-shot token;
 * only the wording differs.
 *
 * The invite carries a longer-lived token than a self-service reset (a
 * new hire may not open the email immediately). If it does expire, the
 * standard forgot-password flow issues a fresh link — the account already
 * exists and is active.
 */
export function renderInviteEmail(args: {
  name: string;
  setupUrl: string;
  expiresAt: Date;
}): RenderedEmail {
  const subject = "You've been added — set your password";
  const expiresIso = args.expiresAt.toISOString();
  const safeName = escapeHtml(args.name);
  const safeUrl = escapeHtml(args.setupUrl);
  const safeExpires = escapeHtml(expiresIso);
  const html = `
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #0f172a; background: #f8fafc; padding: 24px;">
    <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px;">
      <h1 style="margin: 0 0 16px; font-size: 18px;">Set up your account</h1>
      <p>Hi ${safeName},</p>
      <p>An account has been created for you. Click the button below to choose your password and sign in. This link expires at ${safeExpires}.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${safeUrl}" style="display: inline-block; background: #0f172a; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 500;">Set your password</a>
      </p>
      <p style="font-size: 13px; color: #64748b;">If the button doesn't work, paste this URL into your browser:</p>
      <p style="font-size: 13px; word-break: break-all;"><a href="${safeUrl}">${safeUrl}</a></p>
      <p style="font-size: 13px; color: #64748b;">If you weren't expecting this email, you can ignore it — no account can be used until a password is set.</p>
    </div>
  </body>
</html>`.trim();
  const text = [
    `Hi ${args.name},`,
    "",
    "An account has been created for you. Use the link below to choose your password and sign in:",
    "",
    args.setupUrl,
    "",
    `This link expires at ${expiresIso}.`,
    "",
    "If you weren't expecting this email, you can ignore it — no account can be used until a password is set."
  ].join("\n");
  return { subject, html, text };
}
