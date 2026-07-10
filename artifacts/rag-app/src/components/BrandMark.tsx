import { cn } from "@/lib/utils";

interface BrandMarkProps {
  className?: string;
  inverted?: boolean;
}

/**
 * A dimensional, code-native counterpart to the generated Luminous Archive
 * artwork. The offset sheets read as gathered evidence, while the blue core
 * remains the single trustworthy answer. Purely decorative wherever used.
 */
export function BrandMark({ className, inverted = false }: BrandMarkProps): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn("brand-mark", inverted && "brand-mark-inverted", className)}
    >
      <span className="brand-mark-sheet brand-mark-sheet-back" />
      <span className="brand-mark-sheet brand-mark-sheet-mid" />
      <span className="brand-mark-core">T</span>
    </span>
  );
}
