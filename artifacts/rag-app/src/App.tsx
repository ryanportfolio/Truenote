import { useCallback, useEffect, useState } from "react";
import { Route, Switch, Redirect } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { ChatPage } from "@/pages/Chat";
import { AdminPage } from "@/pages/Admin";
import { AdminProgramsPage } from "@/pages/AdminPrograms";
import { LoginPage } from "@/pages/Login";
import { ChangePasswordPage } from "@/pages/ChangePassword";
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
  | { status: "unauthenticated" }
  | { status: "must-reset"; user: CurrentUser }
  | { status: "authenticated"; user: CurrentUser };

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
          setAuth({ status: "unauthenticated" });
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
        if (!cancelled) setAuth({ status: "unauthenticated" });
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
    // signs in.
    setAuth({ status: "unauthenticated" });
  }, []);

  // Listen for mid-session 401s anywhere in the app. The api layer fires
  // SESSION_EXPIRED_EVENT on any authenticated request that comes back
  // 401 (typically 7-day session expiry mid-shift). Flipping state to
  // unauthenticated unmounts the current page and renders the login
  // screen, giving the user an obvious path forward instead of a raw
  // "Unauthorized" error toast.
  useEffect(() => {
    function handle(): void {
      setAuth({ status: "unauthenticated" });
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
    return <LoginPage onAuthenticated={handleAuthenticated} />;
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
        <Route path="/admin/programs">
          <AdminProgramsPage user={auth.user} />
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
