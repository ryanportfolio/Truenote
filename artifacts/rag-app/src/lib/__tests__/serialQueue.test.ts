import { describe, expect, it } from "vitest";
import { createSerialQueue, queuedListSaves, serialSaves } from "../serialQueue";

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

/** A stand-in for a whole-list save: records each list sent and waits for the test to answer it. */
function fakeListSave() {
  const sent: string[][] = [];
  const answers: Array<ReturnType<typeof deferred<void>>> = [];
  const save = (documentIds: string[]): Promise<void> => {
    sent.push(documentIds);
    const answer = deferred<void>();
    answers.push(answer);
    return answer.promise;
  };
  /** The pending answer to the request sent at `index`. */
  const answer = (index: number) => {
    const found = answers[index];
    if (!found) throw new Error(`No request ${index} was sent.`);
    return found;
  };
  return { sent, answer, save };
}

describe("serialSaves", () => {
  it("sends the second list only after the first save has resolved", async () => {
    const { sent, answer, save } = fakeListSave();
    const saveInOrder = serialSaves(save);
    const first = saveInOrder(["a"]);
    const second = saveInOrder(["a", "b"]);
    await flush();
    expect(sent).toEqual([["a"]]);
    answer(0).resolve();
    await expect(first).resolves.toBeUndefined();
    await flush();
    expect(sent).toEqual([["a"], ["a", "b"]]);
    answer(1).resolve();
    await expect(second).resolves.toBeUndefined();
  });

  it("still sends the next list after a rejection and passes the rejection to its caller", async () => {
    const { sent, answer, save } = fakeListSave();
    const saveInOrder = serialSaves(save);
    const first = saveInOrder(["a"]);
    const second = saveInOrder(["a", "b"]);
    await flush();
    expect(sent).toEqual([["a"]]);
    answer(0).reject(new Error("Demo accounts cannot change shared sources."));
    await expect(first).rejects.toThrow("Demo accounts cannot change shared sources.");
    await flush();
    expect(sent).toEqual([["a"], ["a", "b"]]);
    answer(1).resolve();
    await expect(second).resolves.toBeUndefined();
  });

  it("keeps a separate queue per wrapped save", async () => {
    const one = fakeListSave();
    const two = fakeListSave();
    const saveOne = serialSaves(one.save);
    const saveTwo = serialSaves(two.save);
    void saveOne(["a"]);
    void saveTwo(["b"]);
    await flush();
    expect(one.sent).toEqual([["a"]]);
    expect(two.sent).toEqual([["b"]]);
    one.answer(0).resolve();
    two.answer(0).resolve();
  });
});

describe("queuedListSaves", () => {
  it("reloads after a failed save only once the save queued behind it has settled", async () => {
    const { sent, answer, save } = fakeListSave();
    const log: string[] = [];
    // The server's list: what a reload would read.
    let server: string[] = [];
    const reads: string[][] = [];
    const saves = queuedListSaves(
      createSerialQueue(),
      async (documentIds: string[]) => {
        log.push(`save ${documentIds.join(",")} start`);
        await save(documentIds);
        server = documentIds;
        log.push(`save ${documentIds.join(",")} done`);
      },
      async () => {
        log.push("reload");
        reads.push(server);
      }
    );
    const first = saves.save(["a"]);
    const second = saves.save(["a", "b"]);
    await flush();
    answer(0).reject(new Error("That change didn't save. Try again."));
    await expect(first).rejects.toThrow("That change didn't save. Try again.");
    // The caller of the failed save asks for a reload at once.
    const reload = saves.resync();
    await flush();
    expect(sent).toEqual([["a"], ["a", "b"]]);
    expect(reads).toEqual([]);
    answer(1).resolve();
    await expect(second).resolves.toBeUndefined();
    await reload;
    expect(reads).toEqual([["a", "b"]]);
    expect(log).toEqual(["save a start", "save a,b start", "save a,b done", "reload"]);
  });

  it("reloads after a failed save that is the last one, without waiting on anything else", async () => {
    const { answer, save } = fakeListSave();
    let reloads = 0;
    const saves = queuedListSaves(createSerialQueue(), save, async () => {
      reloads += 1;
    });
    const only = saves.save(["a"]);
    await flush();
    answer(0).reject(new Error("Demo accounts cannot change shared sources."));
    await expect(only).rejects.toThrow("Demo accounts cannot change shared sources.");
    await saves.resync();
    expect(reloads).toBe(1);
  });

  it("sends a save made after a queued reload only once that reload has finished", async () => {
    const { sent, answer, save } = fakeListSave();
    const log: string[] = [];
    const saves = queuedListSaves(createSerialQueue(), save, async () => {
      log.push(`reload with ${sent.length} sent`);
    });
    const first = saves.save(["a"]);
    const reload = saves.resync();
    const second = saves.save(["a", "b"]);
    await flush();
    expect(sent).toEqual([["a"]]);
    answer(0).resolve();
    await first;
    await reload;
    await flush();
    expect(log).toEqual(["reload with 1 sent"]);
    expect(sent).toEqual([["a"], ["a", "b"]]);
    answer(1).resolve();
    await expect(second).resolves.toBeUndefined();
  });
});
