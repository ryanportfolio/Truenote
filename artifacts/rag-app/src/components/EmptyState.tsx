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
    <div className="rounded-lg border border-dashed border-border bg-muted/30 p-8 text-center">
      <div className="relative mx-auto h-16 w-16">
        <div
          aria-hidden
          className="pointer-events-none absolute -left-3 -top-2 h-20 w-20 rounded-full bg-primary/10 blur-2xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-1 -right-4 h-16 w-16 rounded-full bg-success/15 blur-2xl"
        />
        <div className="relative flex h-16 w-16 items-center justify-center">
          <Icon className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
      </div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      {hint ? (
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{hint}</p>
      ) : null}
      {children ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}
