import type { ReactNode } from "react";
import { answeredRate, formatPercent, plural } from "@/lib/sourceUsage";
import type { SourceUsageResponse } from "@/types/api";

interface UsageKpisProps {
  totals: SourceUsageResponse["totals"];
  days: number;
  /** True when the page is filtered to one person. */
  personMode: boolean;
  neverCitedOpen: boolean;
  neverCitedPanelId: string;
  onToggleNeverCited: () => void;
}

/** Headline numbers for the window, each with a one-line plain meaning. */
export function UsageKpis({
  totals,
  days,
  personMode,
  neverCitedOpen,
  neverCitedPanelId,
  onToggleNeverCited
}: UsageKpisProps): JSX.Element {
  const rate = answeredRate(totals.answered, totals.questions);
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Kpi label="Questions" value={totals.questions}>
        Asked in the last {days} days.
      </Kpi>
      <Kpi label="Answered" value={formatPercent(rate)}>
        {totals.answered} of {totals.questions} got a cited answer.
      </Kpi>
      <Kpi label="Sources cited" value={totals.sourcesCited}>
        Different sources used in answers.
      </Kpi>
      <Kpi label="Never cited" value={totals.sourcesNeverCited}>
        <span className="block">
          {personMode ? "Live sources none of these answers used." : "Live sources no answer used."}
        </span>
        {totals.sourcesNeverCited > 0 ? (
          <button
            type="button"
            aria-expanded={neverCitedOpen}
            aria-controls={neverCitedPanelId}
            onClick={onToggleNeverCited}
            className="mt-1 rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {neverCitedOpen ? "Hide the list" : "Show the list"}
          </button>
        ) : null}
      </Kpi>
      {personMode ? (
        <Kpi label="Refused" value={totals.refused}>
          {plural(totals.refused, "question", "questions")} the sources could not answer.
        </Kpi>
      ) : (
        <Kpi label="Active people" value={totals.activeUsers}>
          Asked at least one question.
        </Kpi>
      )}
    </dl>
  );
}

function Kpi({
  label,
  value,
  children
}: {
  label: string;
  value: number | string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-card">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
      <dd className="mt-0.5 text-xs text-muted-foreground">{children}</dd>
    </div>
  );
}
