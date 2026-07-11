import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type ComponentProps,
  type ComponentType
} from "react";
import { Link, Route, Switch, Redirect, useLocation } from "wouter";
import { SearchX } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import {
  AppShellBoot,
  isProtectedPath,
  RouteBoot
} from "@/components/layout/AppShellBoot";
import { EmptyState } from "@/components/EmptyState";
import { fetchMe, SESSION_EXPIRED_EVENT } from "@/lib/api";
import { defaultLandingPath } from "@/lib/landing";
import type { CurrentUser } from "@/types/api";
import {
  clearSelectedProgram,
  getSelectedProgramId
} from "@/lib/selectedProgram";

/**
 * Memoize dynamic imports so route preloads and React.lazy share the same
 * promise. The active route starts downloading beside /api/me instead of
 * waiting for auth to finish and creating a second network waterfall.
 */
interface OnceLoader<T> {
  (): Promise<T>;
  peek: () => T | undefined;
}

function once<T>(load: () => Promise<T>): OnceLoader<T> {
  let pending: Promise<T> | null = null;
  let resolved: T | undefined;
  const loadOnce = (() =>
    (pending ??= load().then((value) => {
      resolved = value;
      return value;
    }))) as OnceLoader<T>;
  loadOnce.peek = () => resolved;
  return loadOnce;
}

/**
 * React.lazy suspends for one microtask even when its import promise already
 * resolved before the first render. That single frame is enough to reveal the
 * top-level loading fallback during route changes. Render the cached module
 * directly after an intent preload so navigation never enters Suspense.
 */
function preloadable<T extends ComponentType<any>>(
  load: OnceLoader<{ default: T }>
): ComponentType<ComponentProps<T>> {
  const LazyComponent = lazy(load);
  return function PreloadedComponent(props: ComponentProps<T>): JSX.Element {
    const loaded = load.peek();
    if (loaded) {
      const Component = loaded.default;
      return <Component {...props} />;
    }
    return <LazyComponent {...props} />;
  };
}

const loadChatPage = once(() =>
  import("@/pages/Chat").then((module) => ({ default: module.ChatPage }))
);
const loadKnowledgeBasePage = once(() =>
  import("@/pages/KnowledgeBaseList").then((module) => {
    // Start route data beside /api/me. The page validates the captured
    // program-selection owner before consuming this speculative response.
    module.preloadKnowledgeBaseDocuments();
    return { default: module.KnowledgeBasePage };
  })
);
const loadKbDocumentPage = once(() =>
  import("@/pages/KnowledgeBaseDocument").then((module) => ({
    default: module.KbDocumentPage
  }))
);
const loadAdminPage = once(() =>
  import("@/pages/Admin").then((module) => ({ default: module.AdminPage }))
);
const loadAdminGapsPage = once(() =>
  import("@/pages/AdminGaps").then((module) => ({ default: module.AdminGapsPage }))
);
const loadAdminProgramsPage = once(() =>
  import("@/pages/AdminPrograms").then((module) => ({
    default: module.AdminProgramsPage
  }))
);
const loadAdminModelRoutingPage = once(() =>
  import("@/pages/AdminModelRouting").then((module) => ({
    default: module.AdminModelRoutingPage
  }))
);
const loadAdminEvaluationsPage = once(() =>
  import("@/pages/AdminEvaluations").then((module) => ({
    default: module.AdminEvaluationsPage
  }))
);
const loadAdminUsersPage = once(() =>
  import("@/pages/AdminUsers").then((module) => ({ default: module.AdminUsersPage }))
);
const loadLoginPage = once(() =>
  import("@/pages/Login").then((module) => ({ default: module.LoginPage }))
);
const loadChangePasswordPage = once(() =>
  import("@/pages/ChangePassword").then((module) => ({
    default: module.ChangePasswordPage
  }))
);
const loadForgotPasswordPage = once(() =>
  import("@/pages/ForgotPassword").then((module) => ({
    default: module.ForgotPasswordPage
  }))
);
const loadResetPasswordPage = once(() =>
  import("@/pages/ResetPassword").then((module) => ({
    default: module.ResetPasswordPage
  }))
);

const ChatPage = preloadable(loadChatPage);
const KnowledgeBasePage = preloadable(loadKnowledgeBasePage);
const KbDocumentPage = preloadable(loadKbDocumentPage);
const AdminPage = preloadable(loadAdminPage);
const AdminGapsPage = preloadable(loadAdminGapsPage);
const AdminProgramsPage = preloadable(loadAdminProgramsPage);
const AdminModelRoutingPage = preloadable(loadAdminModelRoutingPage);
const AdminEvaluationsPage = preloadable(loadAdminEvaluationsPage);
const AdminUsersPage = preloadable(loadAdminUsersPage);
const LoginPage = preloadable(loadLoginPage);
const ChangePasswordPage = preloadable(loadChangePasswordPage);
const ForgotPasswordPage = preloadable(loadForgotPasswordPage);
const ResetPasswordPage = preloadable(loadResetPasswordPage);

