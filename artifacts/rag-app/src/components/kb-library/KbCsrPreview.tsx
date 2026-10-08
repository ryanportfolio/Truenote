import { FileText, Megaphone } from "lucide-react";
import { docCategoryPaths, sortDocs, teamPins, type KbCategoryNode } from "@/lib/kbLibrary";
import type { KbDocumentListItem } from "@/types/api";
import { CountLabel } from "./KbBrowseViews";
import { useKbLibraryContext } from "./KbContext";
import { pathsLabel } from "./KbDocRow";
import { ColorDot, NewBadge } from "./KbShared";

function PreviewDoc({ doc }: { doc: KbDocumentListItem }): JSX.Element {
  return (
    <li className="flex min-w-0 items-center gap-1.5 py-0.5 text-sm text-foreground">
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate" title={doc.title}>
        {doc.title}
      </span>
      {doc.isNew ? <NewBadge /> : null}
    </li>
  );
}

function PreviewNode({
  node,
  byId
}: {
  node: KbCategoryNode;
  byId: Map<string, KbDocumentListItem>;
}): JSX.Element {
  const docs = node.category.documentIds
    .map((id) => byId.get(id))
    .filter((d): d is KbDocumentListItem => Boolean(d));
  let count = 0;
  const walk = (n: KbCategoryNode): void => {
    n.category.documentIds.forEach((id) => {
      if (byId.has(id)) count += 1;
    });
    n.children.forEach(walk);
  };
  walk(node);
  return (
    <li>
      <p className="flex min-w-0 items-center gap-2 py-0.5 text-sm font-medium">
        {/* Team color only: a CSR sees the manager's color, not this manager's private one. */}
        <ColorDot color={node.category.color} />
        <span className="min-w-0 truncate">{node.category.name}</span>
        <CountLabel count={count} />
      </p>
      {node.children.length > 0 || docs.length > 0 ? (
        <ul className="ml-1.5 border-l border-border pl-3">
          {node.children.map((child) => (
            <PreviewNode key={child.category.id} node={child} byId={byId} />
          ))}
          {docs.map((doc) => (
            <PreviewDoc key={doc.documentId} doc={doc} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Organize mode: the library as a CSR in this program first sees it, built
 * from the same state the editor changes, so it follows every move. Team pins
 * in order, then the folders in the manager's order with team colors. The
 * manager's own pins, notes and colors are left out.
 */
export function KbCsrPreview({ onBack }: { onBack?: () => void }): JSX.Element {
  const { data, lookup } = useKbLibraryContext();
  const team = teamPins(data.items);
  const byId = new Map(data.items.map((d) => [d.documentId, d]));
  const loose = sortDocs(
    data.items.filter((d) => !d.categoryIds.some((id) => lookup.tree.byId.has(id))),
    "title"
  );
  return (
    <section
      aria-labelledby="kb-csr-preview"
      data-kb-csr-preview
      className="min-w-0 rounded-lg border border-border bg-card p-4 shadow-card xl:sticky xl:top-4 xl:max-h-[calc(100dvh-7rem)] xl:overflow-y-auto"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="kb-csr-preview" className="font-display text-lg font-semibold tracking-tight">
          What CSRs will see
        </h2>
        <span className="rounded-full border border-primary/25 bg-primary/5 px-2 py-0.5 text-xs font-medium text-primary">
          Live preview
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Updates as you organize. Your own pins, notes and colors are left out; each CSR adds their own. A CSR only
        sees sources their clearance allows, so some counts can be lower for them.
      </p>
      {onBack ? (
        <button type="button" onClick={onBack} className="btn-whisper mt-2 px-3 py-1 text-xs">
          Back to organizing
        </button>
      ) : null}

      <div className="mt-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-primary">
          <Megaphone className="h-3.5 w-3.5" aria-hidden />
          Team pins
        </p>
        {team.length > 0 ? (
          <ol aria-label="Team pins as CSRs see them" className="mt-1 flex flex-col gap-1">
            {team.map((doc, i) => {
              const path = pathsLabel(docCategoryPaths(doc, lookup.tree));
              return (
                <li key={doc.documentId} className="flex min-w-0 items-baseline gap-2 text-sm">
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="font-medium text-primary">{doc.title}</span>
                    {path ? <span className="block truncate text-xs text-muted-foreground">{path}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No team pins. CSRs see their own pins first.</p>
        )}
      </div>

      <ul aria-label="Folders as CSRs see them" className="mt-3 flex flex-col gap-1">
        {lookup.tree.roots.map((node) => (
          <PreviewNode key={node.category.id} node={node} byId={byId} />
        ))}
        {loose.length > 0 ? (
          <li>
            <p className="flex min-w-0 items-center gap-2 py-0.5 text-sm font-medium text-muted-foreground">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-dashed border-muted-foreground" aria-hidden />
              Not in a category
              <CountLabel count={loose.length} />
            </p>
            <ul className="ml-1.5 border-l border-border pl-3">
              {loose.map((doc) => (
                <PreviewDoc key={doc.documentId} doc={doc} />
              ))}
            </ul>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
