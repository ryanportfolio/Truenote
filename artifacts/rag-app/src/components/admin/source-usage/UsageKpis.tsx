import type { ReactNode } from "react";
import { answeredRate, formatPercent } from "@/lib/sourceUsage";
import type { SourceUsageResponse } from "@/types/api";

interface UsageKpisProps {
  totals: SourceUsageResponse["totals"];
  days: number;
  /** Moves focus to the Never cited card; absent when there is nothing to show. */
  onShowNeverCited?: () => void;
}

/** Headline numbers for everyone in the window, each with a one-line plain meaning. */
export function UsageKpis({ totals, days, onShowNeverCited }: UsageKpisProps): JSX.Element {
  const rate = answeredRate(totals.answered, totals.questions);
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Kpi label="Questions" value={totals.questions}>
        Asked in the last {days} days.
      </Kpi>
      <Kpi label="Answered" value={formatPercent(rate)}>
        {totals.answered} of {totals.questions} questions got a cited answer.
      </Kpi>
      <Kpi label="Sources cited" value={totals.sourcesCited}>
        Different sources used in answers.
      </Kpi>
      <Kpi label="Never cited" value={totals.sourcesNeverCited}>
        <span className="block">Live sources no answer used in the last {days} days.</span>
        {totals.sourcesNeverCited > 0 && onShowNeverCited ? (
          <button
            type="button"
            onClick={onShowNeverCited}
            className="mt-1 rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            See the list
          </button>
        ) : null}
      </Kpi>
      <Kpi label="Active people" value={totals.activeUsers}>
        Asked at least one question.
      </Kpi>
    </dl>
  );
}

export function Kpi({
  label,
  value,
  children
}: {
  label: string;
  value: number | string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 shadow-card">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</dd>
      <dd className="mt-1 text-xs text-muted-foreground">{children}</dd>
    </div>
  );
}
