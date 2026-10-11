import { Router } from "express";
import { z } from "zod";
import {
  authedUser,
  blockDemoWrites,
  requireAuth,
  requireFreshPassword,
  requireSuperUser
} from "../../middleware/current-user.js";
import { adminConfigWriteLimit } from "../../lib/security/route-rate-limit.js";
import {
  ApprovedModelRouteIdSchema,
  getModelRoutingState,
  isMissingModelSettingsTable,
  saveModelRouteOrder,
  type ModelRoutingState
} from "../../lib/generation/model-routing.js";

export const modelRoutingRouter = Router();

modelRoutingRouter.use(
  requireAuth,
  requireFreshPassword,
  requireSuperUser,
  blockDemoWrites
);

// `purpose` picks the chain: "answers" (CSR answers, the default so older
// clients keep working) or "gaps" (the Gaps page's refusal analysis).
const UpdateBody = z.object({
  order: z.array(ApprovedModelRouteIdSchema).min(1),
  purpose: z.enum(["answers", "gaps"]).default("answers")
});

function responseFor(answers: ModelRoutingState, gaps: ModelRoutingState) {
  return {
    order: answers.routes.map((route) => route.id),
    routes: answers.routes,
    gapsOrder: gaps.routes.map((route) => route.id),
    gapsRoutes: gaps.routes,
    persistenceReady: answers.persistenceReady && gaps.persistenceReady
  };
}

async function bothStates(): Promise<[ModelRoutingState, ModelRoutingState]> {
  return Promise.all([getModelRoutingState("answers"), getModelRoutingState("gaps")]);
}

modelRoutingRouter.get("/", async (_req, res, next) => {
  try {
    res.json(responseFor(...(await bothStates())));
  } catch (error) {
    next(error);
  }
});

modelRoutingRouter.put("/", adminConfigWriteLimit, async (req, res, next) => {
  const parsed = UpdateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Provide an ordered list of approved model routes" });
    return;
  }

  try {
    const user = authedUser(req);
    await saveModelRouteOrder(parsed.data.order, user.id, parsed.data.purpose);
    res.json(responseFor(...(await bothStates())));
  } catch (error) {
    if (isMissingModelSettingsTable(error)) {
      res.status(503).json({
        error: "Model routing storage is not installed yet"
      });
      return;
    }
    next(error);
  }
});

