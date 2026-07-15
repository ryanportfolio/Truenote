import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, RefreshCw, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { clearErrorLog, listErrors } from "@/lib/api";
import {
  errorDiagnostic,
  serializeErrorBundle,
  serializeErrorDiagnostic
} from "@/lib/errorDiagnostics";
import { cn } from "@/lib/utils";
import type {
  CurrentUser,
  ErrorLogItem,
  ErrorLogResponse,
  ErrorLogSeverity
} from "@/types/api";

interface AdminErrorsPageProps {
  user: CurrentUser;
}

const WINDOWS = [
  { hours: 1, label: "1 hour" },
  { hours: 24, label: "24 hours" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" }
] as const;

const ERROR_LOG_DDL = `CREATE TABLE IF NOT EXISTS error_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity TEXT NOT NULL CHECK (severity IN ('warning','error','fatal')),
  source TEXT NOT NULL,
  operation TEXT NOT NULL,
  message TEXT NOT NULL,
  name TEXT,
  stack TEXT,
  code TEXT,
  status INT,
  provider TEXT,
  model TEXT,
  route_id TEXT,
  request_id TEXT,
  correlation_id TEXT,
  method TEXT,
  path TEXT,
  user_id TEXT,
  program_id UUID,
  query_log_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS error_log_occurred_idx ON error_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS error_log_source_occurred_idx ON error_log (source, occurred_at DESC);`;

export function AdminErrorsPage({ user }: AdminErrorsPageProps): JSX.Element {
  if (user.role !== "super_user") {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Forbidden</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Error diagnostics are restricted to super users.
        </p>
      </div>
    );
  }
  return <ErrorsDashboard />;
}

