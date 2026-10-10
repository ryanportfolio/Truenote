import { Router } from "express";
import { randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/db-client.js";
import { sessions, users, type UserRole } from "@workspace/db/schema";
import { hashPassword } from "../../lib/auth/passwords.js";
import { invalidateMfaChallenges, type SqlExecutor } from "../../lib/auth/mfa.js";
import {
  authedUser,
  blockDemoWrites,
  DEMO_WRITE_BLOCKED_MESSAGE,
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove,
  requireRole
} from "../../middleware/current-user.js";
import {
  canAssignRole,
  canManageUser,
  type CurrentUser,
  type TargetUserSummary
} from "../../lib/auth/current-user.js";
import { resolveEffectiveProgramId } from "../../lib/auth/effective-program.js";
import { isDemoEmail } from "../../lib/auth/demo-accounts.js";
import { getMinPasswordLength } from "../../lib/config.js";
import {
  BulkUserEmailsSchema,
  bulkUserValues,
  nameFromEmail,
  normalizeBulkEmails
} from "../../lib/auth/bulk-users.js";
import {
  createResetToken,
  INVITE_TOKEN_DURATION_MS
} from "../../lib/auth/password-reset.js";
import {
  getEmailSender,
  isEmailDeliveryConfigured
} from "../../lib/email/sender.js";
import { resolveAppBaseUrl } from "../../lib/email/links.js";
import {
  renderInviteEmail,
  renderSsoInviteEmail
} from "../../lib/email/templates.js";
import { getOidcConfig } from "../../lib/auth/oidc.js";
import {
  invitationKindFor,
  type InvitationKind
} from "../../lib/auth/local-login-policy.js";
import { recordAppError } from "../../lib/observability/error-log.js";
import { adminReadLimit, userAdminWriteLimit } from "../../lib/security/route-rate-limit.js";
import { workloadRateLimitMiddleware } from "../../middleware/workload-rate-limit.js";

// Read once at module load — same convention as routes/auth.ts so the
// admin-supplied-password floor stays in lockstep with change-password.
const MIN_PASSWORD_LENGTH = getMinPasswordLength();

export const usersRouter = Router();

// Access matrix:
//   manager and above → every handler below, scoped by canManageUser /
//                       canAssignRole.
//   supervisor        → GET / (their own team's CSRs only) and
//                       POST /:id/reset-password (their own team's CSRs
//                       only, canSupervisorResetPassword). Every other
//                       handler carries requireManagerOrAbove, so a new
//                       handler must add it too unless supervisors need it.
//   csr               → blocked here.
//
// blockDemoWrites: a demo manager or supervisor may LIST users (the page
// renders, the capability is visible) but can't create/edit/deactivate
// anyone or reset passwords — any of those would let one anonymous visitor
// break login for the next. A super user can lift those limits (Security
// page); demoTargetLocked still keeps everyone but super users off the demo
// accounts themselves.
usersRouter.use(
  requireAuth,
  requireFreshPassword,
  requireRole("supervisor"),
  blockDemoWrites
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only a super user may edit, reset or remove a demo account, even with the
 * demo limits lifted. Demo passwords are published, so one visitor breaking
 * a demo login would lock out every other visitor, and the check is on the
 * target: an account a demo manager created (a supervisor they then move the
 * demo CSR under, say) is not a demo account but is stopped here too.
 */
function demoTargetLocked(actor: CurrentUser, targetEmail: string): boolean {
  return isDemoEmail(targetEmail) && actor.role !== "super_user";
}

const ROLE_VALUES = [
  "super_user",
  "senior_manager",
  "manager",
  "supervisor",
  "csr"
] as const satisfies readonly UserRole[];

const NAME_REGEX = /^[^\x00-\x1f\x7f]+$/;

export interface UserListItem {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  programId: string | null;
  isActive: boolean;
  mustResetPassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

function toListItem(row: {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  programId: string | null;
  isActive: boolean;
  mustResetPassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}): UserListItem {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    programId: row.programId,
    isActive: row.isActive,
    mustResetPassword: row.mustResetPassword,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt.toISOString()
  };
}

/**
 * Cryptographically random temporary password. Long enough to be safe
 * even at the most permissive MIN_PASSWORD_LENGTH (we don't try to
 * "just barely satisfy" the floor — that would weaken the temp
 * credential for no UX benefit since it's a one-shot value the user
 * will replace at first login).
 *
 * 16 bytes of base64url = ~22 chars of [A-Za-z0-9_-]. URL-safe so
 * a future "click-to-set" flow can pass it in a link without
 * encoding hazards.
 */
function generateTempPassword(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Hash input for an account nobody signs in to with a password (bulk
 * invites before the link is used, SSO-only accounts). Discarded at once,
 * so the stored hash matches no known password.
 */
function generateUnusablePassword(): string {
  return randomBytes(32).toString("base64url");
}

/** The sign-in page an SSO invitation links to. */
function ssoSignInUrl(baseUrl: string): string {
  return `${baseUrl}/login`;
}

/**
 * How long single create waits for the SSO invitation send. The account
 * already exists by then, and the email provider has no deadline of its
 * own, so a stalled send would otherwise hold the create request open
 * until the client gives up and a retry gets 409.
 */
const SSO_INVITE_SEND_TIMEOUT_MS = 10_000;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Email one SSO invitation from the single-create path and report whether
 * it was confirmed sent. The account works without it (the user can open
 * the sign-in page and use SSO), so every failure, including a send still
 * running at the deadline, is logged and returned as false instead of
 * failing the request.
 */
async function sendSsoInvitation(
  invite: { userId: string; email: string; name: string },
  baseUrl: string | null
): Promise<boolean> {
  if (baseUrl === null) {
    console.warn(
      `[admin] create user: APP_BASE_URL not set; SSO invitation to ${invite.email} not sent`
    );
    return false;
  }
  if (process.env.NODE_ENV === "production" && !isEmailDeliveryConfigured()) {
    console.warn(
      `[admin] create user: email delivery not configured; SSO invitation to ${invite.email} not sent`
    );
    return false;
  }
  try {
    const { subject, html, text } = renderSsoInviteEmail({
      name: invite.name,
      signInUrl: ssoSignInUrl(baseUrl)
    });
    await withDeadline(
      getEmailSender().send({ to: invite.email, subject, html, text }),
      SSO_INVITE_SEND_TIMEOUT_MS
    );
    return true;
  } catch (err) {
    console.warn(
      `[admin] create user: SSO invitation to ${invite.email} failed:`,
      err instanceof Error ? err.message : err
    );
    void recordAppError({
      source: "email",
      operation: "sso-invite-send",
      error: err,
      userId: invite.userId
    });
    return false;
  }
}

/**
 * Can a supervisor reset `target`'s password? Only a CSR in the
 * supervisor's own program whose team_members row points at this
 * supervisor (`isTeamMember`, read by the caller under the target's row
 * lock). False for every non-supervisor actor; they go through
 * canManageUser instead.
 */
export function canSupervisorResetPassword(
  actor: CurrentUser,
  target: TargetUserSummary,
  isTeamMember: boolean
): boolean {
  if (actor.role !== "supervisor") return false;
  if (actor.id === target.id) return false;
  if (target.role !== "csr") return false;
  if (actor.programId === null || target.programId === null) return false;
  if (actor.programId !== target.programId) return false;
  return isTeamMember;
}

/**
 * GET /api/admin/users — list users the actor can see.
 *
 * Scope:
 *   super_user      → all users. If X-Program-Id is present and resolves
 *                     to a valid program, narrows to that program only
 *                     (so the picker doubles as a user-list filter).
 *   senior_manager  → users in their own program.
 *   manager         → users in their own program.
 *   supervisor      → only the CSRs on their own team (team_members rows
 *                     pointing at them) in their own program.
 *   csr             → blocked at the router level.
 *
 * Order: super_user first, then by role rank, then by name. Stable so the
 * UI doesn't reshuffle on each fetch.
 */
usersRouter.get("/", adminReadLimit, async (req, res, next) => {
  try {
    const actor = authedUser(req);

    // Resolve "the scope the actor is querying within."
    // - non-super_user: always their own program (header ignored by resolver)
    // - super_user: header program id if present, otherwise null (= all)
    const scopeProgramId = await resolveEffectiveProgramId(actor, req);

    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        programId: users.programId,
        isActive: users.isActive,
        mustResetPassword: users.mustResetPassword,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt
      })
      .from(users)
      .where(
        actor.role === "super_user"
          ? scopeProgramId === null
            ? undefined
            : eq(users.programId, scopeProgramId)
          : actor.role === "supervisor"
            ? // Supervisor: CSRs in their own program assigned to them.
              and(
                eq(users.programId, actor.programId as string),
                eq(users.role, "csr"),
                sql`EXISTS (
                  SELECT 1 FROM team_members tm
                  WHERE tm.csr_user_id = ${users.id}
                    AND tm.supervisor_user_id = ${actor.id}::uuid
                    AND tm.program_id = ${users.programId}
                )`
              )
            : // Non-super_user: programId is non-null by DB CHECK; filter to
              // own program. Excludes any super_user rows (they have null
              // programId), which is correct — a manager has no business
              // seeing super_user accounts.
              eq(users.programId, actor.programId as string)
      )
      .orderBy(asc(users.role), asc(users.name));

    res.json({ items: rows.map(toListItem) });
  } catch (err) {
    next(err);
  }
});

export const CreateBody = z.object({
  email: z.string().trim().email().max(254),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(NAME_REGEX, "Name must not contain control characters"),
  role: z.enum(ROLE_VALUES),
  // Null is meaningful (super_user); make explicit-null distinct from omit.
  programId: z
    .string()
    .regex(UUID_RE, "programId must be a UUID")
    .nullable()
    .optional(),
  // Optional caller-supplied password. If omitted, the server generates
  // a temp one and returns it in the response. Either way the new user
  // is forced to change it on first login. The MIN_PASSWORD_LENGTH
  // floor mirrors what the change-password endpoint enforces — a
  // shorter caller-supplied password would let the new user log in
  // briefly with credentials below the project's own minimum.
  password: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    )
    .max(1024)
    .optional()
});

