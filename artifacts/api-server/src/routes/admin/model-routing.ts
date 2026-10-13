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
  effortsAreSupported,
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
// clients keep working), "gaps" (the Gaps page's refusal analysis) or
// "compliance" (the Compliance page's question box).
// `efforts` maps route ids to reasoning efforts; each must be one that
// route's model supports (`supportedEfforts`). Omitted routes keep their
// default.
const UpdateBody = z.object({
  order: z.array(ApprovedModelRouteIdSchema).min(1),
  purpose: z.enum(["answers", "gaps", "compliance"]).default("answers"),
  efforts: z.record(z.string()).optional()
});

function responseFor(
  answers: ModelRoutingState,
  gaps: ModelRoutingState,
  compliance: ModelRoutingState
) {
  return {
    order: answers.routes.map((route) => route.id),
    routes: answers.routes,
    gapsOrder: gaps.routes.map((route) => route.id),
    gapsRoutes: gaps.routes,
    complianceOrder: compliance.routes.map((route) => route.id),
    complianceRoutes: compliance.routes,
    persistenceReady:
      answers.persistenceReady && gaps.persistenceReady && compliance.persistenceReady
  };
}

async function allStates(): Promise<[ModelRoutingState, ModelRoutingState, ModelRoutingState]> {
  return Promise.all([
    getModelRoutingState("answers"),
    getModelRoutingState("gaps"),
    getModelRoutingState("compliance")
  ]);
}

modelRoutingRouter.get("/", async (_req, res, next) => {
  try {
    res.json(responseFor(...(await allStates())));
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
  if (parsed.data.efforts && !effortsAreSupported(parsed.data.efforts)) {
    res.status(400).json({ error: "Pick an effort level that model supports" });
    return;
  }

  try {
    const user = authedUser(req);
    await saveModelRouteOrder(
      parsed.data.order,
      user.id,
      parsed.data.purpose,
      parsed.data.efforts
    );
    res.json(responseFor(...(await allStates())));
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