function ErrorsDashboard(): JSX.Element {
  const [hours, setHours] = useState(24);
  const [severity, setSeverity] = useState<ErrorLogSeverity | "all">("all");
  const [source, setSource] = useState("");
  const [data, setData] = useState<ErrorLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [copyingAll, setCopyingAll] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearedCount, setClearedCount] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const load = useCallback(async (initial = false): Promise<void> => {
    const generation = ++generationRef.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const next = await listErrors({
        hours,
        severity,
        ...(source ? { source } : {})
      });
      if (generation === generationRef.current) setData(next);
    } catch (reason) {
      if (generation === generationRef.current) {
        setError(reason instanceof Error ? reason.message : "Failed to load errors");
      }
    } finally {
      if (generation === generationRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [hours, severity, source]);

  useEffect(() => {
    void load(true);
    const interval = window.setInterval(() => void load(false), 30_000);
    return () => {
      generationRef.current += 1;
      window.clearInterval(interval);
    };
  }, [load]);

  async function loadMore(): Promise<void> {
    if (!data || !data.hasMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await listErrors({
        hours,
        severity,
        source: source || undefined,
        offset: data.items.length
      });
      setData({ ...next, items: [...data.items, ...next.items] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to load more errors");
    } finally {
      setLoadingMore(false);
    }
  }

  async function copyOne(item: ErrorLogItem): Promise<void> {
    await writeClipboard(serializeErrorDiagnostic(item));
    setCopiedId(item.id);
    window.setTimeout(() => setCopiedId((current) => current === item.id ? null : current), 1_500);
  }

  async function copyAll(): Promise<void> {
    if (!data || data.total === 0) return;
    setCopyingAll(true);
    setError(null);
    try {
      const items: ErrorLogItem[] = [];
      let offset = 0;
      while (true) {
        const page = await listErrors({
          hours,
          severity,
          source: source || undefined,
          limit: 250,
          offset
        });
        items.push(...page.items);
        if (!page.hasMore || page.items.length === 0) break;
        offset += page.items.length;
      }
      await writeClipboard(
        serializeErrorBundle(items, {
          hours,
          severity,
          ...(source ? { source } : {})
        })
      );
      setCopiedId("all");
      window.setTimeout(() => setCopiedId((current) => current === "all" ? null : current), 1_500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to copy errors");
    } finally {
      setCopyingAll(false);
    }
  }

  async function clearAll(): Promise<void> {
    setClearing(true);
    setError(null);
    setClearedCount(null);
    try {
      const result = await clearErrorLog();
      setClearedCount(result.deletedCount);
      setConfirmClear(false);
      await load(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to clear errors");
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Super-user operations
          </p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">Errors</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Redacted production diagnostics from providers, API requests, ingestion,
            evaluations, maintenance, and process-level failures.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition-colors duration-100 ease-out hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => setConfirmClear(true)}
            disabled={!data?.storageReady || !data.total || clearing}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Clear log
          </button>
          <button
            type="button"
            className="btn-whisper gap-1.5 px-3 py-1.5 text-xs"
            onClick={() => void copyAll()}
            disabled={!data?.storageReady || !data.total || copyingAll}
          >
            {copiedId === "all" ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            {copyingAll ? "Collecting…" : copiedId === "all" ? "Copied all" : "Copy all"}
          </button>
          <button
            type="button"
            className="btn-icon rounded-full p-2 disabled:cursor-not-allowed disabled:opacity-50"
            title="Refresh errors"
            onClick={() => void load(false)}
            disabled={refreshing}
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "motion-safe:animate-spin")} aria-hidden />
            <span className="sr-only">Refresh errors</span>
          </button>
        </div>
      </header>

      {confirmClear ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
            <div>
              <p className="text-sm font-medium">Clear the entire error log?</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                This removes all stored error diagnostics, not only the current filtered view. The action and deleted count remain in the append-only security audit log.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="btn-whisper px-3 py-1.5 text-sm" onClick={() => setConfirmClear(false)} disabled={clearing}>
                  Keep log
                </button>
                <button
                  type="button"
                  className="rounded-full border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void clearAll()}
                  disabled={clearing}
                >
                  {clearing ? "Clearing…" : "Clear all errors"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {clearedCount !== null ? (
        <p role="status" className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          Cleared {clearedCount} error{clearedCount === 1 ? "" : "s"}.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2" aria-label="Error filters">
        {WINDOWS.map((option) => (
          <button
            key={option.hours}
            type="button"
            aria-pressed={hours === option.hours}
            onClick={() => setHours(option.hours)}
            className={cn(
              "btn-whisper px-3 py-1.5 text-xs",
              hours === option.hours && "border-primary/40 bg-primary/10 text-primary"
            )}
          >
            {option.label}
          </button>
        ))}
        <label className="sr-only" htmlFor="error-severity">Severity</label>
        <select
          id="error-severity"
          className="select-quiet rounded-full border border-border bg-secondary px-3 py-1.5 pr-8 text-xs"
          value={severity}
          onChange={(event) => setSeverity(event.target.value as ErrorLogSeverity | "all")}
        >
          <option value="all">All severities</option>
          <option value="warning">Warnings</option>
          <option value="error">Errors</option>
          <option value="fatal">Fatal</option>
        </select>
        <label className="sr-only" htmlFor="error-source">Source</label>
        <select
          id="error-source"
          className="select-quiet rounded-full border border-border bg-secondary px-3 py-1.5 pr-8 text-xs"
          value={source}
          onChange={(event) => setSource(event.target.value)}
        >
          <option value="">All sources</option>
          {(data?.sources ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading || !data ? (
        <ErrorsSkeleton />
      ) : !data.storageReady ? (
        <SetupRequired />
      ) : data.total === 0 ? (
        <EmptyState
          icon={AlertTriangle}
          title="No matching errors"
          hint="No durable errors were captured for these filters. New failures appear automatically."
        />
      ) : (
        <>
          <ErrorSummary data={data} />
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card">
            {data.items.map((item) => (
              <li key={item.id} className="px-4 py-4 hover:bg-muted/25">
                <article>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <SeverityBadge severity={item.severity} />
                        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {item.source} · {item.operation}
                        </span>
                      </div>
                      <p className="mt-2 break-words text-sm font-medium leading-relaxed">{item.message}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        <RelativeTime iso={item.occurredAt} />
                        {item.provider ? ` · ${item.provider}` : ""}
                        {item.model ? ` · ${item.model}` : ""}
                        {item.status !== null ? ` · HTTP ${item.status}` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn-whisper shrink-0 gap-1.5 px-3 py-1.5 text-xs"
                      onClick={() => void copyOne(item)}
                    >
                      {copiedId === item.id ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                      {copiedId === item.id ? "Copied" : "Copy diagnostic"}
                    </button>
                  </div>
                  <details className="mt-3">
                    <summary className="w-fit cursor-pointer rounded text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      Show full diagnostic
                    </summary>
                    <pre className="mt-3 max-h-[34rem] overflow-auto rounded-md border border-border bg-muted/40 px-3 py-3 font-mono text-xs leading-relaxed text-foreground">
                      <code>{JSON.stringify(errorDiagnostic(item), null, 2)}</code>
                    </pre>
                  </details>
                </article>
              </li>
            ))}
          </ul>
          {data.hasMore ? (
            <button
              type="button"
              className="btn-whisper self-center px-4 py-1.5 text-sm"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function ErrorSummary({ data }: { data: ErrorLogResponse }): JSX.Element {
  const metrics = [
    { label: "Matching", value: data.total },
    { label: "Warnings", value: data.counts.warning },
    { label: "Errors", value: data.counts.error },
    { label: "Fatal", value: data.counts.fatal }
  ];
  return (
    <dl className="grid overflow-hidden rounded-lg border border-border bg-card shadow-card sm:grid-cols-4">
      {metrics.map((metric) => (
        <div key={metric.label} className="border-b border-border px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">{metric.label}</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums">{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SeverityBadge({ severity }: { severity: ErrorLogSeverity }): JSX.Element {
  return (
    <span className={cn(
      "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
      severity === "fatal"
        ? "bg-destructive text-card"
        : severity === "error"
          ? "bg-destructive/15 text-destructive"
          : "bg-warning/20 text-warning-foreground"
    )}>
      {severity}
    </span>
  );
}

function ErrorsSkeleton(): JSX.Element {
  return (
    <div role="status" className="space-y-3">
      {[0, 1, 2].map((item) => (
        <div key={item} className="rounded-lg border border-border bg-card px-4 py-4">
          <div className="skeleton h-3 w-36" />
          <div className="skeleton mt-3 h-4 w-3/4" />
          <div className="skeleton mt-2 h-3 w-52" />
        </div>
      ))}
      <span className="sr-only">Loading errors…</span>
    </div>
  );
}

function SetupRequired(): JSX.Element {
  return (
    <section className="rounded-lg border border-warning/40 bg-warning/10 px-5 py-5 text-warning-foreground">
      <h2 className="text-xl font-semibold tracking-tight">Error storage needs setup</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed">
        Runtime behavior is unchanged, but diagnostics cannot be retained until this
        idempotent DDL is applied through the Replit Agent and both API and worker restart.
      </p>
      <pre className="mt-4 max-h-[28rem] overflow-auto rounded-md border border-warning/40 bg-card px-3 py-3 font-mono text-xs text-foreground">
        <code>{ERROR_LOG_DDL}</code>
      </pre>
    </section>
  );
}

async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable");
}
