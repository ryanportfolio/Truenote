import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { BrandField } from "@/components/BrandField";
import { consumeResetToken, fetchConfig } from "@/lib/api";
import type { CurrentUser } from "@/types/api";

interface ResetPasswordPageProps {
  onAuthenticated: (user: CurrentUser) => void;
}

/**
 * Consumes a reset link's `?token=…` and sets a new password. The
 * server validates the token + writes the password + revokes existing
 * sessions + issues a fresh session, all atomically, then returns the
 * authenticated user. We forward that to the App state machine
 * (same hook the LoginPage uses) so the user lands on /chat without
 * a manual re-login.
 *
 * If the token is missing from the URL we render a sorry-state instead
 * of the form — there's nothing to submit. A token that's present but
 * expired/used surfaces as a 400 from the server with the same copy
 * the form shows for any submit-time failure.
 *
 * Minimum length mirrors /api/config the same way ChangePassword does.
 */
const PLACEHOLDER_MIN_LENGTH = 3;

function readTokenFromQuery(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const t = params.get("token");
  return t && t.length > 0 ? t : null;
}

export function ResetPasswordPage({
  onAuthenticated
}: ResetPasswordPageProps): JSX.Element {
  const [, setLocation] = useLocation();
  const [token] = useState<string | null>(() => readTokenFromQuery());
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minLength, setMinLength] = useState<number>(PLACEHOLDER_MIN_LENGTH);

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((cfg) => {
        if (!cancelled) setMinLength(cfg.minPasswordLength);
      })
      .catch(() => {
        // /api/config failure isn't fatal — the server still validates
        // length on submit and will surface a clear error.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!token) return;
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      const user = await consumeResetToken(token, newPassword);
      onAuthenticated(user);
      // The server already cleared must_reset_password, so route
      // straight to the landing page. handleAuthenticated will pick
      // the must-reset branch defensively if anything went sideways.
      setLocation("/");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not reset password"
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
        <BrandField />
        <div className="relative w-full max-w-sm space-y-3 rounded-lg border border-border bg-card p-6 shadow-card">
          <h1 className="font-display text-xl font-semibold tracking-tight">
            Reset link missing
          </h1>
          <p className="text-sm text-muted-foreground">
            This URL doesn&apos;t include a reset token. Use the link from your
            email, or request a new one.
          </p>
          <Link
            href="/forgot-password"
            className="block text-center text-sm font-medium text-foreground hover:underline"
          >
            Request a new reset link
          </Link>
        </div>
      </div>
    );
  }

  return (
    // Auth surfaces share the BrandField watercolor (login carries the
    // full moment with the glass card; here the field alone is enough).
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <BrandField />
      <form
        onSubmit={handleSubmit}
        className="relative w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-card"
      >
        <header className="space-y-1">
          <h1 className="font-display text-xl font-semibold tracking-tight">
            Set a new password
          </h1>
          <p className="text-sm text-muted-foreground">
            Choose a password with at least {minLength} characters. We will sign you in when you are
            done.
          </p>
        </header>

        <div className="space-y-2">
          <label htmlFor="new" className="text-sm font-medium">
            New password
          </label>
          <input
            id="new"
            type="password"
            autoComplete="new-password"
            minLength={minLength}
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={submitting}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="confirm" className="text-sm font-medium">
            Confirm new password
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            minLength={minLength}
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={submitting}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={
            submitting ||
            !newPassword ||
            !confirmPassword ||
            newPassword.length < minLength
          }
          className="btn-whisper w-full px-3 py-2"
        >
          {submitting ? "Updating…" : "Set password"}
        </button>

        <p className="text-center text-xs text-muted-foreground">
          <Link
            href="/login"
            className="text-foreground hover:underline"
          >
            Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
