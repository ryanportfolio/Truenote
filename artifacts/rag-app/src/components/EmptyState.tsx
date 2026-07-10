import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint?: ReactNode;
  /** Optional actions rendered under the hint (links, prefill chips). */
  children?: ReactNode;
}

/**
 * Small-scale Luminous Archive: layered evidence sheets orbit a muted icon.
 * The sheets inherit the merged watercolor pass's ultra-slow, reduced-motion-
 * safe drift. Empty surfaces are pressure-free enough to carry this ambient
 * brand moment; callers still own all copy and actions.
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  children
}: EmptyStateProps): JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-state-object">
        <span
          className="empty-state-sheet empty-state-sheet-back motion-safe:animate-blob-drift-a"
          aria-hidden
        />
        <span
          className="empty-state-sheet empty-state-sheet-mid motion-safe:animate-blob-drift-b"
          aria-hidden
        />
        <div className="empty-state-core">
          <Icon className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
      </div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      {hint ? (
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{hint}</p>
      ) : null}
      {children ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}
