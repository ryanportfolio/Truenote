import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db-client.js";

export const ApprovedModelRouteIdSchema = z.enum([
  "gpt-5.6-luna-openai",
  "gpt-5.4-nano-azure-nitro",
  "nemotron-3-super-digitalocean-nitro",
  "nemotron-3-ultra-together-nitro"
]);

export type ApprovedModelRouteId = z.infer<typeof ApprovedModelRouteIdSchema>;

export interface ApprovedModelRoute {
  id: ApprovedModelRouteId;
  label: string;
  model: string;
  provider: string;
  providerLabel: string;
  reasoningEffort: "low" | "medium";
  description: string;
}

export const APPROVED_MODEL_ROUTES: readonly ApprovedModelRoute[] = [
  {
    id: "gpt-5.6-luna-openai",
    label: "GPT-5.6 Luna",
    model: "openai/gpt-5.6-luna",
    provider: "openai",
    providerLabel: "OpenAI",
    reasoningEffort: "low",
    description: "Primary route: fast, grounded answers at low reasoning."
  },
  {
    id: "gpt-5.4-nano-azure-nitro",
    label: "GPT-5.4 Nano",
    model: "openai/gpt-5.4-nano:nitro",
    provider: "azure",
    providerLabel: "Azure",
    reasoningEffort: "medium",
    description: "Fast, economical default for grounded answers."
  },
  {
    id: "nemotron-3-super-digitalocean-nitro",
    label: "Nemotron 3 Super",
    model: "nvidia/nemotron-3-super-120b-a12b:nitro",
    provider: "digitalocean",
    providerLabel: "DigitalOcean",
    reasoningEffort: "medium",
    description: "Efficient open reasoning model for routine RAG workloads."
  },
  {
    id: "nemotron-3-ultra-together-nitro",
    label: "Nemotron 3 Ultra",
    model: "nvidia/nemotron-3-ultra-550b-a55b:nitro",
    provider: "together",
    providerLabel: "Together",
    reasoningEffort: "medium",
    description: "Larger open model for harder multi-step questions."
  }
];

export const DEFAULT_MODEL_ROUTE = APPROVED_MODEL_ROUTES[0]!;
export const FALLBACK_MODEL = {
  label: "GPT-5.6 Luna",
  model: "gpt-5.6-luna",
  providerLabel: "OpenAI",
  reasoningEffort: "low" as const
};

const SETTING_KEY = "primary_generation_route";
const CACHE_TTL_MS = 30_000;

/** Current stored shape: an ordered chain of approved route ids. Index 0 is
 *  the primary; each subsequent id is tried when the one before it errors. */
const StoredOrderSchema = z.object({
  order: z.array(z.string()).min(1)
});
/** Legacy shape from before ordered fallback chains: a single primary id.
 *  Still read-compatible so an existing app_settings row keeps working — the
 *  id becomes the primary and the remaining approved routes trail it. */
const StoredSelectionSchema = z.object({
  selectedId: ApprovedModelRouteIdSchema
});

/** Default chain when nothing is persisted: the approved routes in listed
 *  order (GPT-5.6 Luna primary). */
export const DEFAULT_MODEL_ROUTE_ORDER: readonly ApprovedModelRouteId[] =
  APPROVED_MODEL_ROUTES.map((route) => route.id);

/**
 * Resolve stored ids into the ordered approved-route chain. Unknown ids are
 * dropped and duplicates collapsed, then any approved route missing from the
 * stored order is appended in listed order — so a newly-approved model still
 * participates as a tail fallback until an admin reorders it, and the chain is
 * never empty. The allowlist stays authoritative: nothing outside
 * APPROVED_MODEL_ROUTES can enter the chain.
 */
export function resolveModelRouteOrder(
  ids: readonly string[]
): ApprovedModelRoute[] {
  const seen = new Set<string>();
  const chain: ApprovedModelRoute[] = [];
  for (const id of ids) {
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
  return chain;
}

/** Extract the stored id order from either the current `{ order }` shape or
 *  the legacy `{ selectedId }` shape. Anything unrecognized → default order. */
function readStoredOrder(value: unknown): readonly string[] {
  const ordered = StoredOrderSchema.safeParse(value);
  if (ordered.success) return ordered.data.order;
  const legacy = StoredSelectionSchema.safeParse(value);
  if (legacy.success) return [legacy.data.selectedId];
  return DEFAULT_MODEL_ROUTE_ORDER;
}

export interface ModelRoutingState {
  /** Ordered fallback chain; index 0 is the primary route. Never empty. */
  routes: ApprovedModelRoute[];
  persistenceReady: boolean;
}

interface SettingRow {
  value: unknown;
}

let cached: { state: ModelRoutingState; expiresAt: number } | null = null;

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
 * Read the global primary route. Missing DDL never breaks answer generation:
 * the approved GPT-5.4 Nano/Azure default remains active until storage lands.
 */
export async function getModelRoutingState(): Promise<ModelRoutingState> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.state;

  let state: ModelRoutingState;
  try {
    const result = await db.execute(sql`
      SELECT value
      FROM app_settings
      WHERE key = ${SETTING_KEY}
      LIMIT 1
    `);
    const row = result.rows[0] as unknown as SettingRow | undefined;
    state = {
      routes: resolveModelRouteOrder(readStoredOrder(row?.value)),
      persistenceReady: true
    };
  } catch (error) {
    if (!isMissingModelSettingsTable(error)) {
      console.warn(
        "[model-routing] failed to read setting; using approved default:",
        error instanceof Error ? error.message : error
      );
    }
    state = {
      routes: resolveModelRouteOrder(DEFAULT_MODEL_ROUTE_ORDER),
      persistenceReady: false
    };
  }

  cached = { state, expiresAt: now + CACHE_TTL_MS };
  return state;
}

export async function getActiveModelChain(): Promise<ApprovedModelRoute[]> {
  return (await getModelRoutingState()).routes;
}

export async function saveModelRouteOrder(
  ids: readonly ApprovedModelRouteId[],
  updatedBy: string
): Promise<ModelRoutingState> {
  // Normalize through the same resolver the read path uses, so the stored
  // order is always a full, deduped permutation of the allowlist.
  const routes = resolveModelRouteOrder(ids);
  const value = JSON.stringify({ order: routes.map((route) => route.id) });
  await db.execute(sql`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (${SETTING_KEY}, ${value}::jsonb, ${updatedBy}::uuid, now())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
  `);
  const state = { routes, persistenceReady: true };
  cached = { state, expiresAt: Date.now() + CACHE_TTL_MS };
  return state;
}

