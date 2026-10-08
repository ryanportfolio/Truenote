import { Grid3x3, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SourceView } from "@/lib/sourceUsage";

const OPTIONS: readonly { view: SourceView; label: string; Icon: typeof Table2 }[] = [
  { view: "table", label: "Table", Icon: Table2 },
  { view: "heatmap", label: "Heatmap", Icon: Grid3x3 }
];

/** Table or people x sources heatmap for the sources section; same recipe as the time window switch. */
export function SourcesViewSwitch({
  view,
  onChange
}: {
  view: SourceView;
  onChange: (view: SourceView) => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Show sources as"
      className="flex overflow-hidden rounded-lg border border-border"
    >
      {OPTIONS.map(({ view: option, label, Icon }) => (
        <button
          key={option}
          type="button"
          aria-pressed={view === option}
          onClick={() => onChange(option)}
          className={cn(
            "relative inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-1 text-xs font-medium transition-colors duration-100 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            view === option
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
