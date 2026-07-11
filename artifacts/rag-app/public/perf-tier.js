// Apply the stored / auto-detected performance tier before first paint, so
// the CSS kill-switch (html[data-perf-tier="lite"], see index.css) and the
// React store in src/lib/perfTier.ts agree on the very first frame and no
// decorative animation runs a single janky frame on a weak device.
//
// Resolution order:
//   mobile-width viewport -> lite ALWAYS (phones / portrait tablets never
//                            benefit from the ambient extras; overrides a
//                            stored 'full').
//   localStorage 'full'   -> never lite (explicit opt-in, not auto-downgraded).
//   localStorage 'lite'   -> lite.
//   'auto' / absent       -> lite if a prior auto-downgrade latched this
//                            session, or a cheap device heuristic says weak.
//
// This runs render-blocking, so it must only do INSTANT property reads —
// no WebGL context creation, no timers. The real symptom (sustained low
// FPS) is measured after paint by PerfAutoDetect, logged-in surfaces only.
//
// The logged-out auth pages are deliberately exempt from lite styling (the
// kill-switch selectors only target in-app surfaces); the BrandField
// watercolor has its own quality governor + static fallback.
(function () {
  try {
    if (isMobileViewport()) {
      setLite();
      return;
    }
    var pref = localStorage.getItem("truenote-perf-tier");
    if (pref === "full") return;
    if (pref === "lite") {
      setLite();
      return;
    }
    if (
      sessionStorage.getItem("truenote-perf-auto-lite") === "1" ||
      cheapWeakDevice()
    ) {
      setLite();
    }
  } catch (e) {
    // Storage blocked (private mode, etc.) — keep the full experience.
  }

  function setLite() {
    document.documentElement.setAttribute("data-perf-tier", "lite");
  }

  // Kept in sync with MOBILE_LITE_QUERY in src/lib/perfTier.ts. 834px =
  // iPad portrait; a perf-only threshold, deliberately independent of the
  // layout breakpoints.
  function isMobileViewport() {
    try {
      return window.matchMedia("(max-width: 834px)").matches;
    } catch (e) {
      return false;
    }
  }

  // Conservative pre-paint heuristic using only instant reads. Misses weak
  // GPUs in machines with plenty of RAM/cores — those are caught after
  // paint by the FPS sampler. Tuned to avoid false positives.
  function cheapWeakDevice() {
    var mem = navigator.deviceMemory; // GiB; undefined outside Chromium
    var cores = navigator.hardwareConcurrency; // undefined on some browsers
    if (typeof mem === "number" && mem > 0 && mem <= 2) return true;
    if (
      typeof mem === "number" &&
      mem > 0 &&
      mem <= 4 &&
      typeof cores === "number" &&
      cores > 0 &&
      cores <= 4
    ) {
      return true;
    }
    return false;
  }
})();
