import { describe, expect, it } from "vitest";
import { createSerialQueue, focusKeysFor } from "../teamsView";

/** A promise the test settles by hand, standing in for a request in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued microtask run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("createSerialQueue", () => {
  it("starts a task only after the earlier one has resolved", async () => {
    const enqueue = createSerialQueue();
    const log: string[] = [];
    const first = deferred<string>();
    const a = enqueue(() => {
      log.push("a start");
      return first.promise;
    });
    const b = enqueue(async () => {
      log.push("b start");
      return "b";
    });
    await flush();
    expect(log).toEqual(["a start"]);
    first.resolve("a");
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
    expect(log).toEqual(["a start", "b start"]);
  });

  it("keeps going after a rejection and passes the rejection to that task's caller", async () => {
    const enqueue = createSerialQueue();
    const log: string[] = [];
    const first = deferred<string>();
    const a = enqueue(() => first.promise);
    const b = enqueue(async () => {
      log.push("b start");
      return "b";
    });
    await flush();
    expect(log).toEqual([]);
    first.reject(new Error("Demo accounts cannot change teams."));
    await expect(a).rejects.toThrow("Demo accounts cannot change teams.");
    await expect(b).resolves.toBe("b");
    expect(log).toEqual(["b start"]);
  });

  it("runs three tasks in the order given, whatever their own speed", async () => {
    const enqueue = createSerialQueue();
    const order: number[] = [];
    const slow = deferred<void>();
    const runs = [
      enqueue(async () => {
        await slow.promise;
        order.push(1);
      }),
      enqueue(async () => {
        order.push(2);
      }),
      enqueue(async () => {
        order.push(3);
      })
    ];
    await flush();
    expect(order).toEqual([]);
    slow.resolve();
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3]);
  });

  it("runs a task added after the queue went idle right away", async () => {
    const enqueue = createSerialQueue();
    await enqueue(async () => "done");
    let started = false;
    const next = enqueue(async () => {
      started = true;
    });
    await flush();
    expect(started).toBe(true);
    await next;
  });
});

describe("focusKeysFor", () => {
  it("tries the dragged row first, then the same person's chip", () => {
    expect(focusKeysFor("row:c1")).toEqual(["row:c1", "chip:c1"]);
  });

  it("tries the dragged chip first, then the same person's row", () => {
    expect(focusKeysFor("chip:c1")).toEqual(["chip:c1", "row:c1"]);
  });

  it("keeps an unknown key as the only choice", () => {
    expect(focusKeysFor("other:c1")).toEqual(["other:c1"]);
  });
});
