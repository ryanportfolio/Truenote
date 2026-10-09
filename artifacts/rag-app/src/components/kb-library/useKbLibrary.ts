import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createKbCategory,
  createKbTag,
  deleteKbCategory,
  deleteKbColorLabel,
  deleteKbTag,
  listKbDocuments,
  reorderKbCategories,
  setKbCategoryColor,
  setKbCategoryDocuments,
  setKbColorLabel,
  setKbDocumentCategories,
  setKbDocumentTags,
  setKbFeatured,
  setKbNote,
  setKbPin,
  setKbSourceColor,
  setKbTeamShortcuts,
  updateKbCategory,
  updateKbTag
} from "@/lib/api";
import {
  applyCategoryDelete,
  applyCategoryMyColor,
  applyColorLabel,
  applyCategoryMembers,
  applyCategoryOrder,
  applyCategoryParent,
  applyCategoryUpsert,
  applyDocumentCategories,
  applyDocumentTags,
  applyFeatured,
  applyPin,
  applySourceColor,
  applyTagDelete,
  applyTeamShortcuts,
  applyTagUpsert,
  applyUserFields,
  buildCategoryTree,
  insertRelative,
  KB_MAX_TEAM_PINS,
  moveItem,
  nestBlockReason,
  siblingIds,
  supervisorPins,
  teamPins
} from "@/lib/kbLibrary";
import { invalidateKbLibraryCache, updateKbLibraryCache, writeKbLibraryCache } from "@/lib/kbLibraryCache";
import { kbColorLabel, kbLabelText } from "@/lib/kbLibraryColors";
import { getSelectedProgramIdRaw } from "@/lib/selectedProgram";
import { createSerialQueue, QueueClosedError, queuedListSaves } from "@/lib/serialQueue";
import type {
  CreateKbCategoryRequest,
  CreateKbTagRequest,
  KbDocumentListResponse,
  KbLibraryColor,
  UpdateKbCategoryRequest,
  UpdateKbTagRequest
} from "@/types/api";

export type ActionResult = { ok: true } | { ok: false; message: string };

type Data = KbDocumentListResponse;

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "That change didn't save. Try again.";
}

/**
 * Library state plus every mutation the Sources page can make. Mutations are
 * optimistic: the local state changes first, then the server call runs. A
 * server answer is applied only when no newer change started since. On
 * failure the previous state comes back when nothing else changed in the
 * meantime, and the list reloads either way: a change made of several
 * requests may have saved some of them.
 * Dialog flows pass `report: false` and show the returned message inline.
 * Every change is written through to the shared library cache under
 * `cacheKey`, so the reader and a return visit see it.
 */
