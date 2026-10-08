import { afterEach, describe, expect, it, vi } from "vitest";
import { setKbFeatured } from "../api";
import { createSerialQueue } from "../serialQueue";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const ok = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSerialQueue", () => {
  it("starts each task only after the one before it settles", async () => {
    const enqueue = createSerialQueue();
    const first = deferred<string>();
    const order: string[] = [];
    const a = enqueue(() => {
      order.push("a start");
      return first.promise;
    });
    const b = enqueue(async () => {
      order.push("b start");
      return "b";
    });
    await flush();
    expect(order).toEqual(["a start"]);
    first.resolve("a");
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
    expect(order).toEqual(["a start", "b start"]);
  });

  it("keeps going after a task rejects, and passes the rejection to its caller", async () => {
    const enqueue = createSerialQueue();
    const failed = enqueue(() => Promise.reject(new Error("no")));
    const next = enqueue(async () => "next");
    await expect(failed).rejects.toThrow("no");
    await expect(next).resolves.toBe("next");
  });
});

describe("queued team pin saves", () => {
  it("reach the server in the order they were made, so the newer list wins", async () => {
    // The server keeps whichever full list it applied last.
    let serverList: string[] = [];
    const slowFirst = deferred<void>();
    const sent: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const { documentIds } = JSON.parse(String(init.body)) as { documentIds: string[] };
        sent.push(documentIds);
        // The first save is slow on the network; unqueued, the second would land first.
        if (sent.length === 1) await slowFirst.promise;
        serverList = documentIds;
        return ok();
      })
    );

    const enqueue = createSerialQueue();
    const older = enqueue(() => setKbFeatured(["a", "b"], null));
    const newer = enqueue(() => setKbFeatured(["b", "a"], null));
    await flush();
    expect(sent).toEqual([["a", "b"]]);

    slowFirst.resolve();
    await Promise.all([older, newer]);
    expect(sent).toEqual([
      ["a", "b"],
      ["b", "a"]
    ]);
    expect(serverList).toEqual(["b", "a"]);
  });

  it("sends a save to the program it was made in", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ok());
    vi.stubGlobal("fetch", fetchMock);
    await setKbFeatured(["a"], "program-1");
    const headers = fetchMock.mock.calls[0]?.[1].headers as Headers;
    expect(headers.get("X-Program-Id")).toBe("program-1");
  });
});
