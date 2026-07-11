import { Router } from "express";
import { asc, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/db-client.js";
import { programs } from "@workspace/db/schema";
import {
  authedUser,
  blockDemoWrites,
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove,
  requireSuperUser
} from "../../middleware/current-user.js";

export const programsRouter = Router();

// blockDemoWrites is defense-in-depth here: program creation is already
// super_user-only and demo roles are schema-capped at manager, so a demo
// account can't reach the POST today — the guard keeps that true if a
// manager-level mutation is ever added to this router.
programsRouter.use(
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove,
  blockDemoWrites
);

export interface ProgramListItem {
  id: string;
  name: string;
  createdAt: string | null;
}

/**
 * List programs the actor can see.
 *
 *   super_user      → all programs (the picker needs every option)
 *   senior_manager  → their own program (so the future Users page can
 *                     read it for context without a second endpoint)
 *   manager         → same as senior_manager
 *   csr             → blocked at the router level (requireManagerOrAbove)
 *
 * Sorting is stable by name so the picker UI doesn't reshuffle on each
 * fetch — a moving picker is a real footgun when a super_user is
 * switching contexts fast.
 */
programsRouter.get("/", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const rows = await db
      .select({
        id: programs.id,
        name: programs.name,
        createdAt: programs.createdAt
      })
      .from(programs)
      .where(
        user.role === "super_user"
          ? undefined
          : // DB CHECK guarantees non-null program_id for non-super_user.
            // Filter to the actor's own program only.
            sql`${programs.id} = ${user.programId}`
      )
      .orderBy(asc(programs.name));
    const items: ProgramListItem[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null
    }));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

const CreateBody = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    // Reject embedded control characters (null bytes, tabs, newlines,
    // etc.). A name like "Acme\x00Corp" would pass min/max/trim but
    // render oddly in the picker and trip up lower() comparisons.
    .regex(/^[^\x00-\x1f\x7f]+$/, "Name must not contain control characters")
});

/**
 * Create a program. Super_user only — adding a program implicitly
 * grants access to every user with a role above csr (managers/senior
 * managers see everything in their own program, but program creation
 * is an ops decision that should sit with the platform owner).
 *
 * Duplicate detection has two layers:
 *   1. An application-level pre-flight (case-insensitive SELECT). Gives
 *      a friendly 409 in the common case.
 *   2. A unique index on lower(name) at the DB level (see
 *      REPLIT_HANDOFF.md Section B3) closes the TOCTOU race: two
 *      simultaneous POSTs that both pass the pre-flight will collide
 *      on insert. We catch the 23505 unique-violation and map it to
 *      the same 409.
 *
 * If the DB unique index hasn't been created yet (pre-DDL deploy), the
 * 23505 branch is simply unreachable — the pre-flight still works,
 * just with the original race window. Safe to ship the code before
 * the index lands.
 */
programsRouter.post("/", requireSuperUser, async (req, res, next) => {
  try {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const name = parsed.data.name;
    const existing = await db
      .select({ id: programs.id })
      .from(programs)
      .where(sql`lower(${programs.name}) = lower(${name})`)
      .limit(1);
    if (existing[0]) {
      res.status(409).json({ error: "A program with that name already exists" });
      return;
    }
    try {
      const inserted = await db
        .insert(programs)
        .values({ name })
        .returning({
          id: programs.id,
          name: programs.name,
          createdAt: programs.createdAt
        });
      const row = inserted[0];
      if (!row) {
        res.status(500).json({ error: "Failed to create program" });
        return;
      }
      const item: ProgramListItem = {
        id: row.id,
        name: row.name,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null
      };
      res.status(201).json({ item });
    } catch (err) {
      // Postgres unique-violation. Drizzle / pg surface this as
      // either a `code: "23505"` field or a wrapped error; check both.
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code: unknown }).code
          : undefined;
      if (code === "23505") {
        res
          .status(409)
          .json({ error: "A program with that name already exists" });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});
