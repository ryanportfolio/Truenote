import { useCallback, useEffect, useState } from "react";
import { Route, Switch, Redirect } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { ChatPage } from "@/pages/Chat";
import { AdminPage } from "@/pages/Admin";
import { AdminInsightsPage } from "@/pages/AdminInsights";
import { AdminProgramsPage } from "@/pages/AdminPrograms";
import { AdminUsersPage } from "@/pages/AdminUsers";
import { LoginPage } from "@/pages/Login";
import { ChangePasswordPage } from "@/pages/ChangePassword";
import { ForgotPasswordPage } from "@/pages/ForgotPassword";
import { ResetPasswordPage } from "@/pages/ResetPassword";
import { fetchMe, SESSION_EXPIRED_EVENT } from "@/lib/api";
import type { CurrentUser } from "@/types/api";
import {
  clearSelectedProgram,
  getSelectedProgramId
} from "@/lib/selectedProgram";

/**
 * Drop the picker's stored program selection if it belongs to a
 * different user than the one we just authenticated as. Prevents user
 * A's selection from briefly flowing in user B's first requests on a
 * shared browser. Server-side validation makes this safe even without
 * the clear, but the UX is cleaner with it.
 */
function pruneStaleProgramSelection(user: CurrentUser): void {
  if (getSelectedProgramId(user.id) === null) {
    // Either nothing stored, or stored under a different user id.
    clearSelectedProgram();
  }
}

/**
 * Auth state machine for the top-level shell:
 *   loading        → initial /api/me probe in flight
 *   unauthenticated → no valid session; show LoginPage
 *   must-reset     → authenticated but mustResetPassword=true; force
 *                    the change-password screen
 *   authenticated  → normal app
 *
 * The shell handles the routing decisions; child pages never need to
 * worry about the unauthenticated state because they're not rendered
 * until we're in the `authenticated` branch.
 */
type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated"; redirectTo: string | null }
  | { status: "must-reset"; user: CurrentUser }
  | { status: "authenticated"; user: CurrentUser };

/**
 * Paths that should NEVER be captured as a deep-link redirect target.
 * Sending a freshly-authenticated user back to /login or /reset-password
 * after they finished those flows is a useless loop. `/` is excluded
 * because it's the default landing already.
 */
const AUTH_PATHS = new Set([
  "/login",
  "/forgot-password",
  "/reset-password",
  "/change-password"
]);

/**
 * Snapshot the current URL for "send the user back here after login."
 * Returns null when the current path is itself an auth page or `/` —
 * those would be no-op or loop targets. Includes search params so
 * deep-linked filters (`/admin/users?role=manager`) survive the round
 * trip; drops hash (no current usage and adds complexity).
 *
 * Same-origin only: we only read window.location, so the returned
 * value is a relative path. An `open-redirect`-style attack would
 * have to forge our internal navigation, not just craft a URL.
 */
function captureRedirectTarget(): string | null {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname;
  if (AUTH_PATHS.has(path)) return null;
  if (path === "/" || path === "") return null;
  return path + window.location.search;
}

export function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  // Initial session probe on mount. fetchMe() returns null on 401 instead
  // of throwing, so we can deterministically distinguish "not logged in"
  // from "network error" (the latter still throws and we treat as
  // unauthenticated — better to show login than a stuck spinner).
  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((user) => {
        if (cancelled) return;
        if (!user) {
          // First-load unauth: if the user deep-linked into a protected
          // page (e.g., a manager bookmarked /admin/users), capture
          // the path so we can return them there after login instead
          // of dumping them at /chat.
          setAuth({
            status: "unauthenticated",
            redirectTo: captureRedirectTarget()
          });
        } else {
          pruneStaleProgramSelection(user);
          if (user.mustResetPassword) {
            setAuth({ status: "must-reset", user });
          } else {
            setAuth({ status: "authenticated", user });
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAuth({
            status: "unauthenticated",
            redirectTo: captureRedirectTarget()
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAuthenticated = useCallback((user: CurrentUser): void => {
    pruneStaleProgramSelection(user);
    if (user.mustResetPassword) {
      setAuth({ status: "must-reset", user });
    } else {
      setAuth({ status: "authenticated", user });
    }
  }, []);

  const handlePasswordChanged = useCallback((user: CurrentUser): void => {
    setAuth({ status: "authenticated", user });
  }, []);

  const handleLogout = useCallback((): void => {
    // Don't clear the program selection here: a logout/relogin cycle on
    // the same device should restore the same picker state. The on-
    // login pruneStaleProgramSelection cleans up if a *different* user
    // signs in. Don't capture a redirect target either: an intentional
    // logout shouldn't pull the user back into the previous page.
    setAuth({ status: "unauthenticated", redirectTo: null });
  }, []);

  // Listen for mid-session 401s anywhere in the app. The api layer fires
  // SESSION_EXPIRED_EVENT on any authenticated request that comes back
  // 401 (typically 7-day session expiry mid-shift). Flipping state to
  // unauthenticated unmounts the current page and renders the login
  // screen, giving the user an obvious path forward instead of a raw
  // "Unauthorized" error toast. We capture the URL so the post-login
  // navigation can return them to the page they were using.
  useEffect(() => {
    function handle(): void {
      setAuth({
        status: "unauthenticated",
        redirectTo: captureRedirectTarget()
      });
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handle);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handle);
  }, []);

  if (auth.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (auth.status === "unauthenticated") {
    // Unauthenticated routing: /forgot-password and /reset-password
    // are public surfaces (you can't be logged in if you forgot your
    // password). Anything else falls through to /login. Wouter reads
    // window.location, so deep-linking a reset email URL works
    // without an explicit router setup.
    const redirectTo = auth.redirectTo;
    return (
      <Switch>
        <Route path="/forgot-password">
          <ForgotPasswordPage />
        </Route>
        <Route path="/reset-password">
          <ResetPasswordPage onAuthenticated={handleAuthenticated} />
        </Route>
        <Route>
          <LoginPage
            onAuthenticated={handleAuthenticated}
            redirectTo={redirectTo}
          />
        </Route>
      </Switch>
    );
  }

  if (auth.status === "must-reset") {
    return (
      <ChangePasswordPage
        user={auth.user}
        onPasswordChanged={handlePasswordChanged}
      />
    );
  }

  return (
    <AppShell user={auth.user} onLogout={handleLogout}>
      <Switch>
        <Route path="/" component={() => <Redirect to="/chat" />} />
        <Route path="/chat">
          <ChatPage user={auth.user} />
        </Route>
        <Route path="/admin/documents">
          <AdminPage user={auth.user} />
        </Route>
        <Route path="/admin/insights">
          <AdminInsightsPage user={auth.user} />
        </Route>
        <Route path="/admin/programs">
          <AdminProgramsPage user={auth.user} />
        </Route>
        <Route path="/admin/users">
          <AdminUsersPage user={auth.user} />
        </Route>
        <Route path="/login" component={() => <Redirect to="/" />} />
        <Route path="/change-password">
          <ChangePasswordPage
            user={auth.user}
            onPasswordChanged={handlePasswordChanged}
          />
        </Route>
        <Route>
          <div className="mx-auto max-w-3xl px-6 py-8">
            <h1 className="text-xl font-semibold tracking-tight">Not found</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The page you're looking for doesn't exist.
            </p>
          </div>
        </Route>
      </Switch>
    </AppShell>
  );
}
