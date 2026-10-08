/** Runs tasks handed to it one at a time, in the order given. */
export interface SerialQueue {
  <T>(task: () => Promise<T>): Promise<T>;
  /** Settles once every task queued so far, and any queued while waiting, has settled. */
  idle(): Promise<void>;
}

/**
 * A queue for saves that each replace a whole list on the server: each task
 * starts only after every earlier task has settled, whether it resolved or
 * rejected, so the server applies the saves in the order they were made and
 * the last one wins. The returned promise settles with the task's own result.
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    // A rejected task must not stop the ones queued behind it.
    tail = run.catch(() => undefined);
    return run;
  };
  const idle = async (): Promise<void> => {
    let seen: Promise<unknown>;
    do {
      seen = tail;
      await seen;
    } while (seen !== tail);
  };
  return Object.assign(enqueue, { idle });
}
