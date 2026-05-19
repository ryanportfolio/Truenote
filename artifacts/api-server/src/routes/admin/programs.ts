import { Router } from "express";
import { asc, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/db-client.js";
import { programs } from "@workspace/db/schema";
import {
  authedUser,
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove,
  requireSuperUser
} from "../../middleware/current-user.js";

export const programsRouter = Router();

programsRouter.use(requireAuth, requireFreshPassword, requireManagerOrAbove);

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
  name: z.string().trim().min(1).max(120)
});

/**
 * Create a program. Super_user only — adding a program implicitly
 * grants access to every user with a role above csr (managers/senior
 * managers see everything in their own program, but program creation
 * is an ops decision that should sit with the platform owner).
 *
 * Duplicate detection is case-insensitive on a trimmed name. We don't
 * have a unique index in the schema yet because the dataset is tiny
 * and a future "rename" feature might want to allow temporary
 * collisions during a migration; revisit when we add archive/rename.
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
    next(err);
  }
});
