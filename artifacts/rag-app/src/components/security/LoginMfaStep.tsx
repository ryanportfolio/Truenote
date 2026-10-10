import { useEffect, useRef, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { MfaExpiredError, verifyPasskeyLogin, verifyRecoveryCode } from "@/lib/api";
import type { CurrentUser, MfaRequiredResponse } from "@/types/api";

const LINK_BUTTON =
  "auth-forgot cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/** Matches the server's challenge lifetime (lib/auth/mfa.ts). */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface LoginMfaStepProps {
  challenge: MfaRequiredResponse;
  email: string;
  onAuthenticated: (user: CurrentUser) => void;
  /** The challenge expired: return to the password step with this message. */
  onExpired: (message: string) => void;
  onCancel: () => void;
}

/**
 * Second sign-in step for an account with a passkey. The password was
 * accepted; no session exists until a passkey assertion or a single-use
 * recovery code verifies. When the server does not offer `passkey` (its
 * WebAuthn configuration is unusable), only the recovery-code form shows.
 */
export function LoginMfaStep({
  challenge,
  email,
  onAuthenticated,
  onExpired,
  onCancel
}: LoginMfaStepProps): JSX.Element {
  // The server omits passkeyOptions when it does not offer passkey sign-in.
  const passkeyOffered = challenge.methods.includes("passkey") && Boolean(challenge.passkeyOptions);
  const [pending, setPending] = useState<"passkey" | "code" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(!passkeyOffered);
  const [code, setCode] = useState("");
  const passkeyButtonRef = useRef<HTMLButtonElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passkeyButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (showCode) codeInputRef.current?.focus();
  }, [showCode]);

  // The server refuses the challenge after five minutes; return to the
  // password step at that point instead of letting the next try fail.
  useEffect(() => {
    const timer = window.setTimeout(
      () => onExpired("Your sign-in expired. Enter your email and password again."),
      CHALLENGE_TTL_MS
    );
    return () => window.clearTimeout(timer);
  }, [onExpired]);

  function fail(err: unknown): void {
    if (err instanceof MfaExpiredError) {
      onExpired(err.message);
      return;
    }
    setError(err instanceof Error ? err.message : "Sign-in failed. Try again.");
  }

  async function usePasskey(): Promise<void> {
    setError(null);
    setPending("passkey");
    try {
      onAuthenticated(await verifyPasskeyLogin(challenge));
    } catch (err) {
      fail(err);
    } finally {
      setPending(null);
    }
  }

  async function submitCode(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setPending("code");
    try {
      onAuthenticated(await verifyRecoveryCode(code.trim()));
    } catch (err) {
      fail(err);
      codeInputRef.current?.focus();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="auth-form" data-login-mfa>
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Confirm it's you</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Password accepted for <span className="break-all font-medium text-foreground">{email}</span>.
          {passkeyOffered
            ? " This account also needs its passkey or a recovery code."
            : " Passkey sign-in is unavailable on this server, so enter one of this account's recovery codes."}
        </p>
      </div>

      {passkeyOffered ? (
        <button
          ref={passkeyButtonRef}
          type="button"
          onClick={() => void usePasskey()}
          disabled={pending !== null}
          className="btn-primary inline-flex items-center justify-center gap-2 px-5 py-2.5 text-base"
        >
          <KeyRound className="h-4 w-4" aria-hidden />
          {pending === "passkey" ? "Waiting for passkey…" : "Use passkey"}
        </button>
      ) : null}

      {showCode ? (
        <form onSubmit={(e) => void submitCode(e)} className="grid gap-3">
          <div className="auth-field">
            <label htmlFor="recovery-code">Recovery code</label>
            <input
              ref={codeInputRef}
              id="recovery-code"
              name="recovery-code"
              type="text"
              inputMode="text"
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              className="font-mono"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={pending !== null}
              aria-invalid={error !== null && pending === null ? true : undefined}
              aria-describedby="recovery-code-hint"
            />
            <p id="recovery-code-hint" className="text-xs text-muted-foreground">
              Each code works once. Hyphens and capitals are optional.
            </p>
          </div>
          <button
            type="submit"
            disabled={pending !== null || !code.trim()}
            className="btn-whisper justify-self-start px-4 py-2 text-sm"
          >
            {pending === "code" ? "Checking code…" : "Verify code"}
          </button>
        </form>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <div className="auth-actions">
        {!showCode && passkeyOffered ? (
          <button
            type="button"
            className={LINK_BUTTON}
            onClick={() => {
              setError(null);
              setShowCode(true);
            }}
            disabled={pending !== null}
          >
            Use a recovery code
          </button>
        ) : (
          <span />
        )}
        <button type="button" className={LINK_BUTTON} onClick={onCancel} disabled={pending !== null}>
          Start over
        </button>
      </div>
    </div>
  );
}
