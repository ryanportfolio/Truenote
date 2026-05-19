import { and, eq } from "drizzle-orm";
import { db } from "../db-client.js";
import { users } from "@workspace/db/schema";
import { hashPassword } from "./passwords.js";

/**
 * Ensure a super_user exists so the operator can log in to a fresh
 * deployment. Called once at api-server startup.
 *
 * Source of truth for the bootstrap creds is Replit Secrets:
 *   BOOTSTRAP_SUPER_USER_EMAIL
 *   BOOTSTRAP_SUPER_USER_PASSWORD
 *   BOOTSTRAP_SUPER_USER_NAME   (optional; defaults to "Super User")
 *
 * Idempotent behavior — three branches:
 *   1. Both env vars set, no super_user in DB → create one.
 *   2. Both env vars set, a super_user already exists → log and skip
 *      (no overwrite; rotating creds is a future password-reset flow).
 *   3. Env vars missing → log a hint and skip. The api-server still
 *      boots; the operator just can't log in yet.
 *
 * After first login the super_user's `must_reset_password=true` forces a
 * password change. From that point on, the env vars are unused — they're
 * a one-time seed, not an ongoing source of credentials. Leaving them in
 * Secrets is fine (idempotent skip on branch 2) but rotating them later
 * has no effect on the live user.
 */
export async function bootstrapSuperUser(): Promise<void> {
  const email = process.env.BOOTSTRAP_SUPER_USER_EMAIL?.trim();
  const password = process.env.BOOTSTRAP_SUPER_USER_PASSWORD;
  const name = process.env.BOOTSTRAP_SUPER_USER_NAME?.trim() || "Super User";

  if (!email || !password) {
    console.log(
      "[bootstrap] BOOTSTRAP_SUPER_USER_EMAIL / _PASSWORD not set — " +
        "skipping super_user bootstrap. Set both in Replit Secrets to " +
        "seed the first login."
    );
    return;
  }

  // Filter on is_active too. Otherwise a deactivated super_user satisfies
  // the idempotency check and bootstrap skips, but the operator can't log
  // in (login rejects inactive users) and can't recover via env vars
  // either — a permanent lockout requiring direct DB intervention.
  const existing = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.role, "super_user"), eq(users.isActive, true)))
    .limit(1);

  if (existing[0]) {
    console.log(
      `[bootstrap] active super_user already present (${existing[0].email}); ` +
        "leaving as-is."
    );
    return;
  }

  const passwordHash = await hashPassword(password);
  await db.insert(users).values({
    email,
    passwordHash,
    role: "super_user",
    programId: null,
    name,
    isActive: true,
    mustResetPassword: true,
    createdBy: null
  });
  console.log(`[bootstrap] created super_user ${email}`);
}