/**
 * POST /api/admin/users — create a user. Manager and above
 * (requireManagerOrAbove, after the throttle).
 *
 * Authorization gate is canAssignRole. Email is lowercased before any
 * DB touch. A 23505 unique-violation on the email maps to 409.
 *
 * Response shape:
 *   { item: UserListItem, tempPassword?: string, invitation?: { kind: "sso", emailSent: boolean } }
 *
 * `tempPassword` is present ONLY when the server generated it (i.e. the
 * client did not supply `password`). This is the single response surface
 * that exposes a plaintext password — admins are expected to communicate
 * it out-of-band to the new user.
 *
 * SSO accounts (invitationKindFor gives "sso": LOCAL_LOGIN_MODE is
 * break_glass or disabled and the role may not use local login) get no
 * usable password. A caller-supplied password is refused with 400, no
 * tempPassword is returned, and the user is emailed a link to the sign-in
 * page instead; `invitation.emailSent` says whether that email went out.
 */
usersRouter.post("/", workloadRateLimitMiddleware("credential_administration"), userAdminWriteLimit, requireManagerOrAbove, async (req, res, next) => {
  try {
    const actor = authedUser(req);
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      res.status(400).json({ error: message });
      return;
    }
    const { role: targetRole } = parsed.data;
    const email = parsed.data.email.toLowerCase();

    // Resolve programId defaults so callers don't have to think about it:
    //   - explicit value (including null): honored as-is
    //   - manager/senior_manager omitted: default to actor's own program
    //   - super_user omitted: null (forces an explicit pick for non-
    //     super_user targets — canAssignRole will 403)
    let programId: string | null;
    if (parsed.data.programId !== undefined) {
      programId = parsed.data.programId;
    } else if (actor.role !== "super_user") {
      programId = actor.programId;
    } else {
      programId = null;
    }

    if (!canAssignRole(actor, targetRole, programId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // reset-password and local login refuse a user the mode does not allow,
    // so a temp password or setup link for one would be unusable.
    const invitationKind = invitationKindFor(
      getOidcConfig().localLoginMode,
      targetRole
    );
    if (invitationKind === "sso" && parsed.data.password !== undefined) {
      res.status(400).json({
        error: "This user signs in with company SSO, so the account can't have a password"
      });
      return;
    }
    // Read from the live request before any await on the send path.
    const baseUrl = invitationKind === "sso" ? resolveAppBaseUrl(req) : null;

    const generatedPassword =
      invitationKind === "sso"
        ? generateUnusablePassword()
        : parsed.data.password ?? generateTempPassword();
    const passwordHash = await hashPassword(generatedPassword);

    // No pre-flight existence check — that path skipped argon2 and
    // returned ~10x faster than the success path, letting an
    // authenticated admin enumerate which emails are already
    // registered by stopwatch. We always hash + always INSERT now,
    // and rely on the DB UNIQUE constraint on users.email (23505) to
    // surface duplicates. Timing on duplicate vs success is now
    // dominated by the argon2 cost in both branches.
    try {
      const inserted = await db
        .insert(users)
        .values({
          email,
          passwordHash,
          role: targetRole,
          programId,
          name: parsed.data.name,
          isActive: true,
          mustResetPassword: true,
          createdBy: actor.id
        })
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          programId: users.programId,
          isActive: users.isActive,
          mustResetPassword: users.mustResetPassword,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt
        });
      const row = inserted[0];
      if (!row) {
        res.status(500).json({ error: "Failed to create user" });
        return;
      }
      // Echo the temp password only when WE generated it. Caller-supplied
      // passwords are already known to the caller; bouncing them back
      // would only enlarge the leak surface (logs, network captures).
      const body: {
        item: UserListItem;
        tempPassword?: string;
        invitation?: { kind: "sso"; emailSent: boolean };
      } = {
        item: toListItem(row)
      };
      if (invitationKind === "sso") {
        body.invitation = {
          kind: "sso",
          emailSent: await sendSsoInvitation(
            { userId: row.id, email: row.email, name: row.name },
            baseUrl
          )
        };
      } else if (parsed.data.password === undefined) {
        body.tempPassword = generatedPassword;
      }
      res.status(201).json(body);
    } catch (err) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code: unknown }).code
          : undefined;
      if (code === "23505") {
        res
          .status(409)
          .json({ error: "A user with that email already exists" });
        return;
      }
      if (code === "23514") {
        // role/programId CHECK violation — caller sent a combination
        // that survived our app-level checks but the DB rejected. Most
        // likely a future role enum value we haven't handled.
        res
          .status(400)
          .json({ error: "Role and program combination is not allowed" });
        return;
      }
      if (code === "23503") {
        // FK violation on users.program_id → programs.id ON DELETE
        // RESTRICT. The program was concurrently deleted between
        // canAssignRole and the INSERT. Surface as a clear 400 rather
        // than a generic 500 so the admin can pick another program.
        res
          .status(400)
          .json({ error: "Program not found" });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/users/bulk — create CSR accounts from CSV-derived emails
 * and email each new user a one-time link to set their own password.
 * Manager and above (requireManagerOrAbove, after the throttle).
 *
 * The frontend parses the file, but the server revalidates every address,
 * fixes the role to CSR, and resolves the target program from the actor's
 * effective scope. Existing emails are skipped without modifying them.
 *
 * Delivery model (why there is no returned temp password):
 *   Each new account is created with an UNGUESSABLE random password hash
 *   that nobody — not the admin, not the user — ever sees. The account is
 *   unusable until the user consumes an invite link (a one-shot reset
 *   token) and chooses their own password. This removes the admin from
 *   the credential-distribution loop entirely: an import of hundreds of
 *   users sends hundreds of individual "set your password" emails, rather
 *   than dumping hundreds of plaintext passwords onto the admin's screen
 *   for manual hand-delivery.
 *
 * Because the account is unreachable without the emailed link, we refuse
 * up-front (creating nothing) if email delivery isn't wired in
 * production — otherwise we'd mint accounts no one can ever log into.
 *
 * Under SSO (invitationKindFor gives "sso" for CSRs: LOCAL_LOGIN_MODE is
 * break_glass or disabled) no setup token is minted. The email links to
 * the sign-in page and tells the user to sign in with company SSO; the
 * first SSO sign-in binds their identity. `invitationKind` in the response
 * says which email went out.
 */
usersRouter.post("/bulk", workloadRateLimitMiddleware("bulk_user_import"), userAdminWriteLimit, requireManagerOrAbove, async (req, res, next) => {
  try {
    const actor = authedUser(req);
    const parsed = BulkUserEmailsSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid CSV emails";
      res.status(400).json({ error: message });
      return;
    }

    const programId = await resolveEffectiveProgramId(actor, req);
    if (programId === null) {
      res.status(400).json({
        error: "Select a program before importing users"
      });
      return;
    }
    if (!canAssignRole(actor, "csr", programId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Preconditions for delivery, checked BEFORE any account is created so
    // a misconfigured deployment can't leave a trail of unreachable users.
    //   - baseUrl null: only happens in production when APP_BASE_URL is
    //     unset (resolveAppBaseUrl refuses to trust request headers there);
    //     without it we can't build a link at all.
    //   - no real email provider in production: getEmailSender fails closed;
    //     checking here also prevents accounts from being created before that
    //     delivery failure is discovered.
    // Both are operator-fixable service variables, hence 503 + "an
    // administrator" rather than a 4xx the importing manager could act on.
    const baseUrl = resolveAppBaseUrl(req);
    if (baseUrl === null) {
      res.status(503).json({
        error:
          "Invite emails can't be sent because APP_BASE_URL isn't configured. Ask an administrator to set it before importing users."
      });
      return;
    }
    if (process.env.NODE_ENV === "production" && !isEmailDeliveryConfigured()) {
      res.status(503).json({
        error:
          "Invite emails can't be sent because email delivery isn't configured. Ask an administrator to set RESEND_API_KEY and RESEND_FROM_EMAIL before importing users."
      });
      return;
    }

    // Bulk import creates CSRs only, so one invitation kind covers the batch.
    const invitationKind: InvitationKind = invitationKindFor(
      getOidcConfig().localLoginMode,
      "csr"
    );

    const emails = normalizeBulkEmails(parsed.data.emails);
    // Sequential hashing intentionally bounds memory. Each Argon2 operation
    // uses ~19 MiB; Promise.all over a 100-row import could exhaust a small
    // container even though it appears faster locally.
    //
    // The hashed value is a throwaway: a fresh random string per user,
    // discarded immediately. Login with it is impossible (no one knows
    // it), and mustResetPassword=true is a further backstop. The user's
    // real password is set through the invite link.
    const candidates: Array<{
      email: string;
      name: string;
      passwordHash: string;
    }> = [];
    for (const email of emails) {
      candidates.push({
        email,
        name: nameFromEmail(email),
        passwordHash: await hashPassword(generateUnusablePassword())
      });
    }

    const created: UserListItem[] = [];
    const skippedEmails: string[] = [];
    await db.transaction(async (tx) => {
      for (const candidate of candidates) {
        const inserted = await tx
          .insert(users)
          .values(bulkUserValues({
            email: candidate.email,
            passwordHash: candidate.passwordHash,
            programId,
            name: candidate.name,
            createdBy: actor.id
          }))
          .onConflictDoNothing({ target: users.email })
          .returning({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            programId: users.programId,
            isActive: users.isActive,
            mustResetPassword: users.mustResetPassword,
            lastLoginAt: users.lastLoginAt,
            createdAt: users.createdAt
          });
        const row = inserted[0];
        if (row) created.push(toListItem(row));
        else skippedEmails.push(candidate.email);
      }
    });

    // Mint one invite token per created user IN-REQUEST so the returned
    // count is authoritative and every new account has a working link
    // before we respond. The actual send is slow (Resend round-trips), so
    // it runs fire-and-forget after the response — same posture as
    // forgot-password. A per-user token/send failure is logged, not fatal:
    // that user recovers via the standard forgot-password flow.
    // SSO invitations carry no token; the sign-in link works for everyone.
    const invites: Array<
      { userId: string; email: string; name: string } & (
        | { kind: "password_setup"; setupUrl: string; expiresAt: Date }
        | { kind: "sso"; signInUrl: string }
      )
    > = [];
    for (const row of created) {
      if (invitationKind === "sso") {
        invites.push({
          kind: "sso",
          userId: row.id,
          email: row.email,
          name: row.name,
          signInUrl: ssoSignInUrl(baseUrl)
        });
        continue;
      }
      try {
        const { token, expiresAt } = await createResetToken(
          row.id,
          INVITE_TOKEN_DURATION_MS
        );
        const setupUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
        invites.push({
          kind: "password_setup",
          userId: row.id,
          email: row.email,
          name: row.name,
          setupUrl,
          expiresAt
        });
      } catch (err) {
        console.warn(
          `[admin] bulk import: failed to mint invite token for ${row.email}:`,
          err instanceof Error ? err.message : err
        );
        void recordAppError({
          source: "auth",
          operation: "bulk-invite-token",
          error: err,
          userId: row.id
        });
      }
    }

    res.status(created.length > 0 ? 201 : 200).json({
      created,
      skippedEmails,
      invitedCount: invites.length,
      invitationKind,
      forcedPasswordReset: true
    });

    // Past the response — no res.* calls, errors are logged only. The
    // closure reads `invites` (plain data captured above), never `req`.
    if (invites.length > 0) {
      void (async () => {
        const sender = getEmailSender();
        for (const invite of invites) {
          try {
            const { subject, html, text } =
              invite.kind === "sso"
                ? renderSsoInviteEmail({
                    name: invite.name,
                    signInUrl: invite.signInUrl
                  })
                : renderInviteEmail({
                    name: invite.name,
                    setupUrl: invite.setupUrl,
                    expiresAt: invite.expiresAt
                  });
            await sender.send({ to: invite.email, subject, html, text });
          } catch (err) {
            console.warn(
              `[admin] bulk import: invite email to ${invite.email} failed:`,
              err instanceof Error ? err.message : err
            );
            void recordAppError({
              source: "email",
              operation: "bulk-invite-send",
              error: err,
              userId: invite.userId
            });
          }
        }
      })();
    }
  } catch (err) {
    next(err);
  }
});

export const PatchBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(NAME_REGEX, "Name must not contain control characters")
      .optional(),
    role: z.enum(ROLE_VALUES).optional(),
    programId: z
      .string()
      .regex(UUID_RE, "programId must be a UUID")
      .nullable()
      .optional(),
    isActive: z.boolean().optional()
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "No fields to update"
  });

