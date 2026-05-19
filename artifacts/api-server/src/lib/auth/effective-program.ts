import type { Request } from "express";
import { eq } from "drizzle-orm";
import { programs } from "@workspace/db/schema";
import { db } from "../db-client.js";
import type { CurrentUser } from "./current-user.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROGRAM_HEADER = "x-program-id";

/**
 * Resolve the program a request is operating against.
 *
 * Non-super_user roles are bound to their own program by the DB CHECK
 * constraint — `user.programId` is the only valid answer for them and
 * the X-Program-Id header is ignored (silently, not 403, so a leaked
 * header from a shared component can't lock a manager out of their
 * own data).
 *
 * Super users have no implicit program. They send `X-Program-Id` to
 * declare which program they're acting on. Returns null if:
 *   - the header is absent or malformed
 *   - the program id isn't a UUID
 *   - the program doesn't exist
 *
 * The null branch is the single point where callers surface the
 * "please select a program" UX. Do NOT widen scope here by falling
 * back to "all programs" for super_user — that's a security regression
 * (cross-program retrieval) and the upload path has nothing sensible
 * to fall back to anyway.
 */
export async function resolveEffectiveProgramId(
  user: CurrentUser,
  req: Request
): Promise<string | null> {
  if (user.role !== "super_user") {
    return user.programId;
  }
  const headerValue = req.header(PROGRAM_HEADER);
  if (typeof headerValue !== "string") return null;
  const trimmed = headerValue.trim();
  if (!UUID_RE.test(trimmed)) return null;
  const rows = await db
    .select({ id: programs.id })
    .from(programs)
    .where(eq(programs.id, trimmed))
    .limit(1);
  return rows[0]?.id ?? null;
}
