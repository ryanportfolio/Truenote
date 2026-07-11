import { Router } from "express";
import { z } from "zod";
import {
  authedUser,
  blockDemoWrites,
  requireAuth,
  requireFreshPassword,
  requireSuperUser
} from "../../middleware/current-user.js";
import {
  APPROVED_MODEL_ROUTES,
  ApprovedModelRouteIdSchema,
  FALLBACK_MODEL,
  getModelRoutingState,
  isMissingModelSettingsTable,
  saveActiveModelRoute,
  type ModelRoutingState
} from "../../lib/generation/model-routing.js";

export const modelRoutingRouter = Router();

modelRoutingRouter.use(
  requireAuth,
  requireFreshPassword,
  requireSuperUser,
  blockDemoWrites
);

const UpdateBody = z.object({ selectedId: ApprovedModelRouteIdSchema });

function responseFor(state: ModelRoutingState) {
  return {
    selectedId: state.route.id,
    persistenceReady: state.persistenceReady,
    options: APPROVED_MODEL_ROUTES,
    fallback: FALLBACK_MODEL
  };
}

modelRoutingRouter.get("/", async (_req, res, next) => {
  try {
    res.json(responseFor(await getModelRoutingState()));
  } catch (error) {
    next(error);
  }
});

modelRoutingRouter.put("/", async (req, res, next) => {
  const parsed = UpdateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose an approved model route" });
    return;
  }

  try {
    const user = authedUser(req);
    const state = await saveActiveModelRoute(parsed.data.selectedId, user.id);
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

