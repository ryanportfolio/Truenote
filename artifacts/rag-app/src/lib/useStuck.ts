import { useEffect, useState } from "react";

/**
 * Whether a `sticky top-0` element is pinned to the top of the page's scroll
 * area (`main`). Pass `ref` as the element's callback ref; it follows the
 * element as it mounts and unmounts. The scroller is shrunk by 1px at the
 * top, so a pinned element is cut by that pixel and reads as not fully in view.
 */
export function useStuck(): { ref: (el: HTMLElement | null) => void; stuck: boolean } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!el) {
      setStuck(false);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) =>
        setStuck(
          Boolean(entry && entry.intersectionRatio < 1 && entry.boundingClientRect.top <= (entry.rootBounds?.top ?? 0) + 1)
        ),
      { root: el.closest("main"), rootMargin: "-1px 0px 0px 0px", threshold: [1] }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return { ref: setEl, stuck };
}
