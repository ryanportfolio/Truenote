import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const DESTRUCTIVE_PILL =
  "rounded-full border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

interface PasswordConfirmFormProps {
  /** Short sentence above the fields saying what the password confirms. */
  description: ReactNode;
  submitLabel: string;
  pendingLabel: string;
  destructive?: boolean;
  /** Extra fields shown before the password (for example a passkey name). */
  children?: ReactNode;
  /** Throw to show the message inline; the form stays open. */
  onSubmit: (password: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * Inline re-authentication for security changes. Every MFA enrollment
 * change needs the current password; a wrong one counts toward lockout on
 * the server.
 */
export function PasswordConfirmForm({
  description,
  submitLabel,
  pendingLabel,
  destructive = false,
  children,
  onSubmit,
  onCancel
}: PasswordConfirmFormProps): JSX.Element {
  const id = useId();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await onSubmit(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
      setPassword("");
      passwordRef.current?.focus();
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => void submit(e)}
      className="mt-3 grid gap-3 rounded-lg border border-border bg-secondary p-4"
    >
      <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      {children}
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-password`} className="text-sm font-medium">
          Current password
        </label>
        <input
          ref={passwordRef}
          id={`${id}-password`}
          name="current-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="w-full max-w-sm rounded-md border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        />
      </div>
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={pending || !password}
          className={cn(destructive ? DESTRUCTIVE_PILL : "btn-whisper px-3 py-1.5 text-sm")}
        >
          {pending ? pendingLabel : submitLabel}
        </button>
        <button
          type="button"
          className="btn-whisper px-3 py-1.5 text-sm"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
