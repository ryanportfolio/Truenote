import { useEffect, useState } from "react";
import { listKbDocuments } from "@/lib/api";
import { KbLibrary } from "@/components/kb-library/KbLibrary";
import {
  adoptKbLibraryRequest,
  kbLibraryCacheKey,
  loadKbLibrary,
  readKbLibraryCache
} from "@/lib/kbLibraryCache";
import {
  getSelectedProgramOwnerIdRaw,
  SELECTED_PROGRAM_CHANGED_EVENT
} from "@/lib/selectedProgram";
import type { CurrentUser, KbDocumentListResponse } from "@/types/api";

/**
 * CSR-facing knowledge base. The list is every live (active + parsed)
 * document in the CSR's program; each opens as a full rendered read.
 * This is the same corpus answers are grounded in — a citation's
 * "read the full document" link lands here. The library UI (pins, notes,
 * views, manager organization) lives in components/kb-library.
 */

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "no-program" }
  | { status: "ready"; response: KbDocumentListResponse; loadId: number };

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

/**
 * The first library load: the speculative prefetch when it was made for this
 * user, else the shared cache's request (lib/kbLibraryCache dedupes a request
 * already in flight, such as the reader's or a StrictMode re-run's).
 */
function takeInitialRequest(user: CurrentUser, key: string): Promise<KbDocumentListResponse> {
  const prefetched = prefetchedList;
  prefetchedList = null;
  if (!prefetched) return loadKbLibrary(key);

  // Non-super-users ignore X-Program-Id server-side. For super-users, only
  // consume a response requested with a selection owned by this exact user.
  if (user.role === "super_user" && prefetched.ownerUserId !== user.id) {
    return loadKbLibrary(key);
  }
  return adoptKbLibraryRequest(key, prefetched.request);
}

export function KnowledgeBasePage({ user }: { user: CurrentUser }): JSX.Element {
  // Coming back from a source within a minute reuses the library the reader
  // or this page already loaded (lib/kbLibraryCache), so there is no skeleton.
  const [state, setState] = useState<ListState>(() => {
    const cached = readKbLibraryCache(kbLibraryCacheKey(user.id));
    return cached ? { status: "ready", response: cached, loadId: 0 } : { status: "loading" };
  });

  useEffect(() => {
    let cancelled = false;
    let firstLoad = true;
    let loadId = 0;
    async function load(): Promise<void> {
      loadId += 1;
      const thisLoad = loadId;
      const key = kbLibraryCacheKey(user.id);
      if (firstLoad) {
        const cached = readKbLibraryCache(key);
        if (cached) {
          firstLoad = false;
          // A speculative prefetch made before the cache was filled is stale now.
          prefetchedList = null;
          setState((prev) =>
            prev.status === "ready" && prev.response === cached
              ? prev
              : { status: "ready", response: cached, loadId: thisLoad }
          );
          return;
        }
      }
      setState({ status: "loading" });
      try {
        // A program switch always asks the server again.
        const response = firstLoad
          ? await takeInitialRequest(user, key)
          : await adoptKbLibraryRequest(key, listKbDocuments());
        firstLoad = false;
        if (cancelled || thisLoad !== loadId) return;
        if (response.noProgramSelected) {
          setState({ status: "no-program" });
        } else {
          setState({ status: "ready", response, loadId: thisLoad });
        }
      } catch (err) {
        if (!cancelled && thisLoad === loadId) {
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

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6 xl:max-w-6xl">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Sources</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Documents used to answer questions. Pin the ones you use most, or open one to read it in full.
        </p>
      </header>

      {state.status === "loading" ? (
        <div role="status">
          <div className="flex flex-col gap-5" aria-hidden>
            <div className="skeleton h-[38px] w-full rounded-md" />
            <div className="flex gap-2">
              <div className="skeleton h-7 w-56 rounded-full" />
              <div className="skeleton h-7 w-36 rounded-full" />
            </div>
            <div className="rounded-lg border border-border bg-card shadow-card">
              <div className="border-b border-border px-4 py-3">
                <div className="skeleton h-4 w-2/3" />
              </div>
              <div className="border-b border-border px-4 py-3">
                <div className="skeleton h-4 w-1/2" />
              </div>
              <div className="px-4 py-3">
                <div className="skeleton h-4 w-3/5" />
              </div>
            </div>
          </div>
          <span className="sr-only">Loading…</span>
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
          Choose a program to browse its documents.
        </div>
      ) : null}

      {state.status === "ready" ? (
        <KbLibrary
          key={state.loadId}
          user={user}
          initial={state.response}
          cacheKey={kbLibraryCacheKey(user.id)}
        />
      ) : null}
    </div>
  );
}
