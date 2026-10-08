import { createContext, useContext } from "react";
import type { KbLookup } from "@/lib/kbLibrary";
import type { KbDocumentListResponse } from "@/types/api";
import type { KbLibraryActions } from "./useKbLibrary";

export type KbDialogState =
  | { kind: "note"; documentId: string }
  | { kind: "doc-categories"; documentId: string }
  | { kind: "doc-tags"; documentId: string }
  | { kind: "manage-tags"; returnTo?: KbDialogState }
  | { kind: "category-create"; parentId: string | null; returnTo?: KbDialogState }
  | { kind: "category-edit"; categoryId: string }
  | { kind: "category-move"; categoryId: string }
  | { kind: "doc-move"; documentId: string; fromCategoryId: string | null };

/** List view on wide screens: rows get a "Quick look" button that previews the source beside the list. */
export interface KbQuickLook {
  /** The source shown in the pane, or null when the pane shows its hint. */
  documentId: string | null;
  paneId: string;
  toggle: (documentId: string) => void;
}

export interface KbLibraryContextValue {
  data: KbDocumentListResponse;
  lookup: KbLookup;
  actions: KbLibraryActions;
  canOrganize: boolean;
  openDialog: (dialog: KbDialogState) => void;
  /** Null unless the quick-look pane is available (List view, 1440px and wider). */
  quickLook: KbQuickLook | null;
}

export const KbLibraryContext = createContext<KbLibraryContextValue | null>(null);

export function useKbLibraryContext(): KbLibraryContextValue {
  const value = useContext(KbLibraryContext);
  if (!value) throw new Error("useKbLibraryContext must be used inside KbLibrary");
  return value;
}
