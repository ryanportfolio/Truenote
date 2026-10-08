import { describe, expect, it } from "vitest";
import { serialSaves } from "../serialQueue";

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
