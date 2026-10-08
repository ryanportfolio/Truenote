import { listKbDocuments } from "./api";
import { getSelectedProgramId } from "./selectedProgram";
import type { KbDocumentListResponse } from "@/types/api";

/**
 * One shared copy of the Sources library (GET /api/kb/documents) for the
 * Sources page and the reader, so opening a source does not re-run the
 * library query with its view and citation counts. Kept in memory for this
 * tab only, keyed by user and selected program so one person's library is
 * never shown to another after a sign-out and sign-in. The Sources page
 * writes its own changes through (updateKbLibraryCache); the reader patches
 * the cached copy when it pins, colors, notes or opens a source.
 */

type Data = KbDocumentListResponse;

/** Counts and "recently opened" may lag this long behind the server. */
export const KB_LIBRARY_CACHE_TTL_MS = 60_000;

interface Entry {
  key: string;
  /** When the server answered; local edits don't extend it. */
  fetchedAt: number;
  data: Data | null;
  request: Promise<Data> | null;
}

let entry: Entry | null = null;

export function kbLibraryCacheKey(userId: string): string {
  return `${userId}:${getSelectedProgramId(userId) ?? ""}`;
}

function fresh(key: string): Entry | null {
  if (!entry || entry.key !== key || !entry.data) return null;
  return Date.now() - entry.fetchedAt <= KB_LIBRARY_CACHE_TTL_MS ? entry : null;
}

/** The cached library for this key, or null when there is none or it is too old. */
export function readKbLibraryCache(key: string): Data | null {
  return fresh(key)?.data ?? null;
}

/** Store a library the server just returned. A no-program answer is never cached. */
export function writeKbLibraryCache(key: string, data: Data): void {
  if (data.noProgramSelected) return;
  entry = { key, fetchedAt: Date.now(), data, request: null };
}

/** Replace the cached data after a local change, keeping its age. */
export function updateKbLibraryCache(key: string, data: Data): void {
  if (entry && entry.key === key && entry.data) entry = { ...entry, data };
}

/**
 * The key of the library cached right now, or null. A change that finishes
 * later reads this when it starts and passes it to patchKbLibraryCache, so it
 * never lands in a library that was replaced in the meantime (another user
 * signed in, or the program changed).
 */
export function currentKbLibraryCacheKey(): string | null {
  return entry?.data ? entry.key : null;
}

/** Apply a change to the cached library when it still belongs to `key` (used by the reader). */
export function patchKbLibraryCache(key: string | null, apply: (data: Data) => Data): void {
  if (key !== null && entry?.data && entry.key === key) entry = { ...entry, data: apply(entry.data) };
}

export function invalidateKbLibraryCache(): void {
  entry = null;
}

/**
 * Track a library request already made for this key (the Sources page's
 * speculative prefetch), so other callers share it and its answer is cached.
 */
export function adoptKbLibraryRequest(key: string, request: Promise<Data>): Promise<Data> {
  const tracked = request.then(
    (data) => {
      if (entry?.request === tracked) entry = null;
      writeKbLibraryCache(key, data);
      return data;
    },
    (err: unknown) => {
      if (entry?.request === tracked) entry = null;
      throw err;
    }
  );
  entry = { key, fetchedAt: 0, data: null, request: tracked };
  return tracked;
}

/**
 * The library for this key: the cached copy when fresh, the request already
 * in flight for it, or a new request whose answer is cached.
 */
export function loadKbLibrary(key: string): Promise<Data> {
  const hit = fresh(key);
  if (hit?.data) return Promise.resolve(hit.data);
  if (entry && entry.key === key && entry.request) return entry.request;
  return adoptKbLibraryRequest(key, listKbDocuments());
}
