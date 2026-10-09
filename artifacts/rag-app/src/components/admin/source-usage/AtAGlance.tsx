import { answeredRate, formatPercent } from "@/lib/sourceUsage";
import type { SourceUsageResponse } from "@/types/api";

/** The window's headline numbers. The date filter above shows the window. */
export function AtAGlance({
  totals
}: {
  totals: SourceUsageResponse["totals"];
}): JSX.Element {
  const rate = formatPercent(answeredRate(totals.answered, totals.questions));
  return (
    <section
      aria-labelledby="at-a-glance-title"
      className="rounded-lg border border-border bg-card px-5 py-4 shadow-card"
    >
      <h2 id="at-a-glance-title" className="text-sm font-medium text-muted-foreground">
        At a glance
      </h2>
      <div className="mt-2 grid gap-3 md:grid-cols-2 md:gap-0 md:divide-x md:divide-border">
        <p className="text-lg leading-snug md:pr-6" data-glance="questions">
          Your team asked{" "}
          <span className="text-4xl font-semibold tabular-nums tracking-tight text-primary">
            {totals.questions}
          </span>{" "}
          {totals.questions === 1 ? "question" : "questions"}
        </p>
        <p className="text-lg leading-snug md:pl-6" data-glance="answered">
          <span className="text-4xl font-semibold tabular-nums tracking-tight text-primary">
            {rate}
          </span>{" "}
          got an answer with a source
        </p>
      </div>
    </section>
  );
}
