import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { fetchConfig, login } from "@/lib/api";
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
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="login-title">
        <div className="auth-panel-inner">
          <Link href="/" className="auth-wordmark" aria-label="Truenote home">
            <span className="auth-wordmark-orbit" aria-hidden>
              T
            </span>
            <span className="font-display text-xl font-semibold tracking-tight">Truenote</span>
          </Link>

          <div className="auth-intro">
            <p className="auth-eyebrow">Calm. Precise. Cited.</p>
            <h1 id="login-title" className="auth-title">
              Know what is true.
              <br />
              <span>Show why.</span>
            </h1>
            <p className="auth-subtitle">
              Grounded answers for the moments when guessing is not an option.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="auth-form">
            {demoAccounts.length > 0 ? (
              <fieldset className="auth-demo">
                <legend>Demo access, credentials ready</legend>
                <div className="flex flex-wrap gap-2">
                  {demoAccounts.map((account) => (
                    <button
                      key={account.email}
                      type="button"
                      onClick={() => applyDemoAccount(account)}
                      aria-pressed={selectedDemo === account.email}
                      className={
                        selectedDemo === account.email
                          ? "auth-demo-chip auth-demo-chip-active"
                          : "auth-demo-chip"
                      }
                    >
                      {account.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            ) : null}

            <div className="auth-field">
              <label htmlFor="email">Email</label>
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
              />
            </div>

            <div className="auth-field">
              <label htmlFor="password">Password</label>
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

            <div className="auth-actions">
              <button
                type="submit"
                disabled={submitting || !email || !password}
                className="btn-primary min-w-32 px-5 py-2.5 text-base"
              >
                {submitting ? "Signing in…" : "Enter Truenote"}
              </button>

              {emailResetAvailable ? (
                <Link href="/forgot-password" className="auth-forgot">
                  Forgot password?
                </Link>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Contact an admin to reset your password.
                </p>
              )}
            </div>
          </form>

          <p className="auth-trust-line">
            <span aria-hidden>✓</span> Every answer cites a source or refuses.
          </p>
        </div>
      </section>

      <section className="archive-visual" aria-hidden="true">
        <img
          src="/visuals/luminous-archive.png"
          alt=""
          aria-hidden
          className="archive-image"
          fetchPriority="high"
        />
        <div className="archive-light" aria-hidden />
        <div className="archive-orbit archive-orbit-outer" aria-hidden />
        <div className="archive-orbit archive-orbit-inner" aria-hidden />
        <div className="archive-caption" aria-hidden>
          <span>01</span>
          <p>The Luminous Archive</p>
          <i />
        </div>
      </section>
    </main>
  );
}
