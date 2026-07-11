import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { getObservability } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  CurrentUser,
  ObservabilityResponse,
  PipelineStageStat,
  PipelineTimingBreakdown
} from "@/types/api";

interface AdminObservabilityPageProps {
  user: CurrentUser;
}

const WINDOWS = [
  { hours: 1, label: "1 hour" },
  { hours: 24, label: "24 hours" },
  { hours: 168, label: "7 days" }
] as const;

const TIMING_DDL =
  "ALTER TABLE query_log ADD COLUMN IF NOT EXISTS timing_breakdown JSONB;";

export function AdminObservabilityPage({
  user
}: AdminObservabilityPageProps): JSX.Element {
  if (user.role !== "super_user") {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Forbidden</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pipeline observability is restricted to super users.
        </p>
      </div>
    );
  }
  return <ObservabilityDashboard />;
}

function ObservabilityDashboard(): JSX.Element {
  const [windowHours, setWindowHours] = useState(24);
  const [data, setData] = useState<ObservabilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async (initial = false): Promise<void> => {
    const generation = ++requestGeneration.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const next = await getObservability(windowHours);
      if (generation === requestGeneration.current) setData(next);
    } catch (reason) {
      if (generation === requestGeneration.current) {
        setError(
          reason instanceof Error ? reason.message : "Failed to load pipeline timing"
        );
      }
    } finally {
      if (generation === requestGeneration.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [windowHours]);

  useEffect(() => {
    void refresh(true);
    const interval = window.setInterval(() => void refresh(false), 30_000);
    return () => {
      requestGeneration.current += 1;
      window.clearInterval(interval);
    };
  }, [refresh]);

  const requestStages = useMemo(
    () => data?.stages.filter((stage) => stage.group === "request") ?? [],
    [data]
  );
  const retrievalStages = useMemo(
    () => data?.stages.filter((stage) => stage.group === "retrieval") ?? [],
    [data]
  );
  const finalizationStages = useMemo(
    () => data?.stages.filter((stage) => stage.group === "finalization") ?? [],
    [data]
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Super-user operations
          </p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
            Pipeline timing
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            End-to-end ask latency across every program, split by retrieval,
            providers, and response finalization. Refreshes every 30 seconds.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-label="Timing window">
          {WINDOWS.map((option) => (
            <button
              key={option.hours}
              type="button"
              aria-pressed={windowHours === option.hours}
              onClick={() => setWindowHours(option.hours)}
              className={cn(
                "btn-whisper px-3 py-1.5 text-xs",
                windowHours === option.hours && "border-primary/40 bg-primary/10 text-primary"
              )}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void refresh(false)}
            disabled={refreshing}
            className="btn-icon rounded-full p-2 disabled:cursor-not-allowed disabled:opacity-50"
            title="Refresh timing data"
          >
            <RefreshCw
              className={cn("h-4 w-4", refreshing && "motion-safe:animate-spin")}
              aria-hidden
            />
            <span className="sr-only">Refresh timing data</span>
          </button>
        </div>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {loading || !data ? (
        <DashboardSkeleton />
      ) : !data.storageReady ? (
        <SetupRequired />
      ) : data.sampleCount === 0 ? (
        <EmptyState
          icon={Activity}
          title="No timed asks yet"
          hint={`New asks will appear here during the selected ${windowLabel(windowHours)} window.`}
        />
      ) : (
        <>
          <SummaryStrip data={data} />

          <section className="rounded-lg border border-border bg-card px-5 py-5 shadow-card">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">Request path</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Non-overlapping stages from request receipt to completed response.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">Solid: p50 · track: p95</p>
            </div>
            <TimingBars stages={requestStages} />
          </section>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
            <StageTable
              title="Retrieval detail"
              description="Nested inside retrieval, including parallel vector and keyword searches."
              stages={retrievalStages}
            />
            <ProviderTable data={data} />
          </div>

          <StageTable
            title="Finalization detail"
            description="Work after the answer is assembled and before the response is returned."
            stages={finalizationStages}
          />

          <RecentRequests data={data} />
        </>
      )}
    </div>
  );
}

function SummaryStrip({ data }: { data: ObservabilityResponse }): JSX.Element {
  const metrics = [
    { label: "Timed asks", value: String(data.sampleCount) },
    { label: "Mean", value: formatDuration(data.summary.meanMs) },
    { label: "p50 total", value: formatDuration(data.summary.p50Ms) },
    { label: "p95 total", value: formatDuration(data.summary.p95Ms) },
    { label: "Refused", value: `${data.summary.refusalRatePct.toFixed(1)}%` }
  ];
  return (
    <div>
      <dl className="grid overflow-hidden rounded-lg border border-border bg-card shadow-card sm:grid-cols-5">
        {metrics.map((metric) => (
          <div
            key={metric.label}
            className="border-b border-border px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"
          >
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              {metric.label}
            </dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{metric.value}</dd>
          </div>
        ))}
      </dl>
      {data.sampleTruncated ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Aggregates use the newest 2,000 asks in this window.
        </p>
      ) : null}
    </div>
  );
}

function TimingBars({ stages }: { stages: PipelineStageStat[] }): JSX.Element {
  const maxP95 = Math.max(1, ...stages.map((stage) => stage.p95Ms));
  return (
    <div className="mt-5 space-y-4">
      {stages.map((stage) => (
        <div key={stage.key} className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_9rem] sm:items-center">
          <p className="text-sm font-medium">{stage.label}</p>
          <div className="relative h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary/20"
              style={{ width: `${Math.max(1, (stage.p95Ms / maxP95) * 100)}%` }}
            />
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${Math.max(1, (stage.p50Ms / maxP95) * 100)}%` }}
            />
          </div>
          <p className="text-right text-xs tabular-nums text-muted-foreground">
            {formatDuration(stage.p50Ms)} · {formatDuration(stage.p95Ms)}
          </p>
        </div>
      ))}
    </div>
  );
}

function StageTable({
  title,
  description,
  stages
}: {
  title: string;
  description: string;
  stages: PipelineStageStat[];
}): JSX.Element {
  return (
    <section>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-card shadow-card">
        <table className="min-w-[32rem] w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Stage</th>
              <th className="px-3 py-2 text-right font-medium">Mean</th>
              <th className="px-3 py-2 text-right font-medium">p50</th>
              <th className="px-3 py-2 text-right font-medium">p95</th>
              <th className="px-3 py-2 text-right font-medium">Samples</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage) => (
              <tr key={stage.key} className="border-t border-border hover:bg-muted/40">
                <td className="px-3 py-2 font-medium">{stage.label}</td>
                <TimingCell value={stage.meanMs} />
                <TimingCell value={stage.p50Ms} />
                <TimingCell value={stage.p95Ms} />
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {stage.samples}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProviderTable({ data }: { data: ObservabilityResponse }): JSX.Element {
  return (
    <section>
      <h2 className="text-xl font-semibold tracking-tight">Generation routes</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Every attempted model route, including failed fallbacks.
      </p>
      <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-card shadow-card">
        {data.providers.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted-foreground">
            No generation calls in this window. Retrieval refusals skip providers.
          </p>
        ) : (
          <table className="min-w-[28rem] w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Route</th>
                <th className="px-3 py-2 text-right font-medium">Success</th>
                <th className="px-3 py-2 text-right font-medium">p50</th>
                <th className="px-3 py-2 text-right font-medium">p95</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((provider) => (
                <tr key={`${provider.routeId}:${provider.model}`} className="border-t border-border hover:bg-muted/40">
                  <td className="px-3 py-2">
                    <span className="block font-medium">{provider.provider}</span>
                    <span className="block max-w-[15rem] truncate font-mono text-xs text-muted-foreground" title={provider.model}>
                      {provider.model}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {provider.successRatePct.toFixed(1)}%
                    <span className="block text-xs text-muted-foreground">{provider.attempts} attempts</span>
                  </td>
                  <TimingCell value={provider.p50Ms} />
                  <TimingCell value={provider.p95Ms} />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function RecentRequests({ data }: { data: ObservabilityResponse }): JSX.Element {
  return (
    <section>
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Recent asks</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Slow-path evidence at request level. Open provider and retrieval tables above for aggregates.
        </p>
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-card shadow-card">
        <table className="min-w-[64rem] w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Ask</th>
              <th className="px-3 py-2 font-medium">Program</th>
              <th className="px-3 py-2 font-medium">Path</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              <th className="px-3 py-2 text-right font-medium">Retrieval</th>
              <th className="px-3 py-2 text-right font-medium">Rerank</th>
              <th className="px-3 py-2 text-right font-medium">Generation</th>
              <th className="px-3 py-2 text-right font-medium">Finalize</th>
            </tr>
          </thead>
          <tbody>
            {data.recent.map((item) => (
              <tr key={item.id} className="border-t border-border align-top hover:bg-muted/40">
                <td className="max-w-sm px-3 py-2">
                  <span className="block truncate font-medium" title={item.question}>{item.question}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {item.createdAt ? <RelativeTime iso={item.createdAt} /> : "Time unavailable"}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{item.programName}</td>
                <td className="px-3 py-2"><PathBadge timing={item.timing} refused={item.refused} /></td>
                <TimingCell value={item.timing.totalMs} emphasized />
                <TimingCell value={stageValue(item.timing, "retrieval")} />
                <TimingCell value={stageValue(item.timing, "rerank")} />
                <TimingCell value={stageValue(item.timing, "generation")} />
                <TimingCell value={stageValue(item.timing, "finalization")} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PathBadge({
  timing,
  refused
}: {
  timing: PipelineTimingBreakdown;
  refused: boolean;
}): JSX.Element {
  const path = timing.context.generationPath;
  const label = refused
    ? "Refused"
    : path === "primary"
      ? "Primary"
      : path === "fallback"
        ? "Fallback"
        : "All routes failed";
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        path === "primary" && !refused
          ? "bg-success/15 text-success"
          : path === "fallback-failed"
            ? "bg-destructive/15 text-destructive"
            : "bg-warning/20 text-warning-foreground"
      )}
    >
      {label}
    </span>
  );
}

function TimingCell({
  value,
  emphasized = false
}: {
  value: number;
  emphasized?: boolean;
}): JSX.Element {
  return (
    <td className={cn("whitespace-nowrap px-3 py-2 text-right tabular-nums", emphasized ? "font-medium" : "text-muted-foreground")}>
      {formatDuration(value)}
    </td>
  );
}

function DashboardSkeleton(): JSX.Element {
  return (
    <div role="status" className="space-y-6">
      <div className="grid overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-5">
        {[0, 1, 2, 3, 4].map((item) => (
          <div key={item} className="border-b border-border px-4 py-3 sm:border-b-0 sm:border-r">
            <div className="skeleton h-3 w-20" />
            <div className="skeleton mt-2 h-6 w-24" />
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="skeleton h-5 w-40" />
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="mt-4 grid grid-cols-[8rem_1fr] gap-4">
            <div className="skeleton h-4" />
            <div className="skeleton h-2 self-center" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading pipeline timing…</span>
    </div>
  );
}

function SetupRequired(): JSX.Element {
  return (
    <section className="rounded-lg border border-warning/40 bg-warning/10 px-5 py-5 text-warning-foreground">
      <h2 className="text-xl font-semibold tracking-tight">Timing storage needs setup</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed">
        Ask delivery remains available, but detailed timing cannot be retained until this
        idempotent DDL is applied through the Replit Agent and the API server restarts.
      </p>
      <pre className="mt-4 overflow-x-auto rounded-md border border-warning/40 bg-card px-3 py-3 font-mono text-xs text-foreground">
        <code>{TIMING_DDL}</code>
      </pre>
    </section>
  );
}

function stageValue(timing: PipelineTimingBreakdown, key: string): number {
  return timing.stages[key] ?? 0;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function windowLabel(hours: number): string {
  return hours === 1 ? "1-hour" : hours === 24 ? "24-hour" : `${hours / 24}-day`;
}
