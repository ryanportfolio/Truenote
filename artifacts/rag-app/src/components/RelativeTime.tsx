import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format";

/**
 * "2 hours ago" with the absolute timestamp on hover (title) and in the
 * machine-readable dateTime attribute. Render sites stay responsible for
 * the null case ("—") so this component never has to guess.
 */
export function RelativeTime({ iso }: { iso: string }): JSX.Element {
  return (
    <time dateTime={iso} title={formatAbsoluteTime(iso)}>
      {formatRelativeTime(iso)}
    </time>
  );
}
