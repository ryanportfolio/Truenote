/** Runs tasks handed to it one at a time, in the order given. */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A queue for saves that each replace a whole list on the server: each task
 * starts only after every earlier task has settled, whether it resolved or
 * rejected, so the server applies the saves in the order they were made and
 * the last one wins. The returned promise settles with the task's own result.
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
