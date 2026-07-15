import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { getSecurityDashboard, updateMalwareScanning } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CurrentUser, SecurityDashboardResponse } from "@/types/api";

interface AdminSecurityPageProps {
  user: CurrentUser;
}

export function AdminSecurityPage({ user }: AdminSecurityPageProps): JSX.Element {
  if (user.role !== "super_user") {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Forbidden</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Security controls are restricted to super users.
        </p>
      </div>
    );
  }
  return <SecurityDashboard />;
}

function SecurityDashboard(): JSX.Element {
  const [data, setData] = useState<SecurityDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (initial = false): Promise<void> => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      setData(await getSecurityDashboard());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Security data could not load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  async function setScanning(enabled: boolean): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      setData(await updateMalwareScanning(enabled));
      setConfirmDisable(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Security setting could not be saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Super-user operations
          </p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">Security</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Review document scan findings and manage temporary malware-scanning enforcement.
          </p>
        </div>
        <button
          type="button"
          className="btn-icon rounded-full p-2 disabled:cursor-not-allowed disabled:opacity-50"
          title="Refresh security data"
          onClick={() => void load(false)}
          disabled={refreshing}
        >
          <RefreshCw
            className={cn("h-4 w-4", refreshing && "motion-safe:animate-spin")}
            aria-hidden
          />
          <span className="sr-only">Refresh security data</span>
        </button>
      </header>

      {error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading ? (
        <SecuritySkeleton />
      ) : data ? (
        <>
          <section className="overflow-hidden rounded-lg border border-border bg-card shadow-card" aria-labelledby="scanner-heading">
            <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 gap-3">
                <span className={cn("mt-0.5 rounded-full p-2", data.malwareScanning.enabled ? "bg-success/15 text-success" : "bg-warning/20 text-warning-foreground") }>
                  {data.malwareScanning.enabled ? <ShieldCheck className="h-5 w-5" aria-hidden /> : <ShieldOff className="h-5 w-5" aria-hidden />}
                </span>
                <div>
                  <h2 id="scanner-heading" className="text-xl font-semibold tracking-tight">
                    External malware scanner
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {data.malwareScanning.enabled
                      ? "Enforcement is on. Uploads require a clean external verdict."
                      : "Temporarily disabled. File signatures, EICAR, content checks, and separate approval remain active. Run scan again from Documents to continue previously quarantined uploads."}
                  </p>
                  <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">Endpoint</dt>
                      <dd className="mt-0.5 font-medium">
                        {data.malwareScanning.scannerConfigured
                          ? data.malwareScanning.scannerTransportSecure
                            ? "Configured"
                            : "HTTPS required"
                          : "Not configured"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">Enforcement</dt>
                      <dd className="mt-0.5 font-medium">{data.malwareScanning.enabled ? "On" : "Off"}</dd>
                    </div>
                    {data.malwareScanning.updatedAt ? (
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Last changed</dt>
                        <dd className="mt-0.5 font-medium">
                          <RelativeTime iso={data.malwareScanning.updatedAt} />
                          {data.malwareScanning.updatedByName ? ` by ${data.malwareScanning.updatedByName}` : ""}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </div>
              </div>
              {data.malwareScanning.enabled ? (
                <button
                  type="button"
                  className="shrink-0 rounded-full border border-destructive/40 px-3 py-2 text-sm text-destructive transition-colors duration-100 ease-out hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => setConfirmDisable(true)}
                  disabled={saving || !data.malwareScanning.persistenceReady || !data.malwareScanning.disabledStatusReady}
                >
                  Disable temporarily
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary shrink-0 px-5 py-2 text-base"
                  onClick={() => void setScanning(true)}
                  disabled={saving || !data.malwareScanning.persistenceReady}
                >
                  {saving ? "Enabling…" : "Enable scanning"}
                </button>
              )}
            </div>

            {data.malwareScanning.enabled && (!data.malwareScanning.scannerConfigured || !data.malwareScanning.scannerTransportSecure) ? (
              <p className="border-t border-border bg-warning/15 px-5 py-3 text-sm text-warning-foreground">
                {data.malwareScanning.scannerConfigured
                  ? "Scanner endpoint must use HTTPS in production. New uploads will be quarantined until the endpoint is corrected or enforcement is disabled."
                  : "Scanner endpoint is not configured. New uploads will be quarantined until enforcement is disabled or an endpoint is added."}
              </p>
            ) : null}

            {!data.malwareScanning.disabledStatusReady ? (
              <p className="border-t border-border bg-warning/15 px-5 py-3 text-sm text-warning-foreground">
                Temporary bypass storage is not installed yet. Apply the provided security DDL before disabling enforcement.
              </p>
            ) : null}

            {confirmDisable ? (
              <div role="alert" className="border-t border-destructive/20 bg-destructive/10 px-5 py-4">
                <div className="flex gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
                  <div>
                    <p className="text-sm font-medium">Disable external malware scanning?</p>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      New uploads can continue without an external verdict. The operating mode remains recorded in document metadata and the security audit log.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" className="btn-whisper px-3 py-1.5 text-sm" onClick={() => setConfirmDisable(false)} disabled={saving}>
                        Keep enabled
                      </button>
                      <button
                        type="button"
                        className="rounded-full border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => void setScanning(false)}
                        disabled={saving}
                      >
                        {saving ? "Disabling…" : "Disable scanning"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <section aria-labelledby="scan-summary-heading">
            <h2 id="scan-summary-heading" className="text-xl font-semibold tracking-tight">Document scan history</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {[
                ["Quarantined", data.summary.quarantined],
                ["Scanner unavailable", data.summary.unavailable],
                ["Scanner errors", data.summary.errors],
                ["Malware detected", data.summary.infected],
                ["External scan skipped", data.summary.disabled]
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-border bg-card p-4 shadow-card">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
                  <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby="findings-heading">
            <h2 id="findings-heading" className="text-xl font-semibold tracking-tight">Recent findings</h2>
            {data.scans.length === 0 ? (
              <div className="mt-3">
                <EmptyState icon={ShieldCheck} title="No scan findings" hint="Document scan issues and temporary bypass records will appear here." />
              </div>
            ) : (
              <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card shadow-card">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Document</th>
                      <th className="hidden px-4 py-3 font-medium md:table-cell">Program</th>
                      <th className="px-4 py-3 font-medium">Finding</th>
                      <th className="hidden px-4 py-3 font-medium sm:table-cell">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.scans.map((scan) => (
                      <tr key={scan.versionId} className="hover:bg-muted/40">
                        <td className="px-4 py-3 align-top">
                          <p className="font-medium">{scan.title}</p>
                          <p className="mt-1 text-xs capitalize text-muted-foreground md:hidden">{scan.programName}</p>
                          <p className="mt-1 text-xs capitalize text-muted-foreground">{scan.lifecycleState.replaceAll("_", " ")} · {scan.scanStatus.replaceAll("_", " ")}</p>
                        </td>
                        <td className="hidden px-4 py-3 align-top md:table-cell">{scan.programName}</td>
                        <td className="px-4 py-3 align-top">
                          {scan.findings.length > 0 ? (
                            <ul className="space-y-1">
                              {scan.findings.map((finding) => <li key={finding.ruleId}>{finding.message}</li>)}
                            </ul>
                          ) : "No detailed finding recorded"}
                        </td>
                        <td className="hidden px-4 py-3 align-top text-muted-foreground sm:table-cell">
                          {scan.occurredAt ? <RelativeTime iso={scan.occurredAt} /> : "Unknown"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {data.controlEvents.length > 0 ? (
            <section aria-labelledby="control-log-heading">
              <h2 id="control-log-heading" className="text-xl font-semibold tracking-tight">Control changes</h2>
              <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card">
                {data.controlEvents.map((event) => (
                  <li key={event.id} className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <span>
                      Malware scanning {event.action.endsWith(".enabled") ? "enabled" : "disabled"}
                      {event.actorEmail ? ` by ${event.actorEmail}` : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {event.occurredAt ? <RelativeTime iso={event.occurredAt} /> : "Unknown time"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SecuritySkeleton(): JSX.Element {
  return (
    <div role="status" className="space-y-6">
      <div className="rounded-lg border border-border bg-card p-5 shadow-card">
        <div className="skeleton h-5 w-52" />
        <div className="skeleton mt-3 h-4 w-full max-w-xl" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => <div key={index} className="skeleton h-24 rounded-lg" />)}
      </div>
      <div className="skeleton h-56 rounded-lg" />
      <span className="sr-only">Loading security data…</span>
    </div>
  );
}
