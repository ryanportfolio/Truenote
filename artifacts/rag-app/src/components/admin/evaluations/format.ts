import type {
  EvalQuestionResult,
  EvalRunConfiguration,
  ModelRoutingOption
} from "@/types/api";

export function formatPct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

export function formatCheck(value: boolean | null): string {
  return value === null ? "not applicable" : value ? "pass" : "fail";
}

export function formatGenerationPath(path: EvalQuestionResult["generationPath"]): string {
  switch (path) {
    case "retrieval-refusal":
      return "retrieval refusal (no model call)";
    case "primary":
      return "configured primary";
    case "fallback":
      return "later ZDR route";
    case "fallback-failed":
      return "all ZDR routes failed; safe refusal";
    default:
      return "not run";
  }
}

export function kindLabel(kind: EvalQuestionResult["kind"]): string {
  return kind === "in-kb" ? "Should answer" : "Should refuse";
}

/**
 * Reasoning setting in words. Toggle routes only switch reasoning on
 * ("medium") or off ("none"); effort routes name the level.
 */
export function formatEffort(
  effort: string | undefined,
  control: ModelRoutingOption["reasoningControl"] | undefined
): string | null {
  if (!effort) return null;
  if (effort === "none") return "reasoning off";
  if (control === "toggle") return "reasoning on";
  return `${effort} effort`;
}

/** "Trial: Nemotron 3.5 Lightning, reasoning on, threshold 0.25, top 8" */
export function trialSetupLine(
  configuration: EvalRunConfiguration,
  routes: ModelRoutingOption[]
): string {
  const route = configuration.routeChain?.[0] ?? configuration.generation;
  const control = routes.find((candidate) => candidate.id === route.id)?.reasoningControl;
  const parts = [
    route.label,
    formatEffort(route.reasoningEffort, control),
    `threshold ${configuration.retrieval.threshold}`,
    `top ${configuration.retrieval.topK}`
  ].filter((part): part is string => Boolean(part));
  return `Trial: ${parts.join(", ")}`;
}

/** The live answer chain a non-trial run used, in fallback order. */
export function liveSetupLine(
  configuration: EvalRunConfiguration,
  judge: boolean
): string {
  const chain = (configuration.routeChain ?? [configuration.generation])
    .map((route) =>
      route.reasoningEffort ? `${route.label} (${route.reasoningEffort})` : route.label
    )
    .join(" → ");
  const backup = configuration.fallback
    ? ` → ${configuration.fallback.label} legacy direct backup`
    : " · ZDR-only routes";
  return `${chain}${backup} · top ${configuration.retrieval.topK} · threshold ${configuration.retrieval.threshold}${judge ? " · faithfulness judge on" : ""}`;
}
