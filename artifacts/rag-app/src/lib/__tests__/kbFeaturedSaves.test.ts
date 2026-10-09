import { afterEach, describe, expect, it, vi } from "vitest";
import { setKbFeatured } from "../api";
import { createSerialQueue, queuedListSaves } from "../serialQueue";

/** A promise the test settles by hand, standing in for a request in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let every queued microtask run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const ok = (): Response =>
  new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("queued program-wide recommended list saves", () => {
  it("reach the server in the order they were made, so the newer list wins", async () => {
    // The server keeps whichever full list it applied last.
    let serverList: string[] = [];
    const slowFirst = deferred();
    const sent: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const { documentIds } = JSON.parse(String(init.body)) as { documentIds: string[] };
        sent.push(documentIds);
        // The first save is slow on the network; sent together, the second would land first.
        if (sent.length === 1) await slowFirst.promise;
        serverList = documentIds;
        return ok();
      })
    );

    const saves = queuedListSaves(createSerialQueue(), setKbFeatured, async () => undefined);
    const older = saves.save(["a", "b"], null);
    const newer = saves.save(["b", "a"], null);
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
