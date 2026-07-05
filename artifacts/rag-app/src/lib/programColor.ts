/**
 * Deterministic identity swatch per program: hash the id to a hue, render
 * a fixed-lightness pastel. Decorative only (aria-hidden dots) — the
 * program NAME always carries the information; the dot just makes "which
 * scope am I in" scannable for super_users hopping between programs.
 * Fixed L/C keeps every swatch equally quiet on the cream/chrome surfaces.
 */
export function programSwatchColor(programId: string): string {
  let hash = 0;
  for (let i = 0; i < programId.length; i += 1) {
    hash = (hash * 31 + programId.charCodeAt(i)) >>> 0;
  }
  return `oklch(75% 0.06 ${hash % 360})`;
}
