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

export interface KbLibraryContextValue {
  data: KbDocumentListResponse;
  lookup: KbLookup;
  actions: KbLibraryActions;
  canOrganize: boolean;
  openDialog: (dialog: KbDialogState) => void;
}

export const KbLibraryContext = createContext<KbLibraryContextValue | null>(null);

export function useKbLibraryContext(): KbLibraryContextValue {
  const value = useContext(KbLibraryContext);
  if (!value) throw new Error("useKbLibraryContext must be used inside KbLibrary");
  return value;
}
