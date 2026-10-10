import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

interface RecoveryCodesRevealProps {
  codes: string[];
  onDone: () => void;
}

/**
 * The one time new recovery codes are visible. The server stores only
 * their hashes, so closing this panel loses the plaintext for good.
 */
export function RecoveryCodesReveal({ codes, onDone }: RecoveryCodesRevealProps): JSX.Element {
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-warning/40 bg-warning/15 p-4" data-recovery-codes>
      <h4
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-semibold text-warning-foreground focus:outline-none"
      >
        Save these {codes.length} codes now
      </h4>
      <p className="mt-1 text-sm leading-relaxed text-warning-foreground">
        They won't be shown again. Each code signs in once, in place of a passkey. Generating new
        codes replaces these.
      </p>
      <ol className="mt-3 grid gap-x-6 gap-y-1.5 rounded-md border border-border bg-card p-3 font-mono text-[13px] tabular-nums sm:grid-cols-2">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-whisper inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
          onClick={() => void copy()}
        >
          {copied === "ok" ? (
            <Check className="h-4 w-4 text-success motion-safe:animate-in motion-safe:zoom-in-75 motion-safe:duration-100" aria-hidden />
          ) : (
            <Copy className="h-4 w-4" aria-hidden />
          )}
          {copied === "ok" ? "Copied" : "Copy codes"}
        </button>
        <button type="button" className="btn-whisper px-3 py-1.5 text-sm" onClick={onDone}>
          I saved them
        </button>
        <span role="status" className="text-sm text-warning-foreground">
          {copied === "failed" ? "Copy failed. Select the codes and copy them by hand." : ""}
        </span>
      </div>
    </div>
  );
}
