import { useEffect, useState, type FormEvent } from "react";
import { Check, Cpu } from "lucide-react";
import { getModelRouting, updateModelRouting } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CurrentUser, ModelRoutingConfig } from "@/types/api";

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

function ModelRoutingPanel(): JSX.Element {
  const [config, setConfig] = useState<ModelRoutingConfig | null>(null);
  const [selectedId, setSelectedId] = useState("");
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
        setSelectedId(next.selectedId);
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

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!config || selectedId === config.selectedId) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await updateModelRouting(selectedId);
      setConfig(next);
      setSelectedId(next.selectedId);
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
          Choose the approved route used for new knowledge-base answers.
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
        <form onSubmit={(event) => void save(event)} className="flex flex-col gap-4">
          {!config.persistenceReady ? (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
              Storage setup required. The default route is active, but changes cannot
              be saved until the Replit DDL is applied.
            </p>
          ) : null}

          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Approved primary model routes</legend>
            {config.options.map((option) => {
              const selected = selectedId === option.id;
              return (
                <label
                  key={option.id}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-lg border bg-card px-4 py-4 shadow-card transition-colors duration-100 ease-out",
                    selected
                      ? "border-primary/50 bg-primary/5"
                      : "border-border hover:border-foreground/20"
                  )}
                >
                  <input
                    type="radio"
                    name="model-route"
                    value={option.id}
                    checked={selected}
                    onChange={() => {
                      setSelectedId(option.id);
                      setSaved(false);
                    }}
                    disabled={saving}
                    className="mt-1 h-4 w-4 shrink-0 accent-primary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{option.label}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {option.providerLabel}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {option.reasoningEffort === "low" ? "Low" : "Medium"} reasoning
                      </span>
                    </span>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      {option.description}
                    </span>
                    <code className="mt-2 block break-all text-xs text-muted-foreground">
                      {option.model}
                    </code>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-h-5 text-sm text-success" role="status">
              {saved ? (
                <span className="inline-flex items-center gap-1.5">
                  <Check className="h-4 w-4" aria-hidden />
                  Routing updated
                </span>
              ) : null}
            </div>
            <button
              type="submit"
              disabled={
                saving ||
                !config.persistenceReady ||
                selectedId === config.selectedId
              }
              className="btn-primary px-5 py-2 text-base"
            >
              {saving ? "Saving…" : "Save route"}
            </button>
          </div>
        </form>
      )}

      {config ? (
        <section className="rounded-lg border border-border bg-card px-4 py-4 shadow-card">
          <div className="flex items-start gap-3">
            <span className="rounded-full bg-muted p-2 text-muted-foreground">
              <Cpu className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h2 className="text-sm font-medium">Automatic backup</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Any primary request or citation-contract failure retries with{" "}
                {config.fallback.label} on {config.fallback.providerLabel} at low
                reasoning.
              </p>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

