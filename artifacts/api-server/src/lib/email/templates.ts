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

/** The SSO button label on the Login page (artifacts/rag-app/src/pages/Login.tsx); keep them equal. */
export const SSO_SIGN_IN_LABEL = "Continue with company SSO";

/**
 * Render the invitation for an account that signs in only through company
 * SSO (invitationKindFor returned "sso"). There is no password to choose
 * and no token in the link: it points at the sign-in page, and the first
 * SSO sign-in binds the company identity to this account (routes/oidc.ts).
 */
export function renderSsoInviteEmail(args: {
  name: string;
  signInUrl: string;
}): RenderedEmail {
  const subject = "You've been added: sign in with company SSO";
  const safeName = escapeHtml(args.name);
  const safeUrl = escapeHtml(args.signInUrl);
  const safeLabel = escapeHtml(SSO_SIGN_IN_LABEL);
  const html = `
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #0f172a; background: #f8fafc; padding: 24px;">
    <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px;">
      <h1 style="margin: 0 0 16px; font-size: 18px;">Your account is ready</h1>
      <p>Hi ${safeName},</p>
      <p>An account has been created for you. You sign in with your company account, so there is no password to set. Open the sign-in page and choose <strong>${safeLabel}</strong>.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${safeUrl}" style="display: inline-block; background: #0f172a; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 500;">Go to sign-in</a>
      </p>
      <p style="font-size: 13px; color: #64748b;">If the button doesn't work, paste this URL into your browser:</p>
      <p style="font-size: 13px; word-break: break-all;"><a href="${safeUrl}">${safeUrl}</a></p>
      <p style="font-size: 13px; color: #64748b;">If you weren't expecting this email, you can ignore it.</p>
    </div>
  </body>
</html>`.trim();
  const text = [
    `Hi ${args.name},`,
    "",
    "An account has been created for you. You sign in with your company account, so there is no password to set.",
    `Open the sign-in page below and choose "${SSO_SIGN_IN_LABEL}":`,
    "",
    args.signInUrl,
    "",
    "If you weren't expecting this email, you can ignore it."
  ].join("\n");
  return { subject, html, text };
}

/**
 * Sent instead of a reset link when someone asks to reset the password of
 * an account that signs in only through company SSO (LOCAL_LOGIN_MODE does
 * not allow it local login). No token is minted: reset-password would
 * refuse it. The forgot-password response is the same 204 either way, so
 * only the mailbox owner learns the account uses SSO.
 */
export function renderSsoResetNoticeEmail(args: {
  name: string;
  signInUrl: string;
}): RenderedEmail {
  const subject = "Sign in with company SSO";
  const safeName = escapeHtml(args.name);
  const safeUrl = escapeHtml(args.signInUrl);
  const safeLabel = escapeHtml(SSO_SIGN_IN_LABEL);
  const html = `
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #0f172a; background: #f8fafc; padding: 24px;">
    <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px;">
      <h1 style="margin: 0 0 16px; font-size: 18px;">Your account uses company SSO</h1>
      <p>Hi ${safeName},</p>
      <p>We received a request to reset your password. Your account signs in with your company account, so it has no password here to reset. Open the sign-in page and choose <strong>${safeLabel}</strong>.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${safeUrl}" style="display: inline-block; background: #0f172a; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 500;">Go to sign-in</a>
      </p>
      <p style="font-size: 13px; color: #64748b;">If you can't sign in with your company account, contact your IT team or a Truenote administrator.</p>
      <p style="font-size: 13px; color: #64748b;">If you didn't request this, you can ignore this email.</p>
    </div>
  </body>
</html>`.trim();
  const text = [
    `Hi ${args.name},`,
    "",
    "We received a request to reset your password. Your account signs in with your company account, so it has no password here to reset.",
    `Open the sign-in page below and choose "${SSO_SIGN_IN_LABEL}":`,
    "",
    args.signInUrl,
    "",
    "If you can't sign in with your company account, contact your IT team or a Truenote administrator.",
    "",
    "If you didn't request this, you can ignore this email."
  ].join("\n");
  return { subject, html, text };
}

/**
 * Sent instead of a reset link when LOCAL_LOGIN_MODE refuses the account a
 * password sign-in and SSO cannot work for it either (signInMethodFor gave
 * "none": OIDC not usable, or the account's program, or lack of one, is
 * not allowed for SSO). No token and no sign-in link: neither would work.
 * The forgot-password response is the same 204 either way.
 */
export function renderSignInUnavailableNoticeEmail(args: {
  name: string;
}): RenderedEmail {
  const subject = "About your password reset request";
  const safeName = escapeHtml(args.name);
  const html = `
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #0f172a; background: #f8fafc; padding: 24px;">
    <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px;">
      <h1 style="margin: 0 0 16px; font-size: 18px;">Password sign-in is turned off</h1>
      <p>Hi ${safeName},</p>
      <p>We received a request to reset your password. Password sign-in is turned off for your account, so there is no password to reset. Contact a Truenote administrator to get access.</p>
      <p style="font-size: 13px; color: #64748b;">If you didn't request this, you can ignore this email.</p>
    </div>
  </body>
</html>`.trim();
  const text = [
    `Hi ${args.name},`,
    "",
    "We received a request to reset your password. Password sign-in is turned off for your account, so there is no password to reset. Contact a Truenote administrator to get access.",
    "",
    "If you didn't request this, you can ignore this email."
  ].join("\n");
  return { subject, html, text };
}
