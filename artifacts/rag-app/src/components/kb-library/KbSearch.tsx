import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Link } from "wouter";
import { ChevronRight, FileText, Lock, MessageSquare, Search, X } from "lucide-react";
import { categoryPathLabel, docCategoryPaths, type KbSearchResults } from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import type { KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { useMediaQuery } from "./useMediaQuery";
import { pathsLabel } from "./KbDocRow";
import { FolderGlyph, StatusPill } from "./KbShared";

/**
 * The way out of a search with no match: ask the question in chat, where
 * Truenote searches inside every source. /chat takes no prefilled question,
 * so the link opens the chat and the user types it there.
 */
export function AskTruenoteLink({ className }: { className?: string }): JSX.Element {
  return (
    <Link
      href="/chat"
      data-kb-ask-truenote
      title="Ask your question in chat. Truenote searches inside every source."
      className={cn("btn-whisper shrink-0 gap-1.5 px-3 py-1.5 text-sm text-foreground", className)}
    >
      <MessageSquare className="h-4 w-4" aria-hidden />
      Ask Truenote instead
    </Link>
  );
}

type Option =
  | { kind: "doc"; doc: KbDocumentListItem; best: boolean }
  | { kind: "folder"; folderId: string }
  | { kind: "all" };

/**
 * The big search box and its grouped results panel (combobox pattern).
 * Typing opens "Best match", "Other sources" and "Folders" under the box;
 * Enter opens the highlighted result (the best match when none is), the
 * arrow keys move through results, Escape closes the panel and keeps the
 * text, and "See all" shows every match in the list below.
 */
export function KbSearch({
  query,
  onQuery,
  results,
  searchRef,
  onOpenDoc,
  onOpenFolder,
  onSeeAll,
  trailing
}: {
  query: string;
  onQuery: (query: string) => void;
  results: KbSearchResults;
  searchRef: RefObject<HTMLInputElement>;
  onOpenDoc: (documentId: string) => void;
  onOpenFolder: (folderId: string) => void;
  onSeeAll: () => void;
  /** The Filters button beside the box. */
  trailing?: ReactNode;
}): JSX.Element {
  const { lookup } = useKbLibraryContext();
  // The full prompt does not fit beside Filters on a phone.
  const roomy = useMediaQuery("(min-width: 640px)");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const hasQuery = query.trim() !== "";
  const showing = open && hasQuery;

  const options: Option[] = [];
  if (results.best) options.push({ kind: "doc", doc: results.best, best: true });
  results.others.forEach((doc) => options.push({ kind: "doc", doc, best: false }));
  results.folders.forEach((f) => options.push({ kind: "folder", folderId: f.node.category.id }));
  if (results.total > 0) options.push({ kind: "all" });
  const optionId = (i: number): string => `${baseId}-opt-${i}`;

  // A new query starts from the top again.
  useEffect(() => setActive(-1), [query]);

  useEffect(() => {
    if (!showing) return;
    function onPointerDown(event: PointerEvent): void {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showing]);

  useEffect(() => {
    if (active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  });

  function choose(option: Option | undefined): void {
    if (!option) return;
    setOpen(false);
    if (option.kind === "doc") onOpenDoc(option.doc.documentId);
    else if (option.kind === "folder") onOpenFolder(option.folderId);
    else onSeeAll();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!hasQuery || options.length === 0) return;
      event.preventDefault();
      if (!showing) {
        setOpen(true);
        setActive(event.key === "ArrowDown" ? 0 : options.length - 1);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((cur) => (cur + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      if (!hasQuery) return;
      event.preventDefault();
      choose(showing && active >= 0 ? options[active] : options[0]);
    } else if (event.key === "Escape") {
      if (showing) {
        event.preventDefault();
        setOpen(false);
        setActive(-1);
      } else if (query) {
        event.preventDefault();
        onQuery("");
      }
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  let index = -1;
  const next = (): number => {
    index += 1;
    return index;
  };

  function docOption(doc: KbDocumentListItem, best: boolean): JSX.Element {
    const i = next();
    const path = pathsLabel(docCategoryPaths(doc, lookup.tree));
    return (
      <li
        key={`doc-${doc.documentId}`}
        id={optionId(i)}
        role="option"
        aria-selected={active === i}
        data-kb-search-option={best ? "best" : "doc"}
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={() => setActive(i)}
        onClick={() => choose({ kind: "doc", doc, best })}
        className={cn(
          "flex cursor-pointer items-center gap-3 rounded-md px-3",
          best ? "flex-wrap gap-y-2 border border-primary/15 bg-primary/5 py-3 sm:flex-nowrap" : "py-2.5",
          active === i && (best ? "ring-2 ring-inset ring-ring" : "bg-muted")
        )}
      >
        <FileText className={cn("hidden shrink-0 text-muted-foreground sm:block", best ? "h-6 w-6" : "h-5 w-5")} aria-hidden />
        <span className={cn("min-w-0 flex-1", best && "max-sm:basis-full")}>
          <span className={cn("block font-medium text-foreground", best ? "text-base" : "text-sm")}>{doc.title}</span>
          <span className="block text-sm text-muted-foreground">{path || "Not in a folder"}</span>
          {best && doc.note ? (
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-foreground">
              <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate">Your note: {doc.note}</span>
            </span>
          ) : null}
        </span>
        {best ? (
          <>
            <span className="hidden sm:inline-flex">
              <StatusPill doc={doc} />
            </span>
            <span aria-hidden className="btn-primary shrink-0 px-5 py-1.5 text-sm">
              Open
            </span>
          </>
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </li>
    );
  }

  return (
    <div ref={wrapRef} className="relative flex items-stretch gap-3">
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground sm:left-4"
          aria-hidden
        />
        <input
          ref={searchRef}
          type="text"
          role="combobox"
          aria-label="Search sources"
          aria-expanded={showing}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showing && active >= 0 ? optionId(active) : undefined}
          data-kb-search
          value={query}
          onChange={(e) => {
            onQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // After Escape the field keeps focus; a click on it brings the results back.
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={roomy ? "Search for a policy or procedure" : "Search sources"}
          title="Searches titles, folder names, tags and your notes. Press / to search from anywhere on this page."
          aria-keyshortcuts="/"
          autoComplete="off"
          spellCheck={false}
          className="h-12 w-full rounded-lg border border-input bg-card pl-10 pr-9 text-base shadow-card sm:pl-12 sm:pr-11 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              onQuery("");
              searchRef.current?.focus();
            }}
            aria-label="Clear search"
            title="Clear search"
            className="btn-icon absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 sm:right-2"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          // The key that jumps here; hovering it says so. The input itself names the shortcut for screen readers.
          <span
            aria-hidden
            data-kb-search-key
            title="Press / to search"
            onMouseDown={(e) => {
              e.preventDefault();
              searchRef.current?.focus();
            }}
            className="absolute right-4 top-1/2 hidden -translate-y-1/2 cursor-text sm:block"
          >
            <kbd className="kbd">/</kbd>
          </span>
        )}
      </div>
      {trailing}

      <p className="sr-only" role="status" aria-live="polite">
        {showing ? `${results.total} ${results.total === 1 ? "source matches" : "sources match"}.` : ""}
      </p>

      {showing ? (
        <div
          data-kb-search-panel
          className="absolute inset-x-0 top-full z-40 mt-2 max-h-[min(36rem,70dvh)] overflow-y-auto rounded-lg border border-border bg-card p-3 shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:[animation-duration:100ms]"
        >
          <ul id={listId} role="listbox" aria-label="Search results" className="flex flex-col">
            {results.best ? (
              <li role="presentation">
                <p id={`${baseId}-best`} className="px-1 pb-1.5 text-sm font-medium text-muted-foreground">
                  Best match
                </p>
                <ul role="group" aria-labelledby={`${baseId}-best`}>
                  {docOption(results.best, true)}
                </ul>
              </li>
            ) : (
              <li role="presentation" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 py-2 text-sm text-muted-foreground">
                <span className="min-w-0 flex-1">No sources match &ldquo;{query.trim()}&rdquo;.</span>
                <AskTruenoteLink />
              </li>
            )}
            {results.others.length > 0 ? (
              <li role="presentation" className="mt-3">
                <p id={`${baseId}-others`} className="px-1 pb-1 text-sm font-medium text-muted-foreground">
                  Other sources
                </p>
                <ul role="group" aria-labelledby={`${baseId}-others`} className="divide-y divide-border">
                  {results.others.map((doc) => docOption(doc, false))}
                </ul>
              </li>
            ) : null}
            {results.folders.length > 0 ? (
              <li role="presentation" className="mt-3">
                <p id={`${baseId}-folders`} className="px-1 pb-1 text-sm font-medium text-muted-foreground">
                  Folders
                </p>
                <ul role="group" aria-labelledby={`${baseId}-folders`} className="divide-y divide-border">
                  {results.folders.map(({ node, count }) => {
                    const i = next();
                    return (
                      <li
                        key={`folder-${node.category.id}`}
                        id={optionId(i)}
                        role="option"
                        aria-selected={active === i}
                        data-kb-search-option="folder"
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseMove={() => setActive(i)}
                        onClick={() => choose({ kind: "folder", folderId: node.category.id })}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5",
                          active === i && "bg-muted"
                        )}
                      >
                        <FolderGlyph className="h-5 w-5" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-foreground">{categoryPathLabel(node)}</span>
                          <span className="block text-sm text-muted-foreground">
                            {count} {count === 1 ? "source" : "sources"}
                          </span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      </li>
                    );
                  })}
                </ul>
              </li>
            ) : null}
            {results.total > 0
              ? (() => {
                  const i = next();
                  return (
                    <li
                      id={optionId(i)}
                      role="option"
                      aria-selected={active === i}
                      data-kb-search-option="all"
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => setActive(i)}
                      onClick={() => choose({ kind: "all" })}
                      className={cn(
                        "mt-2 cursor-pointer rounded-md border-t border-border px-3 py-2.5 text-sm font-medium text-primary",
                        active === i && "bg-muted"
                      )}
                    >
                      See all {results.total} {results.total === 1 ? "result" : "results"}
                    </li>
                  );
                })()
              : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
