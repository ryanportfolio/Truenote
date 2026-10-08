import { useEffect, useState } from "react";

/** Wide-screen extras (category rail, CSR preview beside the editor). Tailwind's xl. */
export const KB_WIDE_QUERY = "(min-width: 1280px)";
/** Room for the quick-look pane beside the List view. */
export const KB_QUICK_LOOK_QUERY = "(min-width: 1440px)";

/**
 * Whether a media query matches, kept in sync with resizes. Used where a
 * screen width changes behavior (a rail that scopes the list, a pane that
 * opens on demand), not for plain layout, which stays in CSS.
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
