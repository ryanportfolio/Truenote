import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { BrandField } from "@/components/BrandField";
import { DemoPortal } from "@/components/DemoPortal";
import { LoginMfaStep } from "@/components/security/LoginMfaStep";
import { fetchConfig, login } from "@/lib/api";
import { defaultLandingPath } from "@/lib/landing";
import { cn } from "@/lib/utils";
import type { CurrentUser, DemoAccount, MfaRequiredResponse } from "@/types/api";

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

/**
 * The portal grid in index.css is two columns, which fits two or four
 * accounts (the server allows 1 to 4). One account takes the full row.
 * Three sit in one row from `sm` up and stack below `sm`, where three
 * columns would clip the labels. The grid's data-count lets index.css
 * place each portal's archive art and aim its reading beam at the label.
 */
function demoPortalLayout(count: number): {
  grid: string;
  portal: string;
} {
  if (count === 1) return { grid: "grid-cols-1", portal: "" };
  if (count === 3) {
    return {
      grid: "grid-cols-1 sm:grid-cols-3",
      portal: "min-h-[4.75rem] sm:min-h-[7rem]"
    };
  }
  return { grid: "", portal: "" };
}

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
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [localLoginMode, setLocalLoginMode] = useState<
    "enabled" | "break_glass" | "disabled"
  >("enabled");
  // Demo deployments (server env DEMO_LOGIN_ACCOUNTS) publish demo
  // credentials via /api/config; we pre-fill the first account so anyone
  // opening the deployment can try every feature immediately.
  const [demoAccounts, setDemoAccounts] = useState<DemoAccount[]>([]);
  const [selectedDemo, setSelectedDemo] = useState<string | null>(null);
  // Set after the password step when the account has a passkey.
  const [mfaChallenge, setMfaChallenge] = useState<MfaRequiredResponse | null>(null);
  // ResetPassword sends here (`?reset=done`) when the reset issued no
  // session because the account signs in with a second factor.
  const [passwordChanged] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("reset") === "done"
  );
  const touchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((cfg) => {
        if (cancelled) return;
        setEmailResetAvailable(cfg.emailResetAvailable);
        setOidcEnabled(cfg.oidcEnabled);
        setLocalLoginMode(cfg.localLoginMode);
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

  // Stable identity, so the memoized portals skip re-rendering on every
  // keystroke in the email and password fields.
  const applyDemoAccount = useCallback((account: DemoAccount): void => {
    setEmail(account.email);
    setPassword(account.password);
    setSelectedDemo(account.email);
    setError(null);
  }, []);

  const demoLayout = demoPortalLayout(demoAccounts.length);

  function finishLogin(user: CurrentUser): void {
    onAuthenticated(user);
    // mustResetPassword always wins: even a captured redirectTo
    // can't bypass the forced-reset gate. Otherwise honor the deep
    // link if one was captured by App.tsx, else use the role landing.
    if (user.mustResetPassword) {
      setLocation("/change-password");
    } else {
      setLocation(redirectTo ?? defaultLandingPath(user));
    }
  }

  // Leaving the second step (expired, or "Start over") returns to an empty
  // password field; the password is not kept for a later retry.
  const leaveMfa = useCallback((message: string | null) => {
    setMfaChallenge(null);
    setPassword("");
    setError(message);
  }, []);
  const expireMfa = useCallback((message: string) => leaveMfa(message), [leaveMfa]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await login(email.trim(), password);
      if (result.status === "mfa_required") {
        setMfaChallenge(result.challenge);
        return;
      }
      finishLogin(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="login-title">
        <div className="auth-field-layer" aria-hidden>
          <BrandField />
        </div>
        <div className="auth-panel-inner">
          <Link href="/" className="auth-wordmark" aria-label="Truenote home">
            <span className="auth-wordmark-orbit" aria-hidden>
              T
            </span>
            <span className="font-display text-xl font-semibold tracking-tight">Truenote</span>
          </Link>

          <div className="auth-intro">
            <h1 id="login-title" className="auth-title">
              Find the answer
              <br />
              <span>Check the source</span>
            </h1>
          </div>

          {mfaChallenge ? (
            <LoginMfaStep
              challenge={mfaChallenge}
              email={email.trim()}
              onAuthenticated={finishLogin}
              onExpired={expireMfa}
              onCancel={() => leaveMfa(null)}
            />
          ) : (
          <form onSubmit={handleSubmit} className="auth-form">
            {passwordChanged ? (
              <p
                role="status"
                className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"
              >
                Password changed. Sign in with your new password.
              </p>
            ) : null}

            {oidcEnabled ? (
              <div className="flex flex-col gap-3">
                <a
                  href={`/api/auth/oidc/start?returnTo=${encodeURIComponent(redirectTo ?? "/chat")}`}
                  className="btn-primary inline-flex justify-center px-5 py-2.5 text-base"
                >
                  Continue with company SSO
                </a>
                {new URLSearchParams(window.location.search).get("sso_error") ? (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    Company sign-in could not be completed. Contact an administrator if it repeats.
                  </p>
                ) : null}
                {localLoginMode !== "disabled" ? (
                  <p className="text-center text-xs text-muted-foreground">
                    {localLoginMode === "break_glass"
                      ? "Emergency super-user access"
                      : "Or sign in with a local account"}
                  </p>
                ) : null}
              </div>
            ) : null}

            {demoAccounts.length > 0 && localLoginMode !== "disabled" ? (
              <fieldset className="auth-demo">
                <legend>Demo Accounts:</legend>
                <div
                  className={cn("auth-demo-grid", demoLayout.grid)}
                  data-count={demoAccounts.length}
                >
                  {demoAccounts.map((account) => (
                    <DemoPortal
                      key={account.email}
                      account={account}
                      selected={selectedDemo === account.email}
                      disabled={submitting}
                      className={demoLayout.portal}
                      onSelect={applyDemoAccount}
                    />
                  ))}
                </div>
              </fieldset>
            ) : null}

            <div className={localLoginMode === "disabled" ? "hidden" : "auth-field"}>
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

            <div className={localLoginMode === "disabled" ? "hidden" : "auth-field"}>
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
                disabled={
                  submitting || !email || !password || localLoginMode === "disabled"
                }
                className={
                  localLoginMode === "disabled"
                    ? "hidden"
                    : oidcEnabled
                      ? "btn-whisper min-w-32 px-5 py-2.5 text-base"
                      : "btn-primary min-w-32 px-5 py-2.5 text-base"
                }
              >
                {submitting ? "Signing in…" : "Sign in"}
              </button>

              <div className="auth-secondary-links">
                {emailResetAvailable && localLoginMode !== "disabled" ? (
                  <Link href="/forgot-password" className="auth-forgot">
                    Forgot password?
                  </Link>
                ) : localLoginMode !== "disabled" ? (
                  <p className="text-xs text-muted-foreground">
                    Contact an admin to reset your password.
                  </p>
                ) : null}
                <a href="/about/" className="auth-about">
                  About Truenote
                </a>
                <a href="/security/" className="auth-about">
                  Security
                </a>
              </div>
            </div>
          </form>
          )}


        </div>
      </section>

      <section className="archive-visual" aria-hidden="true">
        {/* React 18's DOM only knows the lowercase fetchpriority attribute
          * (camelCase fetchPriority warns and gets dropped); the spread
          * sidesteps the React 18 type defs that lack it. */}
        <img
          src="/visuals/luminous-archive-clean.webp"
          alt=""
          aria-hidden
          className="archive-image"
          {...{ fetchpriority: "high" }}
        />

        <div className="archive-plane archive-plane-rear" aria-hidden>
          <div className="archive-plane-motion">
            <img
              src="/visuals/luminous-archive-clean.webp"
              alt=""
              className="archive-layer-image"
            />
          </div>
        </div>

        <div className="archive-plane archive-plane-core" aria-hidden>
          <div className="archive-plane-motion">
            <img
              src="/visuals/luminous-archive-clean.webp"
              alt=""
              className="archive-layer-image"
            />
          </div>
        </div>

        <div className="archive-plane archive-plane-mineral" aria-hidden>
          <div className="archive-plane-motion">
            <img
              src="/visuals/luminous-archive-clean.webp"
              alt=""
              className="archive-layer-image"
            />
            <span className="archive-refraction" />
          </div>
        </div>

        <div className="archive-plane archive-plane-foreground" aria-hidden>
          <div className="archive-plane-motion">
            <img
              src="/visuals/luminous-archive-clean.webp"
              alt=""
              className="archive-layer-image"
            />
          </div>
        </div>
      </section>
    </main>
  );
}
