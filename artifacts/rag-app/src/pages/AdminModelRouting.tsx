import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { getModelRouting, updateModelRouting } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  CurrentUser,
  ModelRoutingConfig,
  ModelRoutingOption
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

function ModelRoutingPanel(): JSX.Element {
  const [config, setConfig] = useState<ModelRoutingConfig | null>(null);
  const [routes, setRoutes] = useState<ModelRoutingOption[]>([]);
  const [savedOrder, setSavedOrder] = useState<string[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getModelRouting()
      .then((next) => {
        if (cancelled) return;
        setConfig(next);
        setRoutes(next.routes);
        setSavedOrder(next.order);
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

  const currentOrder = routes.map((route) => route.id);
  const orderChanged = currentOrder.join("\u0000") !== savedOrder.join("\u0000");

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
    if (!config || !orderChanged) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await updateModelRouting(currentOrder);
      setConfig(next);
      setRoutes(next.routes);
      setSavedOrder(next.order);
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
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Model routing
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Drag to set the fallback order. The top model answers first; if a model
          errors, the next one down is tried, and so on. A model that correctly
          can’t find an answer isn’t an error and won’t trigger fallback. Every
          route is restricted to a Zero Data Retention endpoint.
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
        <div role="status" className="flex flex-col gap-2">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="rounded-lg border border-border bg-card px-4 py-4 shadow-card"
            >
              <div className="skeleton h-4 w-48" />
              <div className="skeleton mt-2 h-3 w-72 max-w-full" />
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
                      aria-label={`Move ${option.label} up`}
                      disabled={saving || index === 0}
                      onClick={() => reorder(index, index - 1)}
                      className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronUp className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${option.label} down`}
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
                      <span className="text-xs text-muted-foreground">
                        {option.reasoningEffort === "none"
                          ? "Standard generation"
                          : `${option.reasoningEffort === "low" ? "Low" : "Medium"} reasoning`}
                      </span>
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
                  Order updated
                </span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !config.persistenceReady || !orderChanged}
              className="btn-primary px-5 py-2 text-base"
            >
              {saving ? "Saving…" : "Save order"}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
