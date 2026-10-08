import { useEffect, useState } from "react";

/** Wide-screen extras (the live preview beside Organize). Tailwind's xl. */
export const KB_WIDE_QUERY = "(min-width: 1280px)";

/** The My labels card beside the list; narrower screens keep labels inside Filters. */
export const KB_LABELS_QUERY = "(min-width: 1280px)";

/**
 * Whether a media query matches, kept in sync with resizes. Used where a
 * screen width changes behavior (a card that moves into a popover, a preview
 * that sits beside or swaps in), not for plain layout, which stays in CSS.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (): void => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
