import { Router } from "express";
import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/db-client.js";
import { sessions, users, type UserRole } from "@workspace/db/schema";
import { hashPassword } from "../../lib/auth/passwords.js";
import {
  authedUser,
  blockDemoWrites,
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove
} from "../../middleware/current-user.js";
import {
  canAssignRole,
  canManageUser
} from "../../lib/auth/current-user.js";
import { resolveEffectiveProgramId } from "../../lib/auth/effective-program.js";
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
import { renderInviteEmail } from "../../lib/email/templates.js";

// Read once at module load — same convention as routes/auth.ts so the
// admin-supplied-password floor stays in lockstep with change-password.
const MIN_PASSWORD_LENGTH = getMinPasswordLength();

export const usersRouter = Router();

// blockDemoWrites: a demo manager may LIST users (the page renders, the
// capability is visible) but can't create/edit/deactivate anyone or
// reset passwords — any of those would let one anonymous visitor break
// login for the next.
usersRouter.use(
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove,
  blockDemoWrites
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLE_VALUES = [
  "super_user",
  "senior_manager",
  "manager",
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
 * GET /api/admin/users — list users the actor can see.
 *
 * Scope:
 *   super_user      → all users. If X-Program-Id is present and resolves
 *                     to a valid program, narrows to that program only
 *                     (so the picker doubles as a user-list filter).
 *   senior_manager  → users in their own program.
 *   manager         → users in their own program.
 *   csr             → blocked at the router level.
 *
 * Order: super_user first, then by role rank, then by name. Stable so the
 * UI doesn't reshuffle on each fetch.
 */
usersRouter.get("/", async (req, res, next) => {
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

const CreateBody = z.object({
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
 * POST /api/admin/users — create a user.
 *
 * Authorization gate is canAssignRole. Email is lowercased before any
 * DB touch. A 23505 unique-violation on the email maps to 409.
 *
 * Response shape:
 *   { item: UserListItem, tempPassword?: string }
 *
 * `tempPassword` is present ONLY when the server generated it (i.e. the
 * client did not supply `password`). This is the single response surface
 * that exposes a plaintext password — admins are expected to communicate
 * it out-of-band to the new user.
 */
usersRouter.post("/", async (req, res, next) => {
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

    const generatedPassword = parsed.data.password ?? generateTempPassword();
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
      const body: { item: UserListItem; tempPassword?: string } = {
        item: toListItem(row)
      };
      if (parsed.data.password === undefined) {
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
 */
usersRouter.post("/bulk", async (req, res, next) => {
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
    //   - no real email provider in production: getEmailSender would fall
    //     back to the console logger, so the invite links would vanish into
    //     server stdout instead of reaching users.
    // Both are operator-fixable Replit Secrets, hence 503 + "an
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

    const emails = normalizeBulkEmails(parsed.data.emails);
    // Sequential hashing intentionally bounds memory. Each Argon2 operation
    // uses ~19 MiB; Promise.all over a 100-row import could exhaust a small
    // Replit instance even though it appears faster locally.
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
        passwordHash: await hashPassword(randomBytes(32).toString("base64url"))
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
    const invites: Array<{
      email: string;
      name: string;
      setupUrl: string;
      expiresAt: Date;
    }> = [];
    for (const row of created) {
      try {
        const { token, expiresAt } = await createResetToken(
          row.id,
          INVITE_TOKEN_DURATION_MS
        );
        const setupUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
        invites.push({ email: row.email, name: row.name, setupUrl, expiresAt });
      } catch (err) {
        console.warn(
          `[admin] bulk import: failed to mint invite token for ${row.email}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    res.status(created.length > 0 ? 201 : 200).json({
      created,
      skippedEmails,
      invitedCount: invites.length,
      forcedPasswordReset: true
    });

    // Past the response — no res.* calls, errors are logged only. The
    // closure reads `invites` (plain data captured above), never `req`.
    if (invites.length > 0) {
      void (async () => {
        const sender = getEmailSender();
        for (const invite of invites) {
          try {
            const { subject, html, text } = renderInviteEmail({
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
          }
        }
      })();
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Loader for PATCH / reset-password. Returns the target row narrowed to
 * the actor's scope. Always returns 404 (not 403) on out-of-scope ids to
 * avoid leaking existence — same convention the documents routes use.
 */
async function loadManageableTarget(
  actor: ReturnType<typeof authedUser>,
  id: string
): Promise<{
  id: string;
  email: string;
  name: string;
  role: UserRole;
  programId: string | null;
  isActive: boolean;
  mustResetPassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
} | null> {
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
    .where(eq(users.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (
    !canManageUser(actor, {
      id: row.id,
      role: row.role,
      programId: row.programId
    })
  ) {
    return null;
  }
  return row;
}

const PatchBody = z
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
 * PATCH /api/admin/users/:id — edit a user.
 *
 * Field-level rules on top of the canManageUser scope gate:
 *   name      → any actor who can manage the target may set this
 *   isActive  → same
 *   role      → only changeable to a (role, programId) the actor can
 *               canAssignRole; manager cannot change roles at all
 *               (canAssignRole rejects every transition for them
 *               because they can only assign csr — and a self-no-op
 *               PATCH would have been rejected at the scope gate
 *               since canManageUser refuses self)
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
usersRouter.patch("/:id", async (req, res, next) => {
  try {
    const actor = authedUser(req);
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
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
      | { kind: "forbidden" };

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
    res.json({ item: toListItem(txResult.row) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/users/:id/reset-password — generate a temp password
 * for the target, revoke their active sessions, return the temp password
 * once in the response. Same scope gate as PATCH.
 *
 * Sets must_reset_password=true unconditionally so the user is bounced
 * to the change-password page on first login with the temp credential.
 */
usersRouter.post("/:id/reset-password", async (req, res, next) => {
  try {
    const actor = authedUser(req);
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const target = await loadManageableTarget(actor, id);
    if (!target) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    // Atomic: update password + force-reset flag + revoke every existing
    // session. If we ran them as separate writes, a transient DB failure
    // between the password update and the session revoke would leave
    // the OLD sessions valid against the NEW password — partially-
    // applied resets are the kind of thing that erodes trust in the
    // reset flow ("did it work or not?").
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, mustResetPassword: true })
        .where(eq(users.id, id));
      await tx.delete(sessions).where(eq(sessions.userId, id));
    });

    res.json({ tempPassword });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/users/:id — permanently remove a user.
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
usersRouter.delete("/:id", async (req, res, next) => {
  try {
    const actor = authedUser(req);
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }

    type TxResult = { kind: "ok" } | { kind: "not-found" } | { kind: "active" };

    const txResult = await db.transaction(async (tx): Promise<TxResult> => {
      const rows = await tx
        .select({
          id: users.id,
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
      // convention as loadManageableTarget and the documents routes.
      if (
        !canManageUser(actor, {
          id: target.id,
          role: target.role,
          programId: target.programId
        })
      ) {
        return { kind: "not-found" };
      }
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
