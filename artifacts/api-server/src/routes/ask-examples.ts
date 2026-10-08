import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../lib/db-client.js";
import {
  authedUser,
  blockDemoWrites,
  requireAuth,
  requireCsrOrAbove,
  requireFreshPassword,
  requireManagerOrAbove
} from "../middleware/current-user.js";
import { canAccessProgram } from "../lib/auth/current-user.js";
import { resolveEffectiveProgramId } from "../lib/auth/effective-program.js";
import { clientIpFrom } from "../lib/auth/rate-limit.js";
import { appendSecurityEvent } from "../lib/security/audit.js";
import { askExamplesWriteLimit } from "../lib/security/route-rate-limit.js";

/**
 * Example questions on the empty Ask page, per program. Managers and above
 * replace the list for their own program; everyone in the program reads it.
 * Stored as one app_settings row per program (`ask_examples:<program id>`);
 * no row means the defaults below. Clicking an example only fills the
 * question box, so a stored question never runs on its own.
 */
export const DEFAULT_ASK_EXAMPLES = [
  "What's the cancellation fee on the Basic plan?",
  "How long does a refund take to post to the original card?",
  "Who must approve a courtesy refund?"
] as const;

export const ASK_EXAMPLES_MAX = 6;
export const ASK_EXAMPLE_MAX_LENGTH = 200;

const questionsSchema = z
  .array(z.string().trim().min(1).max(ASK_EXAMPLE_MAX_LENGTH))
  .max(ASK_EXAMPLES_MAX);

const putSchema = z.object({ questions: questionsSchema });

function settingKey(programId: string): string {
  return `ask_examples:${programId}`;
}

/** Drop repeats (case-insensitive), keeping the first spelling and order. */
function dedupe(questions: string[]): string[] {
  const seen = new Set<string>();
  return questions.filter((q) => {
    const key = q.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const askExamplesRouter = Router();

askExamplesRouter.use(requireAuth, requireFreshPassword, requireCsrOrAbove);

async function programFor(req: Request, res: Response): Promise<string | null> {
  const user = authedUser(req);
  const programId = await resolveEffectiveProgramId(user, req);
  if (programId === null) {
    res.status(400).json({ error: "No program selected." });
    return null;
  }
  if (!canAccessProgram(user, programId)) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return programId;
}

askExamplesRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const programId = await programFor(req, res);
    if (programId === null) return;
    const result = await db.execute(sql`
      SELECT value FROM app_settings WHERE key = ${settingKey(programId)} LIMIT 1
    `);
    const row = result.rows[0] as { value?: unknown } | undefined;
    const stored = questionsSchema.safeParse(
      (row?.value as { questions?: unknown } | undefined)?.questions
    );
    if (row && stored.success && stored.data.length > 0) {
      res.json({ questions: stored.data, custom: true });
      return;
    }
    res.json({ questions: [...DEFAULT_ASK_EXAMPLES], custom: false });
  } catch (err) {
    next(err);
  }
});

/** Replace the list. An empty list goes back to the defaults. */
askExamplesRouter.put(
  "/",
  requireManagerOrAbove,
  blockDemoWrites,
  askExamplesWriteLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const programId = await programFor(req, res);
      if (programId === null) return;
      const parsed = putSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: `Send up to ${ASK_EXAMPLES_MAX} questions, each 1 to ${ASK_EXAMPLE_MAX_LENGTH} characters.`
        });
        return;
      }
      const questions = dedupe(parsed.data.questions);
      const user = authedUser(req);
      const key = settingKey(programId);
      await db.transaction(async (tx) => {
        if (questions.length === 0) {
          await tx.execute(sql`DELETE FROM app_settings WHERE key = ${key}`);
        } else {
          await tx.execute(sql`
            INSERT INTO app_settings (key, value, updated_by, updated_at)
            VALUES (${key}, ${JSON.stringify({ questions })}::jsonb, ${user.id}::uuid, now())
            ON CONFLICT (key) DO UPDATE SET
              value = EXCLUDED.value,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
          `);
        }
        const requestId = res.getHeader("X-Request-Id");
        await appendSecurityEvent(
          {
            action: "ask.examples.set",
            outcome: "success",
            actor: user,
            programId,
            resourceType: "ask_examples",
            resourceId: null,
            requestId: typeof requestId === "string" ? requestId : null,
            sourceIp: clientIpFrom(req),
            details: { count: questions.length, reset: questions.length === 0 }
          },
          tx as unknown as Parameters<typeof appendSecurityEvent>[1]
        );
      });
      const custom = questions.length > 0;
      res.json({ questions: custom ? questions : [...DEFAULT_ASK_EXAMPLES], custom });
    } catch (err) {
      next(err);
    }
  }
);
