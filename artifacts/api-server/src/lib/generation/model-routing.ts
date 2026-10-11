import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db-client.js";
import { recordAppError } from "../observability/error-log.js";

export const ApprovedModelRouteIdSchema = z.enum([
  "gpt-5.4-nano-azure-nitro",
  "nemotron-3-super-deepinfra-nitro",
  "nemotron-3-ultra-baseten-nitro",
  "mercury-2.5-inception",
  "granite-4.2-8b-coreweave",
  "nemotron-3.5-lightning-coreweave"
]);

export type ApprovedModelRouteId = z.infer<typeof ApprovedModelRouteIdSchema>;

/** OpenRouter `reasoning_effort` values. "none" turns reasoning off. */
export const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export interface ApprovedModelRoute {
  id: ApprovedModelRouteId;
  label: string;
  model: string;
  provider: string;
  providerLabel: string;
  /** Effort sent with each request; an admin may pick another supported one. */
  reasoningEffort: ReasoningEffort;
  /** The effort before any admin choice. */
  defaultReasoningEffort: ReasoningEffort;
  /** Efforts the model accepts, from OpenRouter's model metadata. */
  supportedEfforts: readonly ReasoningEffort[];
  /**
   * How the effort reaches the provider: "effort" sends `reasoning_effort`;
   * "toggle" is for endpoints that only switch reasoning on or off
   * (`reasoning.enabled`), offered as "none" (off) and "medium" (on).
   */
  reasoningControl: "effort" | "toggle";
  /** The pinned endpoint accepts `response_format` (JSON mode). */
  jsonMode: boolean;
  description: string;
}

/**
 * Every route pins one provider that lists a ZDR endpoint for its model in
 * OpenRouter's public ZDR index (GET /api/v1/endpoints/zdr). Re-checked
 * 2026-10-07: the earlier DigitalOcean (Nemotron 3 Super), Together (Nemotron
 * 3 Ultra) and "wandb" (Granite 4.1 8B) pins had no ZDR endpoint, so every
 * request to them was rejected. Before adding or re-pinning a route, confirm
 * the model/provider pair appears in that index.
 *
 * supportedEfforts is each model's `reasoning.supported_efforts` in
 * OpenRouter's model list (GET /api/v1/models), re-checked 2026-10-11; every
 * "effort" route's pinned endpoint lists `reasoning_effort` among its
 * supported parameters (GET /api/v1/models/<model>/endpoints). Nemotron 3.5
 * Lightning lists no efforts and its endpoints take only `reasoning`, so it
 * is a "toggle" route. jsonMode is `response_format` in the same endpoint
 * list (all but BaseTen's Nemotron 3 Ultra). Re-check all three when
 * re-pinning.
 */
export const APPROVED_MODEL_ROUTES: readonly ApprovedModelRoute[] = [
  {
    id: "nemotron-3-super-deepinfra-nitro",
    label: "Nemotron 3 Super",
    model: "nvidia/nemotron-3-super-120b-a12b:nitro",
    provider: "deepinfra",
    providerLabel: "DeepInfra",
    reasoningEffort: "medium",
    defaultReasoningEffort: "medium",
    supportedEfforts: ["low", "medium"],
    reasoningControl: "effort",
    jsonMode: true,
    description: "Default ZDR route for grounded answers."
  },
  {
    id: "gpt-5.4-nano-azure-nitro",
    label: "GPT-5.4 Nano",
    model: "openai/gpt-5.4-nano:nitro",
    provider: "azure",
    providerLabel: "Azure",
    reasoningEffort: "medium",
    defaultReasoningEffort: "medium",
    supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
    reasoningControl: "effort",
    jsonMode: true,
    description: "Fast, economical route for grounded answers."
  },
  {
    id: "nemotron-3-ultra-baseten-nitro",
    label: "Nemotron 3 Ultra",
    model: "nvidia/nemotron-3-ultra-550b-a55b:nitro",
    provider: "baseten",
    providerLabel: "BaseTen",
    reasoningEffort: "medium",
    defaultReasoningEffort: "medium",
    supportedEfforts: ["medium", "high"],
    reasoningControl: "effort",
    jsonMode: false,
    description: "Larger open model for harder multi-step questions."
  },
  {
    id: "mercury-2.5-inception",
    label: "Mercury 2.5",
    model: "inception/mercury-2.5",
    provider: "inception",
    providerLabel: "Inception",
    reasoningEffort: "low",
    defaultReasoningEffort: "low",
    supportedEfforts: ["none", "low", "medium", "high"],
    reasoningControl: "effort",
    jsonMode: true,
    description: "Ultra-fast diffusion model for low-latency grounded answers."
  },
  {
    id: "granite-4.2-8b-coreweave",
    label: "Granite 4.2 8B",
    model: "ibm-granite/granite-4.2-8b",
    provider: "coreweave",
    providerLabel: "CoreWeave",
    reasoningEffort: "low",
    defaultReasoningEffort: "low",
    supportedEfforts: ["none", "low", "high"],
    reasoningControl: "effort",
    jsonMode: true,
    description: "Compact IBM reasoning model on CoreWeave's ZDR endpoint."
  },
  {
    id: "nemotron-3.5-lightning-coreweave",
    label: "Nemotron 3.5 Lightning",
    model: "nvidia/nemotron-3.5-lightning",
    provider: "coreweave",
    providerLabel: "CoreWeave",
    reasoningEffort: "medium",
    defaultReasoningEffort: "medium",
    supportedEfforts: ["none", "medium"],
    reasoningControl: "toggle",
    jsonMode: true,
    description: "Small, fast NVIDIA model (3B active) on CoreWeave's full-precision ZDR endpoint."
  }
];

