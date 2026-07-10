import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { BrandField } from "@/components/BrandField";
import { requestPasswordReset } from "@/lib/api";

/**
 * Public self-service reset request. Mounted on the unauthenticated
 * branch of the App state machine — accessible only when there's no
 * valid session.
 *
 * UX contract (matches the server's anti-enumeration posture): we
 * surface the same "check your inbox" message whether or not the
 * email matches a real account. The server's /api/auth/forgot-password
 * always 204s; the only error path we can distinguish on is a network
 * failure, which we surface as "couldn't reach the server."
 */
export function ForgotPasswordPage(): JSX.Element {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(email.trim());
      setSubmitted(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Couldn't send reset email: ${err.message}`
          : "Couldn't send reset email"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // Auth surfaces share the BrandField watercolor (login carries the
    // full moment with the glass card; here the field alone is enough).
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <BrandField />
      <div className="relative w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-card">
        <header className="space-y-1">
          <h1 className="font-display text-xl font-semibold tracking-tight">
            Reset your password
          </h1>
          <p className="text-sm text-muted-foreground">
            Enter your email and we&apos;ll send you a link to choose a new
            password.
          </p>
        </header>

        {submitted ? (
          <div className="space-y-3">
            <p
              role="status"
              className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm"
            >
              If an account exists for that email, a reset link is on its way.
              The link expires in an hour.
            </p>
            <Link
              href="/login"
              className="block text-center text-sm text-muted-foreground hover:underline"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
              disabled={submitting || !email}
              className="btn-whisper w-full px-3 py-2"
            >
              {submitting ? "Sending…" : "Send reset link"}
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
        )}
      </div>
    </div>
  );
}
