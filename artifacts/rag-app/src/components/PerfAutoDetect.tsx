import { useEffect } from "react";
import { triggerAutoDowngrade, usePerfTier } from "@/lib/perfTier";

// FPS sampler tuning (same numbers proven in Extract-Video-Wisdom).
const WINDOW_MS = 1000; // measurement window
const LOW_FPS = 35; // a window below this counts as janky
const NEEDED_STREAK = 3; // consecutive janky windows before downgrading
const MAX_WINDOWS = 20; // stop sampling after this many healthy windows (~20s)
const WARMUP_MS = 1500; // ignore initial mount/hydration jank

/**
 * Runtime auto-detection for the "auto" performance tier. Renders nothing.
 *
 * Mounted inside AppShell ONLY — logged-in surfaces are where lite mode
 * matters; the logged-out auth pages keep their full brand moment (the
 * BrandField watercolor already has its own adaptive quality governor).
 *
 * Measures the real symptom: sustained low frame rate. Three consecutive
 * 1s windows under 35fps latch the session to lite (one-way; see
 * perfTier.ts). Windows where the tab was hidden are discarded — rAF is
 * throttled to ~1fps there and would read as fake jank. After ~20 healthy
 * windows the sampler retires: the device has proven itself and a
 * permanent rAF loop would itself be a (tiny) perf tax.
 */
export function PerfAutoDetect(): null {
  const { tier, isLite } = usePerfTier();
  const active = tier === "auto" && !isLite;

  useEffect(() => {
    if (!active) return;

    let raf = 0;
    let frames = 0;
    let badStreak = 0;
    let healthyWindows = 0;
    let windowStart = performance.now();
    const startTs = windowStart;
    let hiddenDuringWindow = document.hidden;

    const onVisibility = (): void => {
      if (document.hidden) hiddenDuringWindow = true;
    };
    document.addEventListener("visibilitychange", onVisibility);

    const cleanup = (): void => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };

    const loop = (now: number): void => {
      frames++;
      if (now - windowStart >= WINDOW_MS) {
        const fps = (frames * 1000) / (now - windowStart);
        const inWarmup = now - startTs < WARMUP_MS;
        if (!hiddenDuringWindow && !inWarmup) {
          if (fps < LOW_FPS) {
            badStreak++;
            if (badStreak >= NEEDED_STREAK) {
              triggerAutoDowngrade();
              cleanup();
              return;
            }
          } else {
            badStreak = 0;
            healthyWindows++;
            if (healthyWindows >= MAX_WINDOWS) {
              cleanup();
              return;
            }
          }
        }
        frames = 0;
        windowStart = now;
        hiddenDuringWindow = document.hidden;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return cleanup;
  }, [active]);

  return null;
}
