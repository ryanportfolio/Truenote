import { useEffect, useState } from "react";

const TYPE_MS = 40;
const ERASE_MS = 18;
const HOLD_MS = 2_200;
const GAP_MS = 400;

/**
 * Types each line out, holds it, erases it, then moves to the next, in a loop.
 * While `paused` it shows the current line in full and stops. With reduced
 * motion it shows the first line and never changes.
 */
export function useTypewriter(lines: readonly string[], paused: boolean): string {
  const [lineIndex, setLineIndex] = useState(0);
  const [shown, setShown] = useState(0);
  const [erasing, setErasing] = useState(false);
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const line = lines.length > 0 ? lines[lineIndex % lines.length]! : "";

  useEffect(() => {
    if (paused || reducedMotion || lines.length === 0) return;
    let delay: number;
    let step: () => void;
    if (!erasing && shown < line.length) {
      delay = TYPE_MS;
      step = () => setShown((count) => count + 1);
    } else if (!erasing) {
      delay = HOLD_MS;
      step = () => setErasing(true);
    } else if (shown > 0) {
      delay = ERASE_MS;
      step = () => setShown((count) => count - 1);
    } else {
      delay = GAP_MS;
      step = () => {
        setErasing(false);
        setLineIndex((index) => (index + 1) % lines.length);
      };
    }
    const timer = window.setTimeout(step, delay);
    return () => window.clearTimeout(timer);
  }, [paused, reducedMotion, lines.length, line.length, shown, erasing]);

  if (lines.length === 0) return "";
  if (paused || reducedMotion) return line;
  return line.slice(0, shown);
}