/**
 * The OpenRouter request fields that carry a route's effort. "none" is sent
 * too: models that reason by default would otherwise reason anyway.
 */
export function reasoningRequestFields(
  route: Pick<ApprovedModelRoute, "reasoningControl" | "reasoningEffort">
): Record<string, unknown> {
  return route.reasoningControl === "toggle"
    ? { reasoning: { enabled: route.reasoningEffort !== "none" } }
    : { reasoning_effort: route.reasoningEffort };
}

export const DEFAULT_MODEL_ROUTE = APPROVED_MODEL_ROUTES[0]!;

/**
 * Route ids retired when a route was re-pinned to a ZDR provider or moved to
 * a newer model version, mapped to their replacement. An admin order saved
 * before the change keeps its positions instead of losing those entries and
 * promoting the next route.
 */
const RETIRED_ROUTE_ID_REPLACEMENTS: ReadonlyMap<string, ApprovedModelRouteId> = new Map([
  ["nemotron-3-super-digitalocean-nitro", "nemotron-3-super-deepinfra-nitro"],
  ["nemotron-3-ultra-together-nitro", "nemotron-3-ultra-baseten-nitro"],
  ["granite-4.1-8b-wandb", "granite-4.2-8b-coreweave"],
  ["mercury-2-inception", "mercury-2.5-inception"]
]);

function currentRouteId(id: string): string {
  return RETIRED_ROUTE_ID_REPLACEMENTS.get(id) ?? id;
}

/**
 * Each purpose keeps its own ordered chain over the same allowlist: answers
 * (CSR answer generation) and gaps (the Gaps page's refusal analysis). Both
 * rows live in app_settings, so a second purpose needs no DDL.
 */
export type ModelRoutingPurpose = "answers" | "gaps";

const SETTING_KEYS: Record<ModelRoutingPurpose, string> = {
  answers: "primary_generation_route",
  gaps: "gaps_analysis_route"
};
const CACHE_TTL_MS = 30_000;

/** Current stored shape: an ordered chain of approved route ids. Index 0 is
 *  the primary; each subsequent id is tried when the one before it errors. */
const StoredOrderSchema = z.object({
  order: z.array(z.string()).min(1),
  /** Route id → chosen effort; absent or unsupported entries use the default. */
  efforts: z.record(z.string()).optional()
});
/** Legacy shape from before ordered fallback chains: a single primary id.
 *  Still read-compatible so an existing app_settings row keeps working — the
 *  id becomes the primary and the remaining approved routes trail it. The id
 *  is checked against the allowlist in resolveModelRouteOrder, after retired
 *  ids are mapped to their replacement. */
const StoredSelectionSchema = z.object({
  selectedId: z.string().min(1)
});

/** Default chain when nothing is persisted: the approved ZDR routes in listed
 *  order (Nemotron 3 Super primary). */
export const DEFAULT_MODEL_ROUTE_ORDER: readonly ApprovedModelRouteId[] =
  APPROVED_MODEL_ROUTES.map((route) => route.id);

/**
 * Resolve stored ids into the ordered approved-route chain. Retired ids map to
 * their replacement route, unknown ids are dropped and duplicates collapsed,
 * then any approved route missing from the
 * stored order is appended in listed order — so a newly-approved model still
 * participates as a tail fallback until an admin reorders it, and the chain is
 * never empty. The allowlist stays authoritative: nothing outside
 * APPROVED_MODEL_ROUTES can enter the chain.
 */
export function resolveModelRouteOrder(
  ids: readonly string[],
  efforts: Readonly<Record<string, string>> = {}
): ApprovedModelRoute[] {
  const seen = new Set<string>();
  const chain: ApprovedModelRoute[] = [];
  for (const storedId of ids) {
    const id = currentRouteId(storedId);
    if (seen.has(id)) continue;
    const route = findApprovedModelRoute(id);
    if (route) {
      chain.push(route);
      seen.add(id);
    }
  }
  for (const route of APPROVED_MODEL_ROUTES) {
    if (!seen.has(route.id)) {
      chain.push(route);
      seen.add(route.id);
    }
  }
  return chain.map((route) => withEffort(route, efforts[route.id]));
}

