/**
 * Timestamp formatting for list surfaces. Relative time ("2 hours ago")
 * is what a scanning admin actually wants; the absolute string survives
 * as a hover title on the <time> element (see components/RelativeTime).
 */

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const DIVISIONS: ReadonlyArray<{
  ms: number;
  unit: Intl.RelativeTimeFormatUnit;
}> = [
  { ms: 1000, unit: "second" },
  { ms: 60_000, unit: "minute" },
  { ms: 3_600_000, unit: "hour" },
  { ms: 86_400_000, unit: "day" },
  { ms: 604_800_000, unit: "week" },
  { ms: 2_629_800_000, unit: "month" },
  { ms: 31_557_600_000, unit: "year" }
];

export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = then - nowMs; // negative = past
  const abs = Math.abs(diff);
  // Pick the largest unit whose next step exceeds the difference.
  let division: { ms: number; unit: Intl.RelativeTimeFormatUnit } = {
    ms: 1000,
    unit: "second"
  };
  for (const d of DIVISIONS) {
    if (abs >= d.ms) division = d;
  }
  return RTF.format(Math.trunc(diff / division.ms), division.unit);
}

export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
