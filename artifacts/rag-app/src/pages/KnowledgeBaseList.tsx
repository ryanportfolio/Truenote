import { useEffect, useState } from "react";
import { Link } from "wouter";
import { BookOpen, Search } from "lucide-react";
import { listKbDocuments } from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import {
  getSelectedProgramOwnerIdRaw,
  SELECTED_PROGRAM_CHANGED_EVENT
} from "@/lib/selectedProgram";
import type {
  CurrentUser,
  KbDocumentListItem,
  KbDocumentListResponse
} from "@/types/api";

/**
 * CSR-facing knowledge base. The list is every live (active + parsed)
 * document in the CSR's program; each opens as a full rendered read.
 * This is the same corpus answers are grounded in — a citation's
 * "read the full document" link lands here.
 */

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "no-program" }
  | { status: "ready"; items: KbDocumentListItem[] };

interface PrefetchedList {
  ownerUserId: string | null;
  request: Promise<KbDocumentListResponse>;
}

let prefetchedList: PrefetchedList | null = null;

export function preloadKnowledgeBaseDocuments(): void {
  if (prefetchedList) return;
  const request = listKbDocuments();
  prefetchedList = {
    ownerUserId: getSelectedProgramOwnerIdRaw(),
    request
  };
  // The mounted page owns visible error handling. This prevents an unhandled
  // rejection if auth fails and the protected page never mounts.
  void request.catch(() => undefined);
}

function takeInitialRequest(user: CurrentUser): Promise<KbDocumentListResponse> {
  const prefetched = prefetchedList;
  prefetchedList = null;
  if (!prefetched) return listKbDocuments();

  // Non-super-users ignore X-Program-Id server-side. For super-users, only
  // consume a response requested with a selection owned by this exact user.
  if (user.role === "super_user" && prefetched.ownerUserId !== user.id) {
    return listKbDocuments();
  }
  return prefetched.request;
}

export function KnowledgeBasePage({ user }: { user: CurrentUser }): JSX.Element {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    let firstLoad = true;
    async function load(): Promise<void> {
      setState({ status: "loading" });
      try {
        const response = firstLoad
          ? await takeInitialRequest(user)
          : await listKbDocuments();
        firstLoad = false;
        if (cancelled) return;
        if (response.noProgramSelected) {
          setState({ status: "no-program" });
        } else {
          setState({ status: "ready", items: response.items });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Failed to load documents"
          });
        }
      }
    }
    void load();
    // Super_user program switch changes the corpus — reload in place.
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, load as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, load as EventListener);
    };
  }, [user]);

  const filtered =
    state.status === "ready"
      ? state.items.filter((d) =>
          d.title.toLowerCase().includes(query.trim().toLowerCase())
        )
      : [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Knowledge base</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every live document answers are grounded in. Open one to read it in full.
        </p>
      </header>

      {state.status === "loading" ? (
        <div className="flex flex-col gap-2" aria-hidden>
          <div className="skeleton h-12 w-full rounded-lg" />
          <div className="skeleton h-12 w-full rounded-lg" />
          <div className="skeleton h-12 w-3/4 rounded-lg" />
        </div>
      ) : null}

      {state.status === "error" ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {state.message}
        </p>
      ) : null}

      {state.status === "no-program" ? (
        <div
          role="status"
          className="rounded-lg border border-dashed border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
        >
          Select a program from the picker in the header to browse its knowledge base.
        </div>
      ) : null}

      {state.status === "ready" && state.items.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No documents yet"
          hint="When admins upload and publish documents for your program, they appear here."
        />
      ) : null}

      {state.status === "ready" && state.items.length > 0 ? (
        <>
          <label className="relative block">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <span className="sr-only">Filter documents by title</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by title…"
              className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-sm shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </label>
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No titles match “{query.trim()}”.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card">
              {filtered.map((doc) => (
                <li key={doc.documentId}>
                  <Link
                    href={`/kb/${doc.documentId}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-100 ease-out hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="text-sm font-medium">{doc.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {doc.updatedAt ? <RelativeTime iso={doc.updatedAt} /> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
