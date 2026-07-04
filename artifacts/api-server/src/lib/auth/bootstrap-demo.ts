import { eq } from "drizzle-orm";
import { db } from "../db-client.js";
import { programs, users } from "@workspace/db/schema";
import { hashPassword } from "./passwords.js";
import { getDemoAccounts, type DemoAccount } from "./demo-accounts.js";

/**
 * Ensure the DEMO_LOGIN_ACCOUNTS users exist so the pre-filled login
 * actually works. Called once at api-server startup, right after
 * bootstrapSuperUser. No-op when the env var is unset/invalid.
 *
 * Idempotent, and deliberately non-destructive:
 *   - existing user with that email → left completely untouched (no
 *     password overwrite, no role change) — rotating a demo password
 *     means choosing a new email or fixing the user by hand.
 *   - missing program name → created.
 *   - missing user → created with must_reset_password=false (a forced
 *     first-login reset would break the shared-demo loop: the first
 *     visitor would change the published password and lock everyone
 *     else out of the demo).
 */
export async function bootstrapDemoAccounts(): Promise<void> {
  const accounts = getDemoAccounts();
  if (!accounts) return;

  for (const account of accounts) {
    await ensureDemoUser(account);
  }
}

async function ensureProgram(name: string): Promise<string> {
  const existing = await db
    .select({ id: programs.id })
    .from(programs)
    .where(eq(programs.name, name))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const inserted = await db
    .insert(programs)
    .values({ name })
    .returning({ id: programs.id });
  const row = inserted[0];
  if (!row) throw new Error(`Failed to create demo program "${name}"`);
  console.log(`[demo-accounts] created program "${name}"`);
  return row.id;
}

async function ensureDemoUser(account: DemoAccount): Promise<void> {
  const email = account.email.toLowerCase();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing[0]) {
    console.log(`[demo-accounts] ${email} already exists; leaving as-is.`);
    return;
  }

  const programId = await ensureProgram(account.program);
  const passwordHash = await hashPassword(account.password);
  await db.insert(users).values({
    email,
    passwordHash,
    role: account.role,
    programId,
    name: account.label,
    isActive: true,
    mustResetPassword: false,
    createdBy: null
  });
  console.log(`[demo-accounts] created ${account.role} demo user ${email}`);
}
