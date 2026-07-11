import { useSyncExternalStore } from "react";

/**
 * Site-wide performance tier, mirrored from the pattern proven in
 * Extract-Video-Wisdom (usePerformanceTier + perf-tier.js there).
 *
 *   "auto" — default. A pre-paint boot script (public/perf-tier.js) applies
 *            a cheap device heuristic; after paint, PerfAutoDetect samples
 *            real FPS on logged-in surfaces and can latch auto -> lite.
 *            One-way: auto never upgrades itself back mid-session (that
 *            would thrash the very animations that caused the jank).
 *   "full" — explicit opt-in, never auto-downgraded.
 *   "lite" — reduced experience: the CSS kill-switch
 *            (html[data-perf-tier="lite"], index.css) drops the app-main
 *            gradient/dot-grid paint work and freezes ambient animations.
 *
 * The logged-out auth pages keep their full brand moment regardless of
 * tier — the kill-switch selectors only target in-app surfaces, and the
 * BrandField watercolor has its own quality governor + static fallback.
 *
 * Module-level store + useSyncExternalStore instead of a Context provider:
 * the app is small, every consumer wants the same global value, and the
 * pre-paint boot script already owns first-frame correctness.
 */
export type PerfTier = "auto" | "full" | "lite";

export interface PerfSnapshot {
  tier: PerfTier;
  /** Whether the reduced experience is active right now. */
  isLite: boolean;
}

const TIER_KEY = "truenote-perf-tier";
// Session-scoped latch: once auto-detection downgrades this tab to lite,
// remember it so a same-session reload doesn't re-jank before re-detecting.
// sessionStorage on purpose — a transient bad sample never locks the device
// into lite permanently.
const AUTO_LITE_KEY = "truenote-perf-auto-lite";
// Kept in sync with public/perf-tier.js. Perf-only threshold (834px = iPad
// portrait), deliberately independent of the layout breakpoints.
const MOBILE_LITE_QUERY = "(max-width: 834px)";

/**
 * Pure tier resolution — exported for tests. Mobile pins lite even over an
 * explicit "full" (ambient extras are never worth the battery there);
 * "full" otherwise beats the auto latch.
 */
export function resolveIsLite(
  tier: PerfTier,
  autoLite: boolean,
  isMobile: boolean
): boolean {
  if (isMobile) return true;
  if (tier === "lite") return true;
  if (tier === "full") return false;
  return autoLite;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

let tier: PerfTier = "auto";
let autoLite = false;
let isMobile = false;
let initialized = false;
let snapshot: PerfSnapshot = { tier: "auto", isLite: false };
const listeners = new Set<() => void>();

function readStoredTier(): PerfTier {
  try {
    const stored = localStorage.getItem(TIER_KEY);
    if (stored === "auto" || stored === "full" || stored === "lite") {
      return stored;
    }
  } catch {
    // storage blocked — default
  }
  return "auto";
}

function readAutoLatch(): boolean {
  try {
    if (sessionStorage.getItem(AUTO_LITE_KEY) === "1") return true;
  } catch {
    // ignore
  }
  // The boot script may have latched lite from its cheap device heuristic
  // before this module loaded — adopt its verdict. (Under a stored "lite"
  // tier the attribute is also set, but autoLite is only consulted when
  // tier === "auto", so the over-read is harmless.)
  return document.documentElement.getAttribute("data-perf-tier") === "lite";
}

function recompute(): void {
  const isLite = resolveIsLite(tier, autoLite, isMobile);
  if (snapshot.tier !== tier || snapshot.isLite !== isLite) {
    snapshot = { tier, isLite };
  }
  if (isBrowser()) {
    const root = document.documentElement;
    if (isLite) {
      root.setAttribute("data-perf-tier", "lite");
    } else {
      root.removeAttribute("data-perf-tier");
    }
  }
  listeners.forEach((l) => l());
}

function init(): void {
  if (initialized || !isBrowser()) return;
  initialized = true;
  tier = readStoredTier();
  autoLite = readAutoLatch();
  try {
    const mql = window.matchMedia(MOBILE_LITE_QUERY);
    isMobile = mql.matches;
    mql.addEventListener("change", () => {
      isMobile = mql.matches;
      recompute();
    });
  } catch {
    // matchMedia unavailable — treat as desktop.
  }
  recompute();
}

export function getPerfSnapshot(): PerfSnapshot {
  init();
  return snapshot;
}

export function setPerfTier(next: PerfTier): void {
  init();
  tier = next;
  try {
    localStorage.setItem(TIER_KEY, next);
  } catch {
    // storage blocked — in-memory only
  }
  recompute();
}

/**
 * Latch auto -> lite (called by the runtime FPS sampler). No-op once
 * latched; resolveIsLite ignores it unless the tier is "auto".
 */
export function triggerAutoDowngrade(): void {
  init();
  if (autoLite) return;
  autoLite = true;
  try {
    sessionStorage.setItem(AUTO_LITE_KEY, "1");
  } catch {
    // storage blocked — in-memory latch still holds for this tab
  }
  recompute();
}

function subscribe(listener: () => void): () => void {
  init();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePerfTier(): PerfSnapshot {
  return useSyncExternalStore(subscribe, getPerfSnapshot, getPerfSnapshot);
}
