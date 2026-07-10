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
 * Teaching empty state in the login-blob illustration language at small
 * scale (DESIGN.md §Brand moments): two aria-hidden tint washes behind a
 * muted icon. Empty surfaces are the one place decoration stays calm —
 * nothing else on screen competes for attention. Pure presentation;
 * callers own all copy and actions.
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
        <span className="empty-state-sheet empty-state-sheet-back" aria-hidden />
        <span className="empty-state-sheet empty-state-sheet-mid" aria-hidden />
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