export function useKbLibrary(initial: Data, cacheKey: string) {
  const [data, setData] = useState<Data>(initial);
  const dataRef = useRef<Data>(initial);
  const versionRef = useRef(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const commit = useCallback(
    (next: Data) => {
      dataRef.current = next;
      setData(next);
      updateKbLibraryCache(cacheKey, next);
    },
    [cacheKey]
  );

  const refresh = useCallback(async () => {
    const startedAt = versionRef.current;
    try {
      const response = await listKbDocuments();
      if (response.noProgramSelected || versionRef.current !== startedAt) return;
      writeKbLibraryCache(cacheKey, response);
      commit(response);
    } catch {
      // The visible error from the failed mutation already explains the problem.
    }
  }, [cacheKey, commit]);

  const mutate = useCallback(
    async (
      apply: (d: Data) => Data,
      call: () => Promise<((d: Data) => Data) | void>,
      options: {
        report?: boolean;
        success?: string;
        /** Reloads after a failure in place of `refresh`, e.g. once queued saves have settled. */
        resync?: () => void;
      } = {}
    ): Promise<ActionResult> => {
      const before = dataRef.current;
      const version = ++versionRef.current;
      commit(apply(before));
      if (options.report !== false) setActionError(null);
      try {
        const reconcile = await call();
        // A newer change already set the state it wants; an older answer must not undo it.
        if (reconcile && versionRef.current === version) commit(reconcile(dataRef.current));
        if (options.success) setAnnouncement(options.success);
        return { ok: true };
      } catch (err) {
        if (versionRef.current === version) commit(before);
        if (options.resync) options.resync();
        else void refresh();
        const message = errorMessage(err);
        if (options.report !== false) setActionError(message);
        return { ok: false, message };
      }
    },
    [commit, refresh]
  );

  const find = (documentId: string) =>
    dataRef.current.items.find((d) => d.documentId === documentId);
  const findCategory = (categoryId: string) =>
    dataRef.current.categories.find((c) => c.id === categoryId);

  // Personal ------------------------------------------------------------------

  const togglePin = useCallback(
    (documentId: string) => {
      const doc = dataRef.current.items.find((d) => d.documentId === documentId);
      if (!doc) return;
      const pinned = doc.pinnedAt === null;
      void mutate(
        (d) => applyPin(d, documentId, pinned),
        async () => {
          const state = await setKbPin(documentId, pinned);
          return (d: Data) => applyUserFields(d, documentId, { pinnedAt: state.pinnedAt });
        },
        { success: pinned ? `Added ${doc.title} to your shortcuts.` : `Removed ${doc.title} from your shortcuts.` }
      );
    },
    [mutate]
  );

  const saveNote = useCallback(
    async (documentId: string, note: string): Promise<ActionResult> => {
      try {
        const state = await setKbNote(documentId, note);
        commit(applyUserFields(dataRef.current, documentId, { note: state.note, noteUpdatedAt: state.noteUpdatedAt }));
        setAnnouncement(state.note ? "Note saved." : "Note deleted.");
        return { ok: true };
      } catch (err) {
        return { ok: false, message: errorMessage(err) };
      }
    },
    [commit]
  );

  /** Private color label on a source; null clears it. */
  const setSourceColor = useCallback(
    (documentId: string, color: KbLibraryColor | null) => {
      const doc = dataRef.current.items.find((d) => d.documentId === documentId);
      if (!doc || doc.myColor === color) return;
      void mutate(
        (d) => applySourceColor(d, documentId, color),
        async () => {
          const state = await setKbSourceColor(documentId, color);
          return (d: Data) => applyUserFields(d, documentId, { myColor: state.color });
        },
        {
          success: color
            ? `Labeled ${doc.title} "${kbLabelText(color, dataRef.current.labels)}".`
            : `Removed your label from ${doc.title}.`
        }
      );
    },
    [mutate]
  );

  /** Private override of a category's team color; null goes back to the team color. */
  const setCategoryColor = useCallback(
    (categoryId: string, color: KbLibraryColor | null) => {
      const category = dataRef.current.categories.find((c) => c.id === categoryId);
      if (!category || category.myColor === color) return;
      void mutate(
        (d) => applyCategoryMyColor(d, categoryId, color),
        async () => {
          const item = await setKbCategoryColor(categoryId, color);
          return (d: Data) => applyCategoryMyColor(d, item.categoryId, item.myColor);
        },
        {
          success: color
            ? `You now see ${category.name} in ${kbColorLabel(color)}.`
            : `${category.name} uses the team color again.`
        }
      );
    },
    [mutate]
  );

  /** The user's own name for a label color; an empty name removes it. Personal, so demo accounts may too. */
  const setLabelName = useCallback(
    (color: KbLibraryColor, name: string): Promise<ActionResult> => {
      const trimmed = name.trim();
      const next = trimmed === "" ? null : trimmed;
      const current = (dataRef.current.labels ?? []).find((l) => l.color === color)?.name ?? null;
      if (current === next) return Promise.resolve<ActionResult>({ ok: true });
      return mutate(
        (d) => applyColorLabel(d, color, next),
        async () => {
          const item = await setKbColorLabel(color, next);
          return (d: Data) => applyColorLabel(d, color, item?.name ?? null);
        },
        {
          report: false,
          success: next ? `Saved the label "${next}".` : `Removed the label${current ? ` "${current}"` : ""}.`
        }
      );
    },
    [mutate]
  );

  /** Delete a label everywhere: off every source that has it and its name, in one request. */
  const deleteLabel = useCallback(
    (color: KbLibraryColor): Promise<ActionResult> => {
      const name = (dataRef.current.labels ?? []).find((l) => l.color === color)?.name ?? null;
      const clear = (d: Data): Data =>
        applyColorLabel(
          { ...d, items: d.items.map((item) => (item.myColor === color ? { ...item, myColor: null } : item)) },
          color,
          null
        );
      return mutate(
        clear,
        async () => {
          await deleteKbColorLabel(color);
          return clear;
        },
        { report: false, success: name ? `Deleted the label "${name}".` : "Deleted the label." }
      );
    },
    [mutate]
  );

  // Team pins -----------------------------------------------------------------

  // Each save of a recommended list (here and a supervisor's below) replaces
  // the whole list, so saves go out one at a time in the order made: sent
  // together, an older list could reach the server last and win. The page
  // still updates at once; only the requests wait. The reload after a failure
  // waits in the same queue, so it cannot read the list from before a save
  // still waiting its turn. Sign-out, session expiry and a program switch
  // unmount the page without a reload; saves still waiting then are skipped,
  // since they would go out with the next user's session or program.
  // True while mounted; set in an effect so StrictMode's second mount reopens it.
  const openRef = useRef(true);
  useEffect(() => {
    openRef.current = true;
    return () => {
      openRef.current = false;
    };
  }, []);
  const featuredQueueRef = useRef(createSerialQueue());
  const featuredSaves = useMemo(
    () => queuedListSaves(featuredQueueRef.current, setKbFeatured, refresh, () => openRef.current),
    [refresh]
  );

  const setTeamPins = useCallback(
    (documentIds: string[], success?: string) => {
      // Fixed now: a save that starts while a program switch is still
      // remounting the page writes to the program it was made in.
      const programId = getSelectedProgramIdRaw();
      return mutate(
        (d) => applyFeatured(d, documentIds),
        async () => {
          try {
            await featuredSaves.save(documentIds, programId);
          } catch (err) {
            // Skipped at unmount: the cached library still shows this unsaved
            // list, so drop it and let the next visit load the server's.
            if (err instanceof QueueClosedError) invalidateKbLibraryCache();
            throw err;
          }
          // Puts this list back if a reload put an older one in place, unless a newer change came since.
          return (d: Data) => applyFeatured(d, documentIds);
        },
        { success, resync: () => void featuredSaves.resync() }
      );
    },
    [mutate, featuredSaves]
  );

  const currentTeamPinIds = () => teamPins(dataRef.current.items).map((d) => d.documentId);

  const addTeamPin = useCallback(
    (documentId: string) => {
      const ids = currentTeamPinIds();
      if (ids.includes(documentId)) return;
      if (ids.length >= KB_MAX_TEAM_PINS) {
        setActionError(`You can recommend at most ${KB_MAX_TEAM_PINS} sources to everyone. Stop recommending one first.`);
        return;
      }
      void setTeamPins([...ids, documentId], `Recommended ${find(documentId)?.title ?? "source"} to everyone.`);
    },
    [setTeamPins]
  );

  const removeTeamPin = useCallback(
    (documentId: string) => {
      void setTeamPins(
        currentTeamPinIds().filter((id) => id !== documentId),
        `Stopped recommending ${find(documentId)?.title ?? "source"} to everyone.`
      );
    },
    [setTeamPins]
  );

  const moveTeamPinBy = useCallback(
    (documentId: string, delta: number) => {
      const ids = currentTeamPinIds();
      const from = ids.indexOf(documentId);
      const to = from + delta;
      if (from === -1 || to < 0 || to >= ids.length) return;
      void setTeamPins(moveItem(ids, from, to), `Moved ${find(documentId)?.title ?? "source"} to position ${to + 1}.`);
    },
    [setTeamPins]
  );

  // A supervisor's recommendations to their own team ------------------------------

  // Queued the same way as the program-wide list above.
  const myTeamQueueRef = useRef(createSerialQueue());
  const myTeamSaves = useMemo(
    () => queuedListSaves(myTeamQueueRef.current, setKbTeamShortcuts, refresh, () => openRef.current),
    [refresh]
  );

  const setMyTeamShortcuts = useCallback(
    (documentIds: string[], success?: string) =>
      mutate(
        (d) => applyTeamShortcuts(d, documentIds),
        async () => {
          await myTeamSaves.save(documentIds);
          // Puts this list back if a reload put an older one in place, unless a newer change came since.
          return (d: Data) => applyTeamShortcuts(d, documentIds);
        },
        { success, resync: () => void myTeamSaves.resync() }
      ),
    [mutate, myTeamSaves]
  );

  const currentMyTeamIds = () => supervisorPins(dataRef.current.items).map((d) => d.documentId);

  const addMyTeamPin = useCallback(
    (documentId: string) => {
      const ids = currentMyTeamIds();
      if (ids.includes(documentId)) return;
      if (ids.length >= KB_MAX_TEAM_PINS) {
        setActionError(`You can recommend at most ${KB_MAX_TEAM_PINS} sources to your team. Stop recommending one first.`);
        return;
      }
      void setMyTeamShortcuts(
        [...ids, documentId],
        `Recommended ${find(documentId)?.title ?? "source"} to your team.`
      );
    },
    [setMyTeamShortcuts]
  );

  const removeMyTeamPin = useCallback(
    (documentId: string) => {
      const ids = currentMyTeamIds();
      if (!ids.includes(documentId)) return;
      void setMyTeamShortcuts(
        ids.filter((id) => id !== documentId),
        `Stopped recommending ${find(documentId)?.title ?? "source"} to your team.`
      );
    },
    [setMyTeamShortcuts]
  );

  // Document membership and tags -----------------------------------------------

  const setDocumentCategories = useCallback(
    (documentId: string, categoryIds: string[]) =>
      mutate(
        (d) => applyDocumentCategories(d, documentId, categoryIds),
        () => setKbDocumentCategories(documentId, categoryIds),
        { report: false, success: "Folders saved." }
      ),
    [mutate]
  );

  const setDocumentTags = useCallback(
    (documentId: string, tagIds: string[]) =>
      mutate(
        (d) => applyDocumentTags(d, documentId, tagIds),
        () => setKbDocumentTags(documentId, tagIds),
        { report: false, success: "Tags saved." }
      ),
    [mutate]
  );

  /**
   * Move a document into `toCategoryId` (null = out of `fromCategoryId` only),
   * placed before or after `anchorId`, or at the end when anchorId is null.
   * Dragging within one category reorders it.
   */
  const moveDocument = useCallback(
    (
      documentId: string,
      fromCategoryId: string | null,
      toCategoryId: string | null,
      anchorId: string | null = null,
      place: "before" | "after" = "after"
    ) => {
      const doc = find(documentId);
      const from = fromCategoryId ? findCategory(fromCategoryId) : undefined;
      const to = toCategoryId ? findCategory(toCategoryId) : undefined;
      if (!doc) return;
      if (!to) {
        if (!from) return;
        const remaining = from.documentIds.filter((id) => id !== documentId);
        void mutate(
          (d) => applyCategoryMembers(d, from.id, remaining),
          async () => {
            await setKbCategoryDocuments(from.id, remaining);
          },
          { success: `Removed ${doc.title} from ${from.name}.` }
        );
        return;
      }
      const nextTo = insertRelative(to.documentIds, documentId, anchorId, place);
      const unchanged =
        nextTo.length === to.documentIds.length && nextTo.every((id, i) => id === to.documentIds[i]);
      const leaving = from && from.id !== to.id ? from : undefined;
      if (unchanged && !leaving) return;
      const remaining = leaving ? leaving.documentIds.filter((id) => id !== documentId) : [];
      void mutate(
        (d) => {
          let next = applyCategoryMembers(d, to.id, nextTo);
          if (leaving) next = applyCategoryMembers(next, leaving.id, remaining);
          return next;
        },
        async () => {
          await setKbCategoryDocuments(to.id, nextTo);
          if (leaving) await setKbCategoryDocuments(leaving.id, remaining);
        },
        {
          success:
            leaving || !from
              ? `Moved ${doc.title} to ${to.name}.`
              : `Moved ${doc.title} to position ${nextTo.indexOf(documentId) + 1} in ${to.name}.`
        }
      );
    },
    [mutate]
  );

  const moveDocumentBy = useCallback(
    (documentId: string, categoryId: string, delta: number) => {
      const category = findCategory(categoryId);
      if (!category) return;
      const from = category.documentIds.indexOf(documentId);
      const to = from + delta;
      if (from === -1 || to < 0 || to >= category.documentIds.length) return;
      const anchor = category.documentIds[to] ?? null;
      moveDocument(documentId, categoryId, categoryId, anchor, delta < 0 ? "before" : "after");
    },
    [moveDocument]
  );

  // Categories --------------------------------------------------------------------

  const createCategory = useCallback(
    async (payload: CreateKbCategoryRequest): Promise<ActionResult> => {
      try {
        const item = await createKbCategory(payload);
        versionRef.current += 1;
        commit(applyCategoryUpsert(dataRef.current, item));
        setAnnouncement(`Created folder ${item.name}.`);
        return { ok: true };
      } catch (err) {
        return { ok: false, message: errorMessage(err) };
      }
    },
    [commit]
  );

  const updateCategory = useCallback(
    (categoryId: string, payload: Pick<UpdateKbCategoryRequest, "name" | "color">) => {
      const current = findCategory(categoryId);
      if (!current) return Promise.resolve<ActionResult>({ ok: true });
      return mutate(
        (d) => applyCategoryUpsert(d, { ...current, ...payload }),
        async () => {
          const item = await updateKbCategory(categoryId, payload);
          return (d: Data) => applyCategoryUpsert(d, item);
        },
        { report: false, success: "Folder saved." }
      );
    },
    [mutate]
  );

  const deleteCategory = useCallback(
    (categoryId: string) => {
      const current = findCategory(categoryId);
      if (!current) return;
      void mutate(
        (d) => applyCategoryDelete(d, categoryId),
        () => deleteKbCategory(categoryId),
        { success: `Deleted folder ${current.name}.` }
      );
    },
    [mutate]
  );

  /**
   * Put a category under parentId, before or after anchorId among its new
   * siblings (or last when anchorId is null). A parent change appends on the
   * server, so a reorder call follows only when the target slot is not last.
   */
  const moveCategory = useCallback(
    (
      categoryId: string,
      parentId: string | null,
      anchorId: string | null = null,
      place: "before" | "after" = "after"
    ): void => {
      const current = dataRef.current;
      const category = current.categories.find((c) => c.id === categoryId);
      if (!category) return;
      const reason = nestBlockReason(buildCategoryTree(current.categories), categoryId, parentId);
      if (reason) {
        setActionError(reason);
        return;
      }
      const oldParent = category.parentId ?? null;
      const parentChanged = oldParent !== parentId;
      const siblings = siblingIds(current.categories, parentId);
      const ordered = insertRelative(siblings, categoryId, anchorId, place);
      const sameOrder =
        !parentChanged && ordered.length === siblings.length && ordered.every((id, i) => id === siblings[i]);
      if (sameOrder) return;
      const appended = ordered[ordered.length - 1] === categoryId;
      const parentName = parentId ? current.categories.find((c) => c.id === parentId)?.name : null;
      void mutate(
        (d) => {
          const moved = parentChanged ? applyCategoryParent(d, categoryId, parentId) : d;
          return applyCategoryOrder(moved, ordered);
        },
        async () => {
          if (parentChanged) await updateKbCategory(categoryId, { parentId });
          if (!parentChanged || !appended) await reorderKbCategories(parentId, ordered);
        },
        {
          success: parentChanged
            ? `Moved ${category.name} ${parentName ? `into ${parentName}` : "to the top level"}.`
            : `Moved ${category.name} to position ${ordered.indexOf(categoryId) + 1}.`
        }
      );
    },
    [mutate]
  );

  const moveCategoryBy = useCallback(
    (categoryId: string, delta: number) => {
      const category = findCategory(categoryId);
      if (!category) return;
      const parentId = category.parentId ?? null;
      const siblings = siblingIds(dataRef.current.categories, parentId);
      const from = siblings.indexOf(categoryId);
      const to = from + delta;
      if (from === -1 || to < 0 || to >= siblings.length) return;
      moveCategory(categoryId, parentId, siblings[to] ?? null, delta < 0 ? "before" : "after");
    },
    [moveCategory]
  );

  // Tags ------------------------------------------------------------------------------

  const createTag = useCallback(
    async (payload: CreateKbTagRequest): Promise<ActionResult> => {
      try {
        const item = await createKbTag(payload);
        versionRef.current += 1;
        commit(applyTagUpsert(dataRef.current, item));
        setAnnouncement(`Created tag ${item.name}.`);
        return { ok: true };
      } catch (err) {
        return { ok: false, message: errorMessage(err) };
      }
    },
    [commit]
  );

  const updateTag = useCallback(
    (tagId: string, payload: UpdateKbTagRequest) => {
      const current = dataRef.current.tags.find((t) => t.id === tagId);
      if (!current) return Promise.resolve<ActionResult>({ ok: true });
      return mutate(
        (d) => applyTagUpsert(d, { ...current, ...payload }),
        async () => {
          const item = await updateKbTag(tagId, payload);
          return (d: Data) => applyTagUpsert(d, item);
        },
        { report: false, success: "Tag saved." }
      );
    },
    [mutate]
  );

  const deleteTag = useCallback(
    (tagId: string) => {
      const current = dataRef.current.tags.find((t) => t.id === tagId);
      return mutate(
        (d) => applyTagDelete(d, tagId),
        () => deleteKbTag(tagId),
        { report: false, success: current ? `Deleted tag ${current.name}.` : "Tag deleted." }
      );
    },
    [mutate]
  );

  const actions = useMemo(
    () => ({
      togglePin,
      saveNote,
      setSourceColor,
      setCategoryColor,
      setLabelName,
      deleteLabel,
      setTeamPins,
      addTeamPin,
      removeTeamPin,
      moveTeamPinBy,
      addMyTeamPin,
      removeMyTeamPin,
      setDocumentCategories,
      setDocumentTags,
      moveDocument,
      moveDocumentBy,
      createCategory,
      updateCategory,
      deleteCategory,
      moveCategory,
      moveCategoryBy,
      createTag,
      updateTag,
      deleteTag,
      announce: setAnnouncement,
      reportError: setActionError
    }),
    [
      togglePin,
      saveNote,
      setSourceColor,
      setCategoryColor,
      setLabelName,
      deleteLabel,
      setTeamPins,
      addTeamPin,
      removeTeamPin,
      moveTeamPinBy,
      addMyTeamPin,
      removeMyTeamPin,
      setDocumentCategories,
      setDocumentTags,
      moveDocument,
      moveDocumentBy,
      createCategory,
      updateCategory,
      deleteCategory,
      moveCategory,
      moveCategoryBy,
      createTag,
      updateTag,
      deleteTag
    ]
  );

  return {
    data,
    actionError,
    clearActionError: () => setActionError(null),
    announcement,
    actions
  };
}

export type KbLibraryActions = ReturnType<typeof useKbLibrary>["actions"];
