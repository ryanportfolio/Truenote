/**
 * Persisted selection of which program a super_user is currently
 * acting on. Stored in localStorage so it survives a logout / re-login
 * cycle on the same device.
 *
 * The stored value is keyed by user id — a different super_user
 * logging in on the same browser doesn't inherit the previous
 * user's selection. We keep one slot (not a per-user map) because
 * (a) device-local state for "the current user" is enough and
 * (b) leaving stale entries around grows unbounded.
 *
 * Non-super_user roles never read or write this — their program is
 * fixed by the DB CHECK constraint. The server-side header resolver
 * silently ignores X-Program-Id for them, so a leaked write here is
 * a no-op, not a security boundary.
 */

const STORAGE_KEY = "kbase:selectedProgram";

interface Stored {
  userId: string;
  programId: string;
}

function readStored(): Stored | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (typeof parsed.userId !== "string" || typeof parsed.programId !== "string") {
      return null;
    }
    return { userId: parsed.userId, programId: parsed.programId };
  } catch {
    return null;
  }
}

/** Returns the selected program for `userId`, or null if none is stored for them. */
export function getSelectedProgramId(userId: string): string | null {
  const stored = readStored();
  if (!stored) return null;
  if (stored.userId !== userId) return null;
  return stored.programId;
}

export function setSelectedProgramId(userId: string, programId: string): void {
  if (typeof window === "undefined") return;
  const value: Stored = { userId, programId };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  // Notify same-tab listeners. The native `storage` event only fires
  // for cross-tab writes; same-tab updates need a manual dispatch so
  // React Query observers can invalidate.
  window.dispatchEvent(new Event(SELECTED_PROGRAM_CHANGED_EVENT));
}

export function clearSelectedProgram(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(SELECTED_PROGRAM_CHANGED_EVENT));
}

/**
 * Read the program id without checking which user it belongs to.
 * Used by the API fetch wrapper, which doesn't know the current
 * user at call time — server-side validation makes the missing
 * cross-check safe: a stale id belonging to a different user is
 * either ignored (non-super_user) or rejected if the program no
 * longer exists.
 */
export function getSelectedProgramIdRaw(): string | null {
  return readStored()?.programId ?? null;
}

/** Same-tab cross-component notification when the selection changes. */
export const SELECTED_PROGRAM_CHANGED_EVENT = "kbase:selected-program-changed";
