import { useEffect, useRef } from "react";

/**
 * Glass tilt for the login card: the card leans a couple of degrees
 * toward the pointer, spring-lerped through rAF, with a `--glint-angle`
 * custom property that the .glass-glint border highlight reads so the
 * specular edge tracks the pointer like light on glass.
 *
 * Constraints that keep it product-register safe:
 *   - max tilt is ~2deg — perceptible as material, never as motion
 *   - prefers-reduced-motion disables the whole effect
 *   - the card flattens whenever focus is inside it (typing on a
 *     leaning surface is annoying) and when the pointer leaves
 *   - transform only (compositor-friendly), no layout properties
 */
export function useGlassTilt<T extends HTMLElement>(maxDeg = 2): React.RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Hoisted function declarations below can't see the null-guard
    // narrowing; alias to a definitely-non-null binding.
    const node: T = el;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;

    let raf = 0;
    let targetX = 0; // rotateX target, deg
    let targetY = 0; // rotateY target, deg
    let curX = 0;
    let curY = 0;
    let curGlint = 210;
    let targetGlint = 210;
    let settled = true;

    function frame(): void {
      curX += (targetX - curX) * 0.08;
      curY += (targetY - curY) * 0.08;
      // Angles wrap; the pointer can't cross the seam fast enough for a
      // shortest-path lerp to matter at 2deg of tilt, so lerp naively.
      curGlint += (targetGlint - curGlint) * 0.08;
      node.style.transform = `perspective(1100px) rotateX(${curX.toFixed(3)}deg) rotateY(${curY.toFixed(3)}deg)`;
      node.style.setProperty("--glint-angle", `${curGlint.toFixed(2)}deg`);
      const done =
        Math.abs(targetX - curX) < 0.002 &&
        Math.abs(targetY - curY) < 0.002 &&
        Math.abs(targetGlint - curGlint) < 0.05;
      if (done) {
        settled = true;
        return;
      }
      raf = requestAnimationFrame(frame);
    }

    function wake(): void {
      if (!settled) return;
      settled = false;
      raf = requestAnimationFrame(frame);
    }

    function onPointerMove(e: PointerEvent): void {
      if (node.matches(":focus-within")) {
        targetX = 0;
        targetY = 0;
        wake();
        return;
      }
      const rect = node.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Normalized offset, clamped so far-away pointers don't over-lean.
      const nx = Math.max(-1, Math.min(1, (e.clientX - cx) / (rect.width * 1.2)));
      const ny = Math.max(-1, Math.min(1, (e.clientY - cy) / (rect.height * 1.2)));
      targetY = nx * maxDeg;
      targetX = -ny * maxDeg;
      // Glint angle: conic-gradient 0deg points up; aim the highlight at
      // the pointer's bearing from the card center.
      targetGlint = (Math.atan2(e.clientX - cx, -(e.clientY - cy)) * 180) / Math.PI;
      wake();
    }

    function flatten(): void {
      targetX = 0;
      targetY = 0;
      wake();
    }

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", flatten);
    node.addEventListener("focusin", flatten);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", flatten);
      node.removeEventListener("focusin", flatten);
      node.style.transform = "";
      node.style.removeProperty("--glint-angle");
    };
  }, [maxDeg]);

  return ref;
}