export function preloadRoute(path: string): Promise<unknown> {
  const [pathname = "/"] = path.split(/[?#]/);
  if (pathname === "/" || pathname === "/login") {
    // The authenticated destination is role-dependent. Fetch both small
    // landing chunks beside login so neither CSR nor manager gets a
    // post-auth route waterfall.
    return Promise.all([loadLoginPage(), loadChatPage(), loadAdminPage()]);
  }
  if (pathname === "/chat") return loadChatPage();
  if (pathname === "/kb") return loadKnowledgeBasePage();
  if (pathname.startsWith("/kb/")) return loadKbDocumentPage();
  if (pathname === "/admin/documents") return loadAdminPage();
  if (pathname === "/admin/gaps" || pathname === "/admin/insights") {
    return loadAdminGapsPage();
  }
  if (pathname === "/admin/programs") return loadAdminProgramsPage();
  if (pathname === "/admin/model-routing") return loadAdminModelRoutingPage();
  if (pathname === "/admin/evaluations") return loadAdminEvaluationsPage();
  if (pathname === "/admin/users") return loadAdminUsersPage();
  if (pathname === "/forgot-password") return loadForgotPasswordPage();
  if (pathname === "/reset-password") return loadResetPasswordPage();
  if (pathname === "/change-password") return loadChangePasswordPage();
  return Promise.resolve();
}

function preloadCurrentRoute(): void {
  if (typeof window === "undefined") return;
  void preloadRoute(window.location.pathname);
}

preloadCurrentRoute();

// Begin the session probe during module evaluation instead of waiting for
// the first committed render and its effect. index.html preloads /api/me, so
// this usually consumes a response already moving beside the JS bundle.
const initialUserRequest =
  typeof window === "undefined" ? null : fetchMe();
void initialUserRequest?.catch(() => undefined);

function AppBoot(): JSX.Element {
  const path = typeof window === "undefined" ? "/" : window.location.pathname;
  if (isProtectedPath(path)) return <AppShellBoot path={path} />;

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div
        role="status"
        className="flex items-center gap-3 motion-safe:animate-skeleton motion-safe:[animation-delay:1.05s]"
      >
        <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden>
          <path
            d="M16 2c10 0 14 4 14 14s-4 14-14 14S2 26 2 16 6 2 16 2z"
            pathLength={1}
            strokeDasharray={1}
            className="fill-none stroke-foreground [stroke-width:1.5] motion-safe:animate-mark-draw"
          />
          <g className="motion-safe:animate-mark-ink">
            <path
              d="M16 2c10 0 14 4 14 14s-4 14-14 14S2 26 2 16 6 2 16 2z"
              className="fill-foreground"
            />
            <text
              x="16"
              y="22"
              textAnchor="middle"
              fontFamily="Georgia, serif"
              fontSize="18"
              fontWeight="600"
              className="fill-background"
            >
              T
            </text>
          </g>
        </svg>
        <span className="font-display text-2xl font-semibold tracking-tight motion-safe:animate-mark-ink">
          Truenote
        </span>
        <span className="sr-only">Loading…</span>
      </div>
    </div>
  );
}

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
  const [currentPath] = useLocation();
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  // Initial session probe on mount. fetchMe() returns null on 401 instead
  // of throwing, so we can deterministically distinguish "not logged in"
  // from "network error" (the latter still throws and we treat as
  // unauthenticated — better to show login than a stuck spinner).
  useEffect(() => {
    let cancelled = false;
    (initialUserRequest ?? fetchMe())
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
    return <AppBoot />;
  }

  if (auth.status === "unauthenticated") {
    // Unauthenticated routing: /forgot-password and /reset-password
    // are public surfaces (you can't be logged in if you forgot your
    // password). Anything else falls through to /login. Wouter reads
    // window.location, so deep-linking a reset email URL works
    // without an explicit router setup.
    const redirectTo = auth.redirectTo;
    return (
      <Suspense fallback={<AppBoot />}>
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
      </Suspense>
    );
  }

  if (auth.status === "must-reset") {
    return (
      <Suspense fallback={<AppBoot />}>
        <ChangePasswordPage
          user={auth.user}
          onPasswordChanged={handlePasswordChanged}
        />
      </Suspense>
    );
  }

  return (
    <AppShell
      user={auth.user}
      onLogout={handleLogout}
      onNavigateIntent={(path) => void preloadRoute(path)}
    >
      <Suspense fallback={<RouteBoot path={currentPath} />}>
        <Switch>
        <Route
          path="/"
          component={() => <Redirect to={defaultLandingPath(auth.user)} />}
        />
        <Route path="/chat">
          <ChatPage user={auth.user} />
        </Route>
        <Route path="/kb">
          <KnowledgeBasePage user={auth.user} />
        </Route>
        <Route path="/kb/:documentId">
          {(params) => <KbDocumentPage documentId={params.documentId} />}
        </Route>
        <Route path="/admin/documents">
          <AdminPage user={auth.user} />
        </Route>
        <Route path="/admin/gaps">
          <AdminGapsPage user={auth.user} />
        </Route>
        {/* The short-lived parallel-built Insights page merged into Gaps
          * (2026-07); keep the URL working for anyone who bookmarked it. */}
        <Route path="/admin/insights" component={() => <Redirect to="/admin/gaps" />} />
        <Route path="/admin/programs">
          <AdminProgramsPage user={auth.user} />
        </Route>
        <Route path="/admin/model-routing">
          <AdminModelRoutingPage user={auth.user} />
        </Route>
        <Route path="/admin/evaluations">
          <AdminEvaluationsPage user={auth.user} />
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
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
            <h1 className="font-display text-3xl font-semibold tracking-tight">Not found</h1>
            <EmptyState
              icon={SearchX}
              title="Page not found"
              hint="The page you're looking for doesn't exist."
            >
              <Link href="/chat" className="btn-whisper px-3 py-1.5">
                Go to Chat
              </Link>
            </EmptyState>
          </div>
        </Route>
        </Switch>
      </Suspense>
    </AppShell>
  );
}