/**
 * PATCH /api/admin/users/:id — edit a user. Manager and above
 * (requireManagerOrAbove).
 *
 * Field-level rules on top of the canManageUser scope gate:
 *   name      → any actor who can manage the target may set this
 *   isActive  → same
 *   role      → only changeable to a (role, programId) the actor can
 *               canAssignRole; a manager can only move a target
 *               between csr and supervisor (a self-no-op PATCH is
 *               rejected at the scope gate since canManageUser
 *               refuses self)
 *   programId → only super_user can reassign; senior_manager / manager
 *               cannot move users out of their own program (canAssignRole
 *               rejects)
 *
 * A role or programId change is validated against the FINAL pair
 * (new-role + new-programId), not against partial deltas — otherwise
 * a multi-field PATCH could pass an intermediate-illegal state.
 *
 * Atomicity: the load + scope check + canAssignRole + UPDATE + (on
 * deactivate) session revoke ALL run inside a single transaction
 * with `SELECT ... FOR UPDATE` on the target row. Without this, two
 * concurrent admins could race — actor A loads target T at role=csr,
 * meanwhile super_user promotes T to senior_manager, then actor A's
 * UPDATE lands with a stale validation context (canManageUser would
 * have rejected the new role). The row lock serializes the
 * read/write so each PATCH sees a consistent snapshot.
 *
 * Session revoke on deactivation runs in the same transaction so the
 * "deactivate but session still alive" failure mode is impossible.
 * If anything in the tx fails, the whole PATCH rolls back rather
 * than partially deactivating.
 */
