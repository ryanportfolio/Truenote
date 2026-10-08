import { useId } from "react";
import { CalendarDays } from "lucide-react";
import { USAGE_WINDOW_OPTIONS, windowLabel } from "@/lib/sourceUsage";

/** Time period dropdown: a native select, so keyboard and screen readers get the platform behavior. */
export function TimeSelect({
  days,
  onChange
}: {
  days: number;
  onChange: (days: number) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        Time period
      </label>
      <CalendarDays
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <select
        id={id}
        value={days}
        onChange={(event) => onChange(Number(event.target.value))}
        className="select-quiet rounded-full border border-border bg-secondary py-1.5 pl-9 text-sm font-medium transition-colors duration-100 ease-out hover:border-foreground/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {USAGE_WINDOW_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {windowLabel(option)}
          </option>
        ))}
      </select>
    </div>
  );
}
