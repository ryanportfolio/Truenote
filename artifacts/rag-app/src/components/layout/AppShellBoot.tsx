import { BrandMark } from "@/components/BrandMark";
import { History } from "lucide-react";

const NAV_PLACEHOLDERS = ["chat", "kb", "documents", "gaps", "users"] as const;

function ChatRouteBoot(): JSX.Element {
  return (
    <div className="chat-workspace mx-auto flex max-w-3xl flex-col gap-5 px-4 pt-7 sm:px-6">
      <header className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="w-full max-w-xl">
            <h1 className="page-title">
              Find the answer
              <br />
              <span>Check the source</span>
            </h1>
          </div>
          <div className="btn-whisper flex shrink-0 items-center gap-1.5 px-3 py-1.5">
            <History className="h-4 w-4" />
            History
          </div>
        </div>
      </header>
      <div className="flex flex-col gap-4">
        <div className="skeleton h-64 w-full rounded-lg" />
        <div className="composer-dock -mx-4 px-4 pb-6 sm:-mx-6 sm:px-6">
          <div className="composer-frame">
            <div className="skeleton h-3 w-24" />
            <div className="skeleton h-[4.8rem] w-full rounded-md" />
            <div className="flex items-center justify-between gap-3">
              <div className="skeleton hidden h-4 w-72 sm:block" />
              <div className="skeleton ml-auto h-10 w-24 rounded-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function KnowledgeRouteBoot({ document }: { document: boolean }): JSX.Element {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
      <header>
        {document ? (
          <>
            <div className="skeleton h-8 w-32 rounded-full" />
            <div className="skeleton mt-4 h-9 w-2/3" />
          </>
        ) : (
          <>
            <h1 className="font-display text-3xl font-semibold tracking-tight">
              Sources
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Documents used to answer questions. Open one to read it in full.
            </p>
          </>
        )}
      </header>
      {document ? (
        <div className="rounded-lg border border-border bg-card p-5 shadow-card">
          <div className="skeleton h-8 w-2/3" />
          <div className="skeleton mt-6 h-4 w-full" />
          <div className="skeleton mt-2 h-4 w-full" />
          <div className="skeleton mt-2 h-4 w-4/5" />
        </div>
      ) : (
        <>
          <div className="skeleton h-[38px] w-full rounded-md" />
          <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
            <div className="border-b border-border px-4 py-3">
              <div className="skeleton h-4 w-2/3" />
            </div>
            <div className="px-4 py-3">
              <div className="skeleton h-4 w-1/2" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const ADMIN_TITLES: Record<string, string> = {
  "/admin/documents": "Documents",
  "/admin/gaps": "Content gaps",
  "/admin/insights": "Content gaps",
  "/admin/programs": "Programs",
  "/admin/users": "Users"
};

function AdminRouteBoot({ path }: { path: string }): JSX.Element {
  const compact = path === "/admin/programs";
  return (
    <div
      className={`mx-auto flex flex-col gap-6 px-6 py-8 ${
        compact ? "max-w-3xl" : "max-w-5xl"
      }`}
    >
      <header className="flex items-start justify-between gap-4">
        <div className="w-full">
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            {ADMIN_TITLES[path] ?? "Truenote"}
          </h1>
          <div className="skeleton mt-2 h-4 w-full max-w-lg" />
        </div>
        <div className="skeleton h-10 w-32 shrink-0 rounded-full" />
      </header>
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
        <div className="flex items-center gap-6 border-b border-border px-5 py-4">
          <div className="skeleton h-4 w-48" />
          <div className="skeleton h-4 w-32" />
          <div className="skeleton ml-auto h-4 w-20" />
        </div>
        <div className="flex items-center gap-6 px-5 py-4">
          <div className="skeleton h-4 w-40" />
          <div className="skeleton h-4 w-28" />
          <div className="skeleton ml-auto h-4 w-16" />
        </div>
      </div>
    </div>
  );
}

export function isProtectedPath(path: string): boolean {
  const [pathname = "/"] = path.split(/[?#]/);
  return (
    pathname === "/chat" ||
    pathname === "/kb" ||
    pathname.startsWith("/kb/") ||
    pathname.startsWith("/admin/")
  );
}

export function RouteBoot({ path }: { path: string }): JSX.Element {
  const [pathname = "/"] = path.split(/[?#]/);
  let content: JSX.Element;
  if (pathname === "/chat") {
    content = <ChatRouteBoot />;
  } else if (pathname === "/kb" || pathname.startsWith("/kb/")) {
    content = <KnowledgeRouteBoot document={pathname !== "/kb"} />;
  } else {
    content = <AdminRouteBoot path={pathname} />;
  }

  return (
    <div role="status">
      <div aria-hidden>{content}</div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function AppShellBoot({ path }: { path: string }): JSX.Element {
  return (
    <div className="app-shell flex h-screen flex-col">
      <header className="topbar-shell" aria-hidden>
        <div className="brand-home-link">
          <BrandMark className="h-8 w-8" />
          <span className="flex flex-col">
            <span className="font-display text-lg font-semibold leading-none tracking-tight">
              Truenote
            </span>
            <span className="mt-1 text-[9px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
              Sources in view
            </span>
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <div className="skeleton hidden h-4 w-40 sm:block" />
          <div className="skeleton hidden h-5 w-20 rounded-full md:block" />
          <div className="skeleton h-8 w-20 rounded-full" />
        </div>
      </header>
      <div className="relative flex flex-1 overflow-hidden">
        <nav
          aria-hidden
          className="sidebar-shell flex w-16 flex-col p-2 md:w-60 md:p-3"
        >
          <ul className="flex flex-col gap-1">
            {NAV_PLACEHOLDERS.map((item, index) => (
              <li key={item}>
                <div className="sidebar-link flex items-center justify-center gap-2.5 px-2 py-2.5 md:justify-start md:px-3">
                  <span className="sidebar-icon-well">
                    <span className="skeleton block h-[18px] w-[18px]" />
                  </span>
                  <span
                    className={`skeleton hidden h-4 md:block ${
                      index % 2 === 0 ? "w-24" : "w-32"
                    }`}
                  />
                </div>
              </li>
            ))}
          </ul>
        </nav>
        <main className="app-main flex-1 overflow-auto">
          <RouteBoot path={path} />
        </main>
      </div>
    </div>
  );
}
