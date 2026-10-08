import { useCallback, useEffect, useRef, useState } from "react";
import { assignTeam, fetchTeams } from "@/lib/api";
import { SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";
import {
  applyMove,
  assignmentChunks,
  idsToMove,
  moveAnnouncement,
  storageChangeReloads,
  teamLabel
} from "@/lib/teamsView";
import type { TeamsCsr, TeamsResponse } from "@/types/api";

export interface TeamsState {
  data: TeamsResponse | null;
  loading: boolean;
  /** The page could not load. */
  loadError: string | null;
  /** The last move failed; the server's message (e.g. the demo-account refusal). */
  actionError: string | null;
  /** Polite live-region text for the last move. */
  announcement: string;
  /** Bumps when the data is reloaded from scratch (program switch), so selections reset. */
  generation: number;
  /**
   * Move CSRs onto a supervisor's team, or to Unassigned with null. Every
   * path (drag, Move to, per-row select, bulk assign) goes through here.
   * Resolves true when the server accepted the move (or nothing needed to move).
   */
  move: (csrIds: readonly string[], supervisorId: string | null) => Promise<boolean>;
  dismissActionError: () => void;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Teams data plus the one mutation. A move updates the page at once,
 * then replaces the CSR list with the server's answer; a failure puts the
 * snapshot back (or, when part of a big move already landed, the server's
 * last answer) and shows the server's message. Same shape as the
 * library's `mutate` (useKbLibrary.ts): a newer move wins over an older
 * answer, and a failure behind a newer move reloads instead of rolling back.
 */
export function useTeams(): TeamsState {
  const [data, setData] = useState<TeamsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [generation, setGeneration] = useState(0);
  const dataRef = useRef<TeamsResponse | null>(null);
  const versionRef = useRef(0);
  const loadRef = useRef(0);

  const commit = useCallback((next: TeamsResponse | null) => {
    dataRef.current = next;
    setData(next);
  }, []);

  const load = useCallback(
    async (quiet: boolean): Promise<void> => {
      const ticket = ++loadRef.current;
      const version = versionRef.current;
      if (!quiet) setLoadError(null);
      try {
        const response = await fetchTeams();
        // A newer load, or a move made while this one was in flight, owns the state now.
        if (ticket !== loadRef.current || (quiet && version !== versionRef.current)) return;
        commit(response);
        setLoadError(null);
      } catch (err) {
        if (ticket !== loadRef.current || quiet) return;
        commit(null);
        setLoadError(errorText(err, "Could not load teams."));
      } finally {
        if (ticket === loadRef.current) setLoading(false);
      }
    },
    [commit]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // A super_user switching program (this tab or another) reloads the page.
  useEffect(() => {
    function reload(): void {
      versionRef.current += 1;
      setLoading(true);
      setActionError(null);
      setGeneration((n) => n + 1);
      void load(false);
    }
    // Other tabs write other keys too (saved views); only a program change reloads.
    function onStorage(event: StorageEvent): void {
      if (storageChangeReloads(event.key)) reload();
    }
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, [load]);

  const say = useCallback((text: string) => {
    // Clear first so the same sentence twice in a row is still spoken.
    setAnnouncement("");
    window.requestAnimationFrame(() => setAnnouncement(text));
  }, []);

  const move = useCallback(
    async (csrIds: readonly string[], supervisorId: string | null): Promise<boolean> => {
      const before = dataRef.current;
      if (!before) return false;
      const supervisor = supervisorId ? before.supervisors.find((s) => s.id === supervisorId) ?? null : null;
      if (supervisorId && !supervisor) return false;
      const ids = idsToMove(before.csrs, csrIds, supervisorId);
      if (ids.length === 0) {
        say(supervisor ? `Already on ${teamLabel(supervisor.name)}.` : "Already unassigned.");
        return true;
      }
      const names = ids.map((id) => before.csrs.find((c) => c.id === id)?.name ?? "Someone");
      const version = ++versionRef.current;
      commit({ ...before, csrs: applyMove(before.csrs, ids, supervisorId) });
      setActionError(null);
      // The server takes a limited number of ids per request; big moves go in order, one request at a time.
      const chunks = assignmentChunks(ids);
      // The server's CSR list after the last request it accepted.
      let saved: TeamsCsr[] | null = null;
      let moved = 0;
      try {
        for (const chunk of chunks) {
          saved = (await assignTeam(chunk, supervisorId)).csrs;
          moved += chunk.length;
        }
        // A newer move already set the state it wants; an older answer must not undo it.
        // A multi-request move may have landed after that newer move's answer, so re-sync.
        const current = dataRef.current;
        if (versionRef.current === version) {
          if (current && saved) commit({ ...current, csrs: saved });
        } else if (chunks.length > 1) {
          void load(true);
        }
        say(moveAnnouncement(names, supervisor));
        return true;
      } catch (err) {
        // Some requests may have landed: show the server's last answer, never the stale snapshot.
        const current = dataRef.current;
        if (versionRef.current !== version) void load(true);
        else if (saved && current) commit({ ...current, csrs: saved });
        else commit(before);
        setActionError(
          moved > 0
            ? `Moved ${moved} of ${ids.length} people. ${errorText(err, "Could not move the rest.")}`
            : errorText(err, "Could not move them. Nothing changed.")
        );
        return false;
      }
    },
    [commit, load, say]
  );

  const dismissActionError = useCallback(() => setActionError(null), []);

  return { data, loading, loadError, actionError, announcement, generation, move, dismissActionError };
}
