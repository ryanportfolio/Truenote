import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ChevronDown, FileText, Lock, Search } from "lucide-react";
import { listDocuments } from "@/lib/api";
import { docsWithoutFolder, sortDocs, teamPins, type KbCategoryNode } from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import type { Classification, KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { FolderGlyph } from "./KbShared";

/** How long the just-moved item stays highlighted. */
const FLASH_MS = 2500;

/**
 * Classifications above "internal" are open only to people with a higher
 * clearance, so part of the team may not see those sources.
 */
const LIMITED: ReadonlySet<Classification> = new Set<Classification>(["confidential", "restricted"]);

const LIMITED_TEXT = "Only some people can see this";

/** Ids of the sources only some of the team can see; empty until loaded (or when the list cannot load). */
const LimitedContext = createContext<ReadonlySet<string>>(new Set());

/**
 * The manager's document list carries each source's classification (the
 * Sources list does not). If it cannot load, nothing is marked.
 */
function useLimitedSources(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    listDocuments()
      .then((res) => {
        if (cancelled) return;
        setIds(new Set(res.items.filter((d) => LIMITED.has(d.classification)).map((d) => d.documentId)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return ids;
}

function PreviewDoc({ doc, flash }: { doc: KbDocumentListItem; flash: string | null }): JSX.Element {
  const on = flash === `doc:${doc.documentId}`;
  const limited = useContext(LimitedContext).has(doc.documentId);
  return (
    <li
      data-kb-preview-item={`doc:${doc.documentId}`}
      data-kb-preview-moved={on || undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm text-foreground motion-safe:transition-colors motion-safe:duration-240",
        on && "bg-primary/10 ring-1 ring-primary/30"
      )}
    >
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate" title={limited ? `${doc.title}. ${LIMITED_TEXT}.` : doc.title}>
        {doc.title}
      </span>
      {limited ? (
        <span data-kb-preview-restricted title={LIMITED_TEXT} className="ml-auto inline-flex shrink-0 text-muted-foreground">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">({LIMITED_TEXT})</span>
        </span>
      ) : null}
      {on ? <span className="sr-only">(just moved)</span> : null}
    </li>
  );
}

function PreviewNode({
  node,
  byId,
  flash
}: {
  node: KbCategoryNode;
  byId: Map<string, KbDocumentListItem>;
  flash: string | null;
}): JSX.Element {
  const docs = node.category.documentIds
    .map((id) => byId.get(id))
    .filter((d): d is KbDocumentListItem => Boolean(d));
  const on = flash === `cat:${node.category.id}`;
  return (
    <li>
      <p
        data-kb-preview-item={`cat:${node.category.id}`}
        data-kb-preview-moved={on || undefined}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm font-medium motion-safe:transition-colors motion-safe:duration-240",
          on && "bg-primary/10 ring-1 ring-primary/30"
        )}
      >
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {/* Team color only: the team sees the manager's color, not this manager's private one. */}
        <FolderGlyph className="h-4 w-4" />
        <span className="min-w-0 truncate">{node.category.name}</span>
        {on ? <span className="sr-only">(just moved)</span> : null}
      </p>
      {node.children.length > 0 || docs.length > 0 ? (
        <ul className="ml-4">
          {node.children.map((child) => (
            <PreviewNode key={child.category.id} node={child} byId={byId} flash={flash} />
          ))}
          {docs.map((doc) => (
            <PreviewDoc key={doc.documentId} doc={doc} flash={flash} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Organize: a small copy of the Sources page as the team sees it, built from
 * the same state the editor changes, so it follows every move and points at
 * the item just moved. Team shortcuts in order, then the folders in the
 * manager's order with team colors. The manager's own shortcuts, notes and
 * labels are left out.
 */
export function KbCsrPreview({
  onBack,
  lastMoved = null
}: {
  onBack?: () => void;
  lastMoved?: { key: string; at: number } | null;
}): JSX.Element {
  const { data, lookup } = useKbLibraryContext();
  const team = teamPins(data.items);
  const byId = new Map(data.items.map((d) => [d.documentId, d]));
  const loose = sortDocs(docsWithoutFolder(data.items, lookup.tree), "title");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const limited = useLimitedSources();

  useEffect(() => {
    if (!lastMoved) return;
    setFlash(lastMoved.key);
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [lastMoved]);

  // Bring the moved item into view inside the preview only, never scrolling the page.
  useEffect(() => {
    const box = scrollRef.current;
    if (!flash || !box) return;
    const el = box.querySelector<HTMLElement>(`[data-kb-preview-item="${CSS.escape(flash)}"]`);
    if (!el) return;
    const boxRect = box.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    if (rect.top < boxRect.top || rect.bottom > boxRect.bottom) {
      box.scrollTop += rect.top - boxRect.top - boxRect.height / 3;
    }
  }, [flash, data]);

  return (
    <LimitedContext.Provider value={limited}>
      <section
        aria-labelledby="kb-csr-preview"
        data-kb-csr-preview
        className="min-w-0 rounded-lg border border-border bg-card p-5 shadow-card xl:sticky xl:top-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="kb-csr-preview" className="text-lg font-semibold tracking-tight">
            What your team will see
          </h3>
          <span data-kb-live-preview className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <span aria-hidden className="h-2 w-2 rounded-full bg-primary" />
            Live preview
          </span>
        </div>
        {onBack ? (
          <button type="button" onClick={onBack} className="btn-whisper mt-2 px-3 py-1 text-sm">
            Back to organizing
          </button>
        ) : null}

        <div
          ref={scrollRef}
          aria-label="Sources as your team sees them"
          role="group"
          className="mt-3 rounded-lg border border-border bg-background/40 p-4 xl:max-h-[calc(100dvh-12rem)] xl:overflow-y-auto"
        >
          <p className="font-display text-2xl font-semibold tracking-tight">Sources</p>
          <div
            aria-hidden
            className="mt-2 flex items-center gap-2 rounded-md border border-input bg-card px-3 py-2 text-sm text-muted-foreground"
          >
            <Search className="h-4 w-4" />
            Find a source
          </div>

          <p className="mt-4 text-sm font-medium">Team shortcuts</p>
          {team.length > 0 ? (
            <ol aria-label="Team shortcuts as your team sees them" className="mt-1 flex flex-col">
              {team.map((doc) => (
                <PreviewDoc key={doc.documentId} doc={doc} flash={flash} />
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">None yet. Your team sees their own shortcuts first.</p>
          )}

          <ul aria-label="Folders as your team sees them" className="mt-3 flex flex-col border-t border-border pt-3">
            {lookup.tree.roots.map((node) => (
              <PreviewNode key={node.category.id} node={node} byId={byId} flash={flash} />
            ))}
            {loose.length > 0 ? (
              <li>
                <p className="flex min-w-0 items-center gap-2 px-2 py-1 text-sm font-medium text-muted-foreground">
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <FolderGlyph className="h-4 w-4" />
                  Not in a folder
                </p>
                <ul className="ml-4">
                  {loose.map((doc) => (
                    <PreviewDoc key={doc.documentId} doc={doc} flash={flash} />
                  ))}
                </ul>
              </li>
            ) : null}
          </ul>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Each person also sees their own shortcuts, notes and labels.
          {limited.size > 0 ? (
            <>
              {" "}
              <Lock className="inline h-3 w-3 align-[-1px]" aria-hidden /> marks a source only some people can see; the
              others never see it, so their counts can be lower.
            </>
          ) : (
            " Someone who can't open a source never sees it, so their counts can be lower."
          )}
        </p>
      </section>
    </LimitedContext.Provider>
  );
}
