import type { UserRole } from "@workspace/db/schema";
import type { LocalLoginMode, OidcConfig } from "./oidc.js";

/**
 * Whether LOCAL_LOGIN_MODE lets a user with this role hold a local
 * (password) session. One rule for password login, reset-link completion
 * and session lookup, so a mode change also ends existing local sessions
 * of users the new mode no longer allows.
 *
 *   enabled     every role
 *   break_glass super_user only (the emergency account)
 *   disabled    nobody
 *
 * Activity (users.is_active) is checked by each caller, not here.
 */
export function isLocalLoginAllowed(
  mode: LocalLoginMode,
  role: UserRole
): boolean {
  switch (mode) {
    case "enabled":
      return true;
    case "break_glass":
      return role === "super_user";
    case "disabled":
      return false;
    default:
      // An unknown mode must not open local access.
      return false;
  }
}

/**
 * Whether an account in this program may sign in through SSO: its program
 * is on OIDC_ALLOWED_PROGRAM_IDS. An account without a program (super_user)
 * never may. The SSO callback (assertEligible in routes/oidc.ts) applies
 * this same rule on every sign-in.
 */
export function isSsoProgramAllowed(
  allowedProgramIds: readonly string[],
  programId: string | null
): boolean {
  return programId !== null && allowedProgramIds.includes(programId.toLowerCase());
}

/**
 * How an account can sign in right now, so recovery and invitation copy
 * never point at a door that is shut.
 *
 *   password  LOCAL_LOGIN_MODE allows local login for the role
 *   sso       local login is refused, OIDC is usable and the program is
 *             allowed for SSO
 *   none      neither: an administrator must change the setup first
 */
export type SignInMethod = "password" | "sso" | "none";

export function signInMethodFor(
  config: Pick<OidcConfig, "enabled" | "allowedProgramIds" | "localLoginMode">,
  role: UserRole,
  programId: string | null
): SignInMethod {
  if (isLocalLoginAllowed(config.localLoginMode, role)) return "password";
  if (config.enabled && isSsoProgramAllowed(config.allowedProgramIds, programId)) {
    return "sso";
  }
  return "none";
}

/**
 * Which invitation an admin-created account gets, from signInMethodFor.
 * "password_setup": a one-time /reset-password link to choose a password.
 * "sso": a link to the sign-in page and no password token, because
 * reset-password refuses a user the mode does not allow; the first SSO
 * sign-in binds the identity. "none": no token and no email, because the
 * account cannot sign in until an administrator changes the setup.
 */
export type InvitationKind = "password_setup" | "sso" | "none";

export function invitationKindFor(
  config: Pick<OidcConfig, "enabled" | "allowedProgramIds" | "localLoginMode">,
  role: UserRole,
  programId: string | null
): InvitationKind {
  const method = signInMethodFor(config, role, programId);
  return method === "password" ? "password_setup" : method;
}
