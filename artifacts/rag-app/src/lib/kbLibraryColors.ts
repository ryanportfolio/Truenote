import type { CSSProperties } from "react";
import type { KbLibraryColor } from "@/types/api";

/**
 * Colors for source categories and tags (team colors a manager chooses) and
 * for each user's private source and category labels. Same approach as
 * programSwatchColor: one hue per named color at a fixed, quiet lightness and
 * chroma, so no choice can shout louder than another. Decorative only; the
 * category or tag NAME always carries the meaning, and chip text stays in
 * --foreground ink so contrast never depends on the choice.
 */

const HUES: Record<KbLibraryColor, { hue: number; chroma: number; label: string }> = {
  slate: { hue: 250, chroma: 0.015, label: "Slate" },
  blue: { hue: 255, chroma: 0.09, label: "Blue" },
  green: { hue: 160, chroma: 0.08, label: "Green" },
  amber: { hue: 80, chroma: 0.1, label: "Amber" },
  red: { hue: 25, chroma: 0.1, label: "Red" },
  violet: { hue: 300, chroma: 0.09, label: "Violet" },
  teal: { hue: 195, chroma: 0.07, label: "Teal" },
  pink: { hue: 350, chroma: 0.09, label: "Pink" }
};

export const KB_LIBRARY_COLORS: readonly KbLibraryColor[] = [
  "slate",
  "blue",
  "green",
  "amber",
  "red",
  "violet",
  "teal",
  "pink"
];

export function kbColorLabel(color: KbLibraryColor): string {
  return HUES[color]?.label ?? "Slate";
}

/** Solid swatch for category dots, row stripes and color pickers. */
export function kbColorDot(color: KbLibraryColor): CSSProperties {
  const { hue, chroma } = HUES[color] ?? HUES.slate;
  return { backgroundColor: `oklch(68% ${chroma} ${hue})` };
}

/** Pale tint plus hairline for tag chips. Text stays in the inherited ink. */
export function kbColorChip(color: KbLibraryColor): CSSProperties {
  const { hue, chroma } = HUES[color] ?? HUES.slate;
  return {
    backgroundColor: `oklch(94% ${Math.min(chroma, 0.04)} ${hue})`,
    borderColor: `oklch(82% ${Math.min(chroma, 0.07)} ${hue})`
  };
}

/**
 * Color a category shows to this user: their private override when set,
 * otherwise the team color a manager chose.
 */
export function kbEffectiveCategoryColor(category: {
  color: KbLibraryColor;
  myColor: KbLibraryColor | null;
}): KbLibraryColor {
  return category.myColor ?? category.color;
}

export function isKbLibraryColor(value: unknown): value is KbLibraryColor {
  return typeof value === "string" && value in HUES;
}
