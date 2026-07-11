import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db-client.js";

export const ApprovedModelRouteIdSchema = z.enum([
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
  reasoningEffort: "medium";
  description: string;
}

export const APPROVED_MODEL_ROUTES: readonly ApprovedModelRoute[] = [
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
const StoredSelectionSchema = z.object({
  selectedId: ApprovedModelRouteIdSchema
});

export interface ModelRoutingState {
  route: ApprovedModelRoute;
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
    const parsed = StoredSelectionSchema.safeParse(row?.value);
    state = {
      route: parsed.success
        ? resolveApprovedModelRoute(parsed.data.selectedId)
        : DEFAULT_MODEL_ROUTE,
      persistenceReady: true
    };
  } catch (error) {
    if (!isMissingModelSettingsTable(error)) {
      console.warn(
        "[model-routing] failed to read setting; using approved default:",
        error instanceof Error ? error.message : error
      );
    }
    state = { route: DEFAULT_MODEL_ROUTE, persistenceReady: false };
  }

  cached = { state, expiresAt: now + CACHE_TTL_MS };
  return state;
}

export async function getActiveModelRoute(): Promise<ApprovedModelRoute> {
  return (await getModelRoutingState()).route;
}

export async function saveActiveModelRoute(
  id: ApprovedModelRouteId,
  updatedBy: string
): Promise<ModelRoutingState> {
  const route = resolveApprovedModelRoute(id);
  const value = JSON.stringify({ selectedId: route.id });
  await db.execute(sql`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (${SETTING_KEY}, ${value}::jsonb, ${updatedBy}::uuid, now())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
  `);
  const state = { route, persistenceReady: true };
  cached = { state, expiresAt: Date.now() + CACHE_TTL_MS };
  return state;
}