/** The route with a chosen effort when the model supports it, else its default. */
function withEffort(route: ApprovedModelRoute, effort: string | undefined): ApprovedModelRoute {
  const parsed = ReasoningEffortSchema.safeParse(effort);
  return parsed.success && route.supportedEfforts.includes(parsed.data)
    ? { ...route, reasoningEffort: parsed.data }
    : route;
}

/** True when every entry names an approved route and an effort that route supports. */
export function effortsAreSupported(efforts: Readonly<Record<string, string>>): boolean {
  return Object.entries(efforts).every(([id, effort]) => {
    const route = findApprovedModelRoute(id);
    const parsed = ReasoningEffortSchema.safeParse(effort);
    return Boolean(route && parsed.success && route.supportedEfforts.includes(parsed.data));
  });
}

/** Extract the stored order and efforts from either the current `{ order,
 *  efforts? }` shape or the legacy `{ selectedId }` shape. Anything
 *  unrecognized → default order and efforts. */
function readStored(value: unknown): { order: readonly string[]; efforts: Record<string, string> } {
  const ordered = StoredOrderSchema.safeParse(value);
  if (ordered.success) return { order: ordered.data.order, efforts: ordered.data.efforts ?? {} };
  const legacy = StoredSelectionSchema.safeParse(value);
  if (legacy.success) return { order: [legacy.data.selectedId], efforts: {} };
  return { order: DEFAULT_MODEL_ROUTE_ORDER, efforts: {} };
}

export interface ModelRoutingState {
  /** Ordered fallback chain; index 0 is the primary route. Never empty. */
  routes: ApprovedModelRoute[];
  persistenceReady: boolean;
}

interface SettingRow {
  value: unknown;
}

const cached = new Map<ModelRoutingPurpose, { state: ModelRoutingState; expiresAt: number }>();

export function findApprovedModelRoute(id: string): ApprovedModelRoute | undefined {
  return APPROVED_MODEL_ROUTES.find((route) => route.id === id);
}

export function resolveApprovedModelRoute(id: unknown): ApprovedModelRoute {
  const parsed = ApprovedModelRouteIdSchema.safeParse(id);
  return parsed.success
    ? findApprovedModelRoute(parsed.data) ?? DEFAULT_MODEL_ROUTE
    : DEFAULT_MODEL_ROUTE;
}

export function isMissingModelSettingsTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code?: unknown }).code === "42P01"
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return false;
}

/**
 * Read one purpose's route chain. Missing DDL never breaks answer generation:
 * the approved Nemotron 3 Super default remains active until storage lands.
 */
export async function getModelRoutingState(
  purpose: ModelRoutingPurpose = "answers"
): Promise<ModelRoutingState> {
  const now = Date.now();
  const hit = cached.get(purpose);
  if (hit && hit.expiresAt > now) return hit.state;

  let state: ModelRoutingState;
  try {
    const result = await db.execute(sql`
      SELECT value
      FROM app_settings
      WHERE key = ${SETTING_KEYS[purpose]}
      LIMIT 1
    `);
    const row = result.rows[0] as unknown as SettingRow | undefined;
    const stored = readStored(row?.value);
    state = {
      routes: resolveModelRouteOrder(stored.order, stored.efforts),
      persistenceReady: true
    };
  } catch (error) {
    if (!isMissingModelSettingsTable(error)) {
      console.warn(
        "[model-routing] failed to read setting; using approved default:",
        error instanceof Error ? error.message : error
      );
      void recordAppError({
        severity: "warning",
        source: "configuration",
        operation: "read-model-routing",
        error
      });
    }
    state = {
      routes: resolveModelRouteOrder(DEFAULT_MODEL_ROUTE_ORDER),
      persistenceReady: false
    };
  }

  cached.set(purpose, { state, expiresAt: now + CACHE_TTL_MS });
  return state;
}

export async function getActiveModelChain(
  purpose: ModelRoutingPurpose = "answers"
): Promise<ApprovedModelRoute[]> {
  return (await getModelRoutingState(purpose)).routes;
}

export async function saveModelRouteOrder(
  ids: readonly ApprovedModelRouteId[],
  updatedBy: string,
  purpose: ModelRoutingPurpose = "answers",
  efforts: Readonly<Record<string, string>> = {}
): Promise<ModelRoutingState> {
  // Normalize through the same resolver the read path uses, so the stored
  // order is always a full, deduped permutation of the allowlist and every
  // stored effort is one its model supports.
  const routes = resolveModelRouteOrder(ids, efforts);
  const value = JSON.stringify({
    order: routes.map((route) => route.id),
    efforts: Object.fromEntries(routes.map((route) => [route.id, route.reasoningEffort]))
  });
  await db.execute(sql`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (${SETTING_KEYS[purpose]}, ${value}::jsonb, ${updatedBy}::uuid, now())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
  `);
  const state = { routes, persistenceReady: true };
  cached.set(purpose, { state, expiresAt: Date.now() + CACHE_TTL_MS });
  return state;
}

