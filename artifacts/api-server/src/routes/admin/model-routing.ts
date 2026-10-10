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

const UpdateBody = z.object({
  order: z.array(ApprovedModelRouteIdSchema).min(1)
});

function responseFor(state: ModelRoutingState) {
  return {
    order: state.routes.map((route) => route.id),
    routes: state.routes,
    persistenceReady: state.persistenceReady
  };
}

modelRoutingRouter.get("/", async (_req, res, next) => {
  try {
    res.json(responseFor(await getModelRoutingState()));
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
    const state = await saveModelRouteOrder(parsed.data.order, user.id);
    res.json(responseFor(state));
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

