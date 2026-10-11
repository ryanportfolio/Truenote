import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { getModelRouting, updateModelRouting } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  CurrentUser,
  ModelRoutingConfig,
  ModelRoutingOption,
  ModelRoutingPurpose,
  ReasoningEffort
} from "@/types/api";

interface AdminModelRoutingPageProps {
  user: CurrentUser;
}

export function AdminModelRoutingPage({
  user
}: AdminModelRoutingPageProps): JSX.Element {
  if (user.role !== "super_user") {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Forbidden
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Model routing is restricted to super users.
        </p>
      </div>
    );
  }
  return <ModelRoutingPanel />;
}

/** Move the item at `from` to index `to`, returning a new array. */
function move<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(to, 0, moved);
  return next;
}

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  none: "None (no reasoning)",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high"
};

/** A model that only switches reasoning on or off names its two levels so. */
const TOGGLE_LABEL: Partial<Record<ReasoningEffort, string>> = {
  none: "Off (no reasoning)",
  medium: "On"
};

function effortLabel(option: ModelRoutingOption, effort: ReasoningEffort): string {
  return (option.reasoningControl === "toggle" ? TOGGLE_LABEL[effort] : null) ?? EFFORT_LABEL[effort];
}

/** Route id → effort, as a comparable key and as the PUT body. */
function effortsOf(routes: ModelRoutingOption[]): Record<string, ReasoningEffort> {
  return Object.fromEntries(routes.map((route) => [route.id, route.reasoningEffort]));
}

const CHAINS: ReadonlyArray<{
  purpose: ModelRoutingPurpose;
  title: string;
  description: string;
}> = [
  {
    purpose: "answers",
    title: "Answers",
    description:
      "Answers CSR questions. A model that correctly can’t find an answer isn’t an error and won’t trigger fallback."
  },
  {
    purpose: "gaps",
    title: "Gaps analysis",
    description:
      "Groups refused questions into themes on the Gaps page and suggests which sources to add or update."
  }
];

