import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { changePassword, fetchConfig } from "@/lib/api";
import type { CurrentUser } from "@/types/api";

interface ChangePasswordPageProps {
  user: CurrentUser;
  onPasswordChanged: (user: CurrentUser) => void;
}

/**
 * Forced password reset on first login. Required when the server reports
 * `must_reset_password=true` (bootstrap super_user, or any user freshly
 * created by a manager). After the change, the server clears the flag,
 * re-issues a session, and we redirect to the default landing page.
 *
 * Minimum length is read from /api/config (driven by the server's
 * MIN_PASSWORD_LENGTH env var) so a dev environment can drop the
 * floor to 3 without code edits. Until the config loads we use the
 * server-side default of 3 as a permissive placeholder — the real
 * value clamps in once /api/config resolves, and the server zod
 * schema is the final authority either way.
 */
const PLACEHOLDER_MIN_LENGTH = 3;

export function ChangePasswordPage({
  user,
  onPasswordChanged
}: ChangePasswordPageProps): JSX.Element {
  const [, setLocation] = useLocation();
  const [currentPassword, setCurrentPassword] = useState("");
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
        // Config fetch failure isn't fatal — the server still enforces
        // its own floor in the zod schema and will surface the right
        // error message on submit. Stick with the placeholder.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match");
      return;
    }

    setSubmitting(true);
    try {
      const updatedUser = await changePassword(currentPassword, newPassword);
      onPasswordChanged(updatedUser);
      setLocation("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password change failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-card"
      >
        <header className="space-y-1">
          <h1 className="font-display text-xl font-semibold tracking-tight">
            {user.mustResetPassword ? "Set a new password" : "Change password"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {user.mustResetPassword
              ? `First sign-in. Choose a new password with at least ${minLength} characters.`
              : `Choose a password with at least ${minLength} characters.`}
          </p>
        </header>

        <div className="space-y-2">
          <label htmlFor="current" className="text-sm font-medium">
            Current password
          </label>
          <input
            id="current"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={submitting}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

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
            !currentPassword ||
            !newPassword ||
            !confirmPassword ||
            newPassword.length < minLength
          }
          className="btn-whisper w-full px-3 py-2"
        >
          {submitting ? "Updating…" : "Update password"}
        </button>
      </form>
    </div>
  );
}
