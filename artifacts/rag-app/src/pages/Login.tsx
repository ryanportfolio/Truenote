import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { BrandField } from "@/components/BrandField";
import { fetchConfig, login } from "@/lib/api";
import { useGlassTilt } from "@/lib/useGlassTilt";
import type { CurrentUser, DemoAccount } from "@/types/api";

interface LoginPageProps {
  onAuthenticated: (user: CurrentUser) => void;
  /**
   * Optional deep-link target captured by App.tsx when the user was
   * dropped into the unauthenticated state from a non-auth page
   * (mid-session 401, or a first-load probe on a deep URL). After
   * a successful login we navigate here instead of the default
   * landing — preserves the page the user was on.
   *
   * Null means "no specific target" → default landing applies. The
   * value is a same-origin relative path (App.tsx never captures
   * absolute URLs), so passing it to setLocation is safe.
   */
  redirectTo?: string | null;
}

/**
 * Email + password login. On success, hands the authenticated user back
 * to the App-level state and lets App route the user to /change-password
 * (forced first-login) or the default landing page.
 *
 * Self-serve password reset via the "Forgot password?" link below the
 * sign-in button (Phase 2.5). The server always 204s on
 * /api/auth/forgot-password so a probing attacker can't enumerate
 * accounts; the user just sees "if your email is on file, check your
 * inbox" either way.
 *
 * Phase 2A scope:
 *   - No client-side rate limiting; server tolerates this
 *   - No "remember me" toggle — sessions are 7 days fixed
 */
export function LoginPage({
  onAuthenticated,
  redirectTo = null
}: LoginPageProps): JSX.Element {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hide the "Forgot password?" link when the api-server lacks an
  // email transport — clicking it would otherwise look successful
  // but the token would only land in api-server stdout. Default true
  // so the link doesn't flicker in: most deploys have email
  // configured and a brief absence on first paint is worse than a
  // brief presence that survives.
  const [emailResetAvailable, setEmailResetAvailable] = useState(true);
  // Demo deployments (server env DEMO_LOGIN_ACCOUNTS) publish demo
  // credentials via /api/config; we pre-fill the first account so anyone
  // opening the deployment can try every feature immediately.
  const [demoAccounts, setDemoAccounts] = useState<DemoAccount[]>([]);
  const [selectedDemo, setSelectedDemo] = useState<string | null>(null);
  const touchedRef = useRef(false);
  // Glass tilt: the card leans ≤2deg toward the pointer; the .glass-glint
  // ring reads --glint-angle from the same hook. No-op under
  // prefers-reduced-motion; flattens while typing.
  const tiltRef = useGlassTilt<HTMLFormElement>(2);

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((cfg) => {
        if (cancelled) return;
        setEmailResetAvailable(cfg.emailResetAvailable);
        const accounts = cfg.demoAccounts ?? [];
        setDemoAccounts(accounts);
        // Pre-fill only while the form is still untouched — the config
        // fetch races the user's first keystroke, and losing typed input
        // to an async prefill would be worse than no prefill.
        const first = accounts[0];
        if (first && !touchedRef.current) {
          setEmail(first.email);
          setPassword(first.password);
          setSelectedDemo(first.email);
        }
      })
      .catch(() => {
        // Non-fatal — leave the default true. The forgot-password
        // submit path still works (it just may silently log).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function applyDemoAccount(account: DemoAccount): void {
    setEmail(account.email);
    setPassword(account.password);
    setSelectedDemo(account.email);
    setError(null);
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await login(email.trim(), password);
      onAuthenticated(user);
      // mustResetPassword always wins — even a captured redirectTo
      // can't bypass the forced-reset gate. Otherwise honor the deep
      // link if one was captured by App.tsx, else default landing.
      if (user.mustResetPassword) {
        setLocation("/change-password");
      } else {
        setLocation(redirectTo ?? "/");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // The one brand moment in the app, now alive: the BrandField shader
    // (PRODUCT.md's Cohere-illustration direction as living watercolor)
    // behind a card that leans like glass toward the pointer. Decorative
    // only; the opaque card keeps every contrast guarantee.
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <BrandField />
      <form
        ref={tiltRef}
        onSubmit={handleSubmit}
        className="relative w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-panel will-change-transform"
      >
        {/* Absolutely positioned, so it lives outside the space-y flow
          * below — as a sibling it would hand the first real child a
          * phantom margin-top. */}
        <div aria-hidden className="glass-glint" />
        <div className="space-y-4">
          <header className="space-y-1">
            <h1 className="font-display text-2xl font-semibold tracking-tight">Truenote</h1>
            <p className="text-sm text-muted-foreground">
              Sign in
            </p>
          </header>

          {demoAccounts.length > 0 ? (
            <div className="space-y-2 rounded-lg border border-dashed border-border bg-muted/40 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Demo environment — credentials pre-filled
              </p>
              <div className="flex flex-wrap gap-2">
                {demoAccounts.map((account) => (
                  <button
                    key={account.email}
                    type="button"
                    onClick={() => applyDemoAccount(account)}
                    aria-pressed={selectedDemo === account.email}
                    className={
                      selectedDemo === account.email
                        ? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        : "rounded-full border border-input px-3 py-1 text-xs text-muted-foreground transition-colors duration-100 ease-out hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    }
                  >
                    {account.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

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
              onChange={(e) => {
                touchedRef.current = true;
                setSelectedDemo(null);
                setEmail(e.target.value);
              }}
              disabled={submitting}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                touchedRef.current = true;
                setSelectedDemo(null);
                setPassword(e.target.value);
              }}
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
            disabled={submitting || !email || !password}
            className="btn-whisper w-full px-3 py-2"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>

          {emailResetAvailable ? (
            <p className="text-center text-xs text-muted-foreground">
              <Link
                href="/forgot-password"
                className="text-foreground hover:underline"
              >
                Forgot password?
              </Link>
            </p>
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              Forgot your password? Contact an admin to reset it.
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