usersRouter.patch("/:id", userAdminWriteLimit, requireManagerOrAbove, async (req, res, next) => {
  try {
    const actor = authedUser(req);
    const id = req.params.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      res.status(400).json({ error: message });
      return;
    }

    // Result variants from the transaction. Encodes the auth/scope
    // outcome so the HTTP layer below can map each to a status code
    // without re-checking inside the tx. The row shape mirrors what
    // toListItem expects — keeps passwordHash out of the closure
    // even though it's harmless here.
    interface SafeUserRow {
      id: string;
      email: string;
      name: string;
      role: UserRole;
      programId: string | null;
      isActive: boolean;
      mustResetPassword: boolean;
      lastLoginAt: Date | null;
      createdAt: Date;
    }
    type TxResult =
      | { kind: "ok"; row: SafeUserRow }
      | { kind: "not-found" }
      | { kind: "forbidden" }
      | { kind: "demo" };

    let txResult: TxResult;
    try {
      txResult = await db.transaction(async (tx): Promise<TxResult> => {
        // SELECT FOR UPDATE — the row lock is the heart of the
        // atomicity claim. Holds until tx commits/rolls back, so any
        // concurrent PATCH/reset on the same user_id queues behind us.
        const rows = await tx
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            programId: users.programId,
            isActive: users.isActive,
            mustResetPassword: users.mustResetPassword,
            lastLoginAt: users.lastLoginAt,
            createdAt: users.createdAt
          })
          .from(users)
          .where(eq(users.id, id))
          .for("update")
          .limit(1);
        const target = rows[0];
        if (!target) return { kind: "not-found" };
        if (
          !canManageUser(actor, {
            id: target.id,
            role: target.role,
            programId: target.programId
          })
        ) {
          return { kind: "not-found" };
        }
        if (demoTargetLocked(actor, target.email)) return { kind: "demo" };

        const finalRole = parsed.data.role ?? target.role;
        const finalProgramId =
          parsed.data.programId !== undefined
            ? parsed.data.programId
            : target.programId;

        const roleChanging =
          parsed.data.role !== undefined &&
          parsed.data.role !== target.role;
        const programChanging =
          parsed.data.programId !== undefined &&
          parsed.data.programId !== target.programId;
        if (roleChanging || programChanging) {
          if (!canAssignRole(actor, finalRole, finalProgramId)) {
            return { kind: "forbidden" };
          }
        }

        const update: {
          name?: string;
          role?: UserRole;
          programId?: string | null;
          isActive?: boolean;
        } = {};
        if (parsed.data.name !== undefined) update.name = parsed.data.name;
        if (parsed.data.role !== undefined) update.role = parsed.data.role;
        if (parsed.data.programId !== undefined)
          update.programId = parsed.data.programId;
        if (parsed.data.isActive !== undefined)
          update.isActive = parsed.data.isActive;

        const updated = await tx
          .update(users)
          .set(update)
          .where(eq(users.id, id))
          .returning({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            programId: users.programId,
            isActive: users.isActive,
            mustResetPassword: users.mustResetPassword,
            lastLoginAt: users.lastLoginAt,
            createdAt: users.createdAt
          });
        const row = updated[0];
        // The SELECT FOR UPDATE above already proved the row exists
        // and is locked — UPDATE returning zero here would mean the
        // row was deleted via ON DELETE CASCADE while we held the
        // lock, which our schema doesn't allow (users has no parent
        // FK that cascades into it). Treat defensively anyway.
        if (!row) return { kind: "not-found" };

        if (parsed.data.isActive === false) {
          // Co-transactional session revoke. If this fails, the
          // whole PATCH rolls back — deactivation never "succeeds"
          // with sessions still alive. Stronger than the old fire-
          // and-forget pattern, which could leave a deactivated
          // user logged in until the 7-day session expiry.
          await tx.delete(sessions).where(eq(sessions.userId, id));
        }

        return { kind: "ok", row };
      });
    } catch (err) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code: unknown }).code
          : undefined;
      if (code === "23514") {
        res
          .status(400)
          .json({ error: "Role and program combination is not allowed" });
        return;
      }
      if (code === "23503") {
        res.status(400).json({ error: "Program not found" });
        return;
      }
      throw err;
    }

    if (txResult.kind === "not-found") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (txResult.kind === "forbidden") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (txResult.kind === "demo") {
      res.status(403).json({ error: DEMO_WRITE_BLOCKED_MESSAGE });
      return;
    }
    res.json({ item: toListItem(txResult.row) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/users/:id/reset-password — generate a temp password
 * for the target, revoke their active sessions, return the temp password
 * once in the response.
 *
 * Scope gate:
 *   manager and above → canManageUser, the same gate as PATCH.
 *   supervisor        → canSupervisorResetPassword: a CSR in their own
 *                       program whose team_members row points at them.
 *   Anything else is a 404, not a 403.
 *
 * Sets must_reset_password=true unconditionally so the user is bounced
 * to the change-password page on first login with the temp credential.
 *
 * Atomicity: the scope re-check + password/flag UPDATE + session revoke ALL
 * run inside one transaction with `SELECT ... FOR UPDATE` on the target row,
 * mirroring PATCH/DELETE. A plain pre-tx load (the old shape) left a TOCTOU
 * window — widened by the deliberately slow Argon2 hash — in which a
 * concurrent promote/reassign by a higher admin could move the target out of
 * the actor's scope after the check but before the write, letting the stale
 * reset land on a now-unmanageable account and hand the actor its temp
 * password (account takeover). Re-checking canManageUser on the locked row
 * closes it. The Argon2 hash runs BEFORE the tx so the row lock is never held
 * across it.
 */
usersRouter.post("/:id/reset-password", workloadRateLimitMiddleware("credential_administration"), async (req, res, next) => {
  try {
    const actor = authedUser(req);
    const id = req.params.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }

    // Hash BEFORE the transaction — never hold the row lock across the slow
    // Argon2 work. The hash isn't bound to any target until the in-tx
    // re-check below approves it; if the re-check fails the tx rolls back and
    // nothing is written.
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    type TxResult = { kind: "ok" } | { kind: "not-found" } | { kind: "demo" };
    const txResult = await db.transaction(async (tx): Promise<TxResult> => {
      // SELECT FOR UPDATE — locks the row so any concurrent PATCH/reset on
      // the same user_id queues behind us, and re-reads the CURRENT
      // role/program to authorize against (not a stale pre-tx snapshot).
      const rows = await tx
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          programId: users.programId
        })
        .from(users)
        .where(eq(users.id, id))
        .for("update")
        .limit(1);
      const target = rows[0];
      if (!target) return { kind: "not-found" };
      const summary = {
        id: target.id,
        role: target.role,
        programId: target.programId
      };
      let allowed: boolean;
      if (actor.role === "supervisor") {
        // Team membership is read inside the tx, after the target's row
        // lock: every team_members writer (PUT /api/admin/teams/assignments,
        // the users cleanup trigger) locks the CSR's users row first, so the
        // row can't move to another team before this reset commits.
        const membership = await tx.execute(sql`
          SELECT 1 FROM team_members
          WHERE csr_user_id = ${target.id}::uuid
            AND supervisor_user_id = ${actor.id}::uuid
            AND program_id = ${actor.programId}::uuid
          FOR SHARE
        `);
        allowed = canSupervisorResetPassword(
          actor,
          summary,
          membership.rows.length > 0
        );
      } else {
        allowed = canManageUser(actor, summary);
      }
      // 404 (not 403) on out-of-scope ids — same existence-hiding
      // convention as the documents routes.
      if (!allowed) return { kind: "not-found" };
      if (demoTargetLocked(actor, target.email)) return { kind: "demo" };

      // Atomic: update password + force-reset flag + revoke every existing
      // session. If we ran them as separate writes, a transient DB failure
      // between the password update and the session revoke would leave
      // the OLD sessions valid against the NEW password — partially-
      // applied resets are the kind of thing that erodes trust in the
      // reset flow ("did it work or not?").
      await tx
        .update(users)
        .set({ passwordHash, mustResetPassword: true })
        .where(eq(users.id, id));
      // Same for a pending MFA login started with the old password.
      await invalidateMfaChallenges(id, tx as unknown as SqlExecutor);
      await tx.delete(sessions).where(eq(sessions.userId, id));
      return { kind: "ok" };
    });

    if (txResult.kind === "not-found") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (txResult.kind === "demo") {
      res.status(403).json({ error: DEMO_WRITE_BLOCKED_MESSAGE });
      return;
    }

    res.json({ tempPassword });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/users/:id — permanently remove a user. Manager and
 * above (requireManagerOrAbove).
 *
 * Deliberate two-step removal (matches the UI): the target must already
 * be deactivated. Deleting an active user is refused with 409, so removal
 * is always intentional and the user's sessions are already gone before
 * the row disappears.
 *
 * Scope gate is canManageUser (refuses self, enforces program scope,
 * hides super_user targets from managers). Referential integrity is
 * handled by the schema's ON DELETE rules: sessions and
 * password_reset_tokens CASCADE; created_by on any users this account
 * created is SET NULL so audit rows survive. The text-column references
 * in query_log / chat_sessions / document_versions carry no FK and are
 * historical — intentionally left intact.
 *
 * Atomicity: SELECT ... FOR UPDATE locks the row so a concurrent
 * reactivate/PATCH can't slip between the isActive check and the DELETE.
 */
usersRouter.delete("/:id", userAdminWriteLimit, requireManagerOrAbove, async (req, res, next) => {
  try {
    const actor = authedUser(req);
    const id = req.params.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }

    type TxResult = { kind: "ok" } | { kind: "not-found" } | { kind: "active" } | { kind: "demo" };

    const txResult = await db.transaction(async (tx): Promise<TxResult> => {
      const rows = await tx
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          programId: users.programId,
          isActive: users.isActive
        })
        .from(users)
        .where(eq(users.id, id))
        .for("update")
        .limit(1);
      const target = rows[0];
      if (!target) return { kind: "not-found" };
      // 404 (not 403) on out-of-scope ids — same existence-hiding
      // convention as the documents routes.
      if (
        !canManageUser(actor, {
          id: target.id,
          role: target.role,
          programId: target.programId
        })
      ) {
        return { kind: "not-found" };
      }
      if (demoTargetLocked(actor, target.email)) return { kind: "demo" };
      if (target.isActive) return { kind: "active" };

      // Cascades sessions + password_reset_tokens; SET NULL on any
      // created_by pointing here — all via the schema's ON DELETE rules.
      await tx.delete(users).where(eq(users.id, id));
      return { kind: "ok" };
    });

    if (txResult.kind === "not-found") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (txResult.kind === "demo") {
      res.status(403).json({ error: DEMO_WRITE_BLOCKED_MESSAGE });
      return;
    }
    if (txResult.kind === "active") {
      res
        .status(409)
        .json({ error: "Deactivate the user before deleting them" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
