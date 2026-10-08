/** Runs tasks handed to it one at a time, in the order given. */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A queue for changes saved one request at a time: each task starts only
 * after every earlier task has settled, whether it resolved or rejected, so
 * the server applies changes in the order they were made and the last answer
 * includes them all. The returned promise settles with the task's own result.
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    // A rejected task must not stop the ones queued behind it.
    tail = run.catch(() => undefined);
    return run;
  };
}

/** The rejection of a queued task that never started because its page had closed. */
export class QueueClosedError extends Error {
  constructor() {
    super("The page closed before this change was sent.");
    this.name = "QueueClosedError";
  }
}

/**
 * A queue whose tasks run only while `isOpen()` says the page that queued
 * them is still open. Each task checks at its turn: once the page has closed
 * (sign-out or session expiry unmount it without a reload), a task that has
 * not started is skipped and its promise rejects with `QueueClosedError`, so
 * the queue keeps draining. A request sent after sign-out would carry the
 * next user's session. A task already running is left to finish.
 */
export function gatedQueue(enqueue: SerialQueue, isOpen: () => boolean): SerialQueue {
  return <T>(task: () => Promise<T>): Promise<T> =>
    enqueue(() => (isOpen() ? task() : Promise.reject(new QueueClosedError())));
}

/**
 * Wraps a save function so its calls send their requests in call order, one
 * at a time, through a queue of their own. For saves that replace a whole
 * list: sent together, an older list could reach the server last and win.
 */
export function serialSaves<A extends unknown[], R>(
  save: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  const enqueue = createSerialQueue();
  return (...args: A) => enqueue(() => save(...args));
}

/**
 * Whole-list saves and the reload that corrects the page after one fails,
 * all through one queue. `resync` starts its read only after every save
 * queued before it has settled: a read that ran sooner could return the
 * server's list from before a pending save and put that old list back.
 * Once `isOpen()` turns false, saves and reloads that have not started are
 * skipped (see `gatedQueue`): a skipped save rejects with `QueueClosedError`;
 * a skipped reload resolves, as there is no page left to correct.
 */
export function queuedListSaves<A extends unknown[], R>(
  enqueue: SerialQueue,
  save: (...args: A) => Promise<R>,
  refresh: () => Promise<void>,
  isOpen: () => boolean = () => true
): { save: (...args: A) => Promise<R>; resync: () => Promise<void> } {
  const gated = gatedQueue(enqueue, isOpen);
  return {
    save: (...args: A) => gated(() => save(...args)),
    resync: () =>
      gated(refresh).catch((err: unknown) => {
        if (!(err instanceof QueueClosedError)) throw err;
      })
  };
}
