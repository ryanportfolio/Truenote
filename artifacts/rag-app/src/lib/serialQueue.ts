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
