/**
 * Quality governor for BrandField (see components/BrandField.tsx).
 *
 * The field is glacially slow by design, so it never needs 60fps —
 * BrandField caps drawing at ~30fps (TARGET_INTERVAL_MS) and, on
 * hardware that still can't hold budget, walks DOWN this tier ladder:
 * render scale first (the field is blur-soft; upscaling is invisible),
 * then one fbm octave (film grain masks the lost fine detail). The
 * floor is "freeze": stop the loop on the last-drawn frame — same
 * composition, no motion, guaranteed smooth page.
 *
 * Tiers only step down, never back up — oscillating quality is worse
 * than settling slightly conservative. Capable hardware never leaves
 * tier 0, so the shipped visual is unchanged where it can run.
 *
 * Pure logic, no DOM/GL — unit-tested in __tests__/fieldQuality.test.ts.
 */

export interface QualityTier {
  /** Canvas render scale (multiplied by capped DPR). */
  scale: number;
  /** fbm octaves the shader runs (u_octaves uniform). */
  octaves: number;
}

/** Tier 0 — full quality, the shipped visual. */
export const DEFAULT_TIER: QualityTier = { scale: 0.6, octaves: 5 };

export const QUALITY_TIERS: readonly QualityTier[] = [
  DEFAULT_TIER,
  { scale: 0.45, octaves: 5 },
  { scale: 0.35, octaves: 4 }
];

/**
 * Minimum ms between drawn frames — ~30fps. Just under two 60Hz vsync
 * periods (33.3ms) so a 60Hz rAF cleanly lands every second tick.
 */
export const TARGET_INTERVAL_MS = 31;

/** Sustained average above this (≈ <25fps drawn) means "step down". */
const SLOW_INTERVAL_MS = 40;

/** Drawn frames per judgment window (~1.5s at the 30fps cap). */
const WINDOW = 45;

/**
 * Deltas above this are tab switches, resumes, or main-thread stalls —
 * not GPU backpressure. They reset the window instead of polluting it.
 */
const IGNORE_ABOVE_MS = 250;

export type GovernorVerdict = "same" | "stepped" | "freeze";

export interface Governor {
  readonly tier: QualityTier;
  /** Feed the delta between two drawn frames; returns what to do. */
  sample(deltaMs: number): GovernorVerdict;
}

export function createGovernor(): Governor {
  let tierIndex = 0;
  let sum = 0;
  let count = 0;

  return {
    get tier(): QualityTier {
      return QUALITY_TIERS[tierIndex] ?? DEFAULT_TIER;
    },
    sample(deltaMs: number): GovernorVerdict {
      if (deltaMs > IGNORE_ABOVE_MS) {
        sum = 0;
        count = 0;
        return "same";
      }
      sum += deltaMs;
      count += 1;
      if (count < WINDOW) return "same";
      const avg = sum / count;
      sum = 0;
      count = 0;
      if (avg <= SLOW_INTERVAL_MS) return "same";
      if (tierIndex < QUALITY_TIERS.length - 1) {
        tierIndex += 1;
        return "stepped";
      }
      return "freeze";
    }
  };
}