function ModelRoutingPanel(): JSX.Element {
  const [config, setConfig] = useState<ModelRoutingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getModelRouting()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(
            reason instanceof Error ? reason.message : "Failed to load model routing"
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="max-w-3xl">
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Model routing
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Drag to set each fallback order. The top model runs first; if a model
          errors, the next one down is tried, and so on. Effort sets how much
          each model reasons before it replies: higher is slower and costs
          more. Each model lists only the levels it supports. Every route is
          restricted to a Zero Data Retention endpoint.
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {loading || !config ? (
        <div role="status" className="grid gap-6 lg:grid-cols-2">
          {[0, 1].map((column) => (
            <div key={column} className="flex flex-col gap-2">
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="rounded-lg border border-border bg-card px-4 py-4 shadow-card"
                >
                  <div className="skeleton h-4 w-48" />
                  <div className="skeleton mt-2 h-3 w-72 max-w-full" />
                </div>
              ))}
            </div>
          ))}
          <span className="sr-only">Loading model routes…</span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {!config.persistenceReady ? (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
              Storage setup required. The default order is active, but changes
              cannot be saved until the reviewed DDL is applied.
            </p>
          ) : null}
          <div className="grid items-start gap-6 lg:grid-cols-2">
            {CHAINS.map((chain) => (
              <RouteChain
                key={chain.purpose}
                purpose={chain.purpose}
                title={chain.title}
                description={chain.description}
                initial={chain.purpose === "gaps" ? config.gapsRoutes : config.routes}
                canSave={config.persistenceReady}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface RouteChainProps {
  purpose: ModelRoutingPurpose;
  title: string;
  description: string;
  initial: ModelRoutingOption[];
  canSave: boolean;
}

/** One drag/drop fallback chain with its own save. */
function RouteChain({
  purpose,
  title,
  description,
  initial,
  canSave
}: RouteChainProps): JSX.Element {
  const [routes, setRoutes] = useState<ModelRoutingOption[]>(initial);
  const [savedOrder, setSavedOrder] = useState<string[]>(() =>
    initial.map((route) => route.id)
  );
  const [savedEfforts, setSavedEfforts] = useState(() => JSON.stringify(effortsOf(initial)));
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const headingId = `model-chain-${purpose}`;

  const currentOrder = routes.map((route) => route.id);
  const dirty =
    currentOrder.join("\u0000") !== savedOrder.join("\u0000") ||
    JSON.stringify(effortsOf(routes)) !== savedEfforts;

  function setEffort(id: string, effort: ReasoningEffort): void {
    setRoutes((prev) =>
      prev.map((route) => (route.id === id ? { ...route, reasoningEffort: effort } : route))
    );
    setSaved(false);
  }

  function reorder(from: number, to: number): void {
    if (to < 0 || to >= routes.length || from === to) return;
    setRoutes((prev) => move(prev, from, to));
    setSaved(false);
  }

  function onDragEnter(index: number): void {
    if (dragIndex === null || dragIndex === index) return;
    setRoutes((prev) => move(prev, dragIndex, index));
    setDragIndex(index);
    setSaved(false);
  }

  async function save(): Promise<void> {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await updateModelRouting(currentOrder, purpose, effortsOf(routes));
      const stored = purpose === "gaps" ? next.gapsRoutes : next.routes;
      setRoutes(stored);
      setSavedOrder(stored.map((route) => route.id));
      setSavedEfforts(JSON.stringify(effortsOf(stored)));
      setSaved(true);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Failed to update model routing"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div>
        <h2 id={headingId} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <ol className="flex flex-col gap-2">
        {routes.map((option, index) => {
          const isPrimary = index === 0;
          return (
            <li
              key={option.id}
              draggable={!saving}
              onDragStart={() => {
                setDragIndex(index);
                setSaved(false);
              }}
              onDragEnter={() => onDragEnter(index)}
              onDragOver={(event) => event.preventDefault()}
              onDragEnd={() => setDragIndex(null)}
              className={cn(
                "flex items-start gap-3 rounded-lg border bg-card px-4 py-4 shadow-card transition-colors duration-100 ease-out",
                dragIndex === index
                  ? "border-primary/60 opacity-70"
                  : isPrimary
                    ? "border-primary/40 bg-primary/5"
                    : "border-border",
                saving ? "cursor-default" : "cursor-grab"
              )}
            >
              <span className="mt-1 shrink-0 text-muted-foreground" aria-hidden>
                <GripVertical className="h-4 w-4" />
              </span>

              <span className="flex shrink-0 flex-col items-center gap-1">
                <button
                  type="button"
                  aria-label={`Move ${option.label} up in ${title}`}
                  disabled={saving || index === 0}
                  onClick={() => reorder(index, index - 1)}
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${option.label} down in ${title}`}
                  disabled={saving || index === routes.length - 1}
                  onClick={() => reorder(index, index + 1)}
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </button>
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-medium",
                      isPrimary
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {isPrimary ? "Primary" : `Fallback ${index}`}
                  </span>
                  <span className="text-sm font-medium">{option.label}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {option.providerLabel}
                  </span>
                  <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    {option.reasoningControl === "toggle" ? "Reasoning" : "Effort"}
                    <select
                      value={option.reasoningEffort}
                      disabled={saving}
                      onChange={(event) =>
                        setEffort(option.id, event.target.value as ReasoningEffort)
                      }
                      aria-label={`${option.reasoningControl === "toggle" ? "Reasoning" : "Effort"} for ${option.label} in ${title}`}
                      className="select-quiet rounded-md border border-input bg-card py-0.5 pl-2 pr-6 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {option.supportedEfforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effortLabel(option, effort)}
                          {effort === option.defaultReasoningEffort ? " (default)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {option.description}
                </span>
                <code className="mt-2 block break-all text-xs text-muted-foreground">
                  {option.model}
                </code>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-h-5 text-sm text-success" role="status">
          {saved ? (
            <span className="inline-flex items-center gap-1.5">
              <Check className="h-4 w-4" aria-hidden />
              {title} settings updated
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !canSave || !dirty}
          className="btn-primary px-5 py-2 text-base"
        >
          {saving ? "Saving…" : `Save ${title.toLowerCase()}`}
        </button>
      </div>
    </section>
  );
}
