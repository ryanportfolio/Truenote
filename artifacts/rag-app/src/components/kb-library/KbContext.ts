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
  | { kind: "doc-move"; documentId: string; fromCategoryId: string | null }
  /** Name a new label; with a source, the label is applied to it too. */
  | { kind: "label-create"; documentId: string | null };

export interface KbLibraryContextValue {
  data: KbDocumentListResponse;
  lookup: KbLookup;
  actions: KbLibraryActions;
  canOrganize: boolean;
  openDialog: (dialog: KbDialogState) => void;
  /** Organize: note the item about to move ("doc:<id>" or "cat:<id>") so the live preview can point at it. */
  markMoved: (key: string) => void;
  /** The three most opened sources of the whole library this user can see; their rows say "Used often". */
  usedOften: Set<string>;
}

export const KbLibraryContext = createContext<KbLibraryContextValue | null>(null);

export function useKbLibraryContext(): KbLibraryContextValue {
  const value = useContext(KbLibraryContext);
  if (!value) throw new Error("useKbLibraryContext must be used inside KbLibrary");
  return value;
}
