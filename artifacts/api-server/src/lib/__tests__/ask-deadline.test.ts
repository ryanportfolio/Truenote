import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAskDeadline, type DeadlineResponse } from "../ask-deadline.js";

/** Minimal EventEmitter-ish stand-in for an Express response's close lifecycle. */
function fakeResponse(): DeadlineResponse & {
  emitClose: () => void;
  finish: () => void;
} {
  const listeners = new Set<() => void>();
  let writableFinished = false;
  return {
    get writableFinished() {
      return writableFinished;
    },
    on(_event, listener) {
      listeners.add(listener);
      return this;
    },
    off(_event, listener) {
      listeners.delete(listener);
      return this;
    },
    emitClose() {
      for (const listener of listeners) listener();
    },
    finish() {
      writableFinished = true;
    }
  };
}

describe("startAskDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts and flags deadlineExceeded once the budget elapses", () => {
    const res = fakeResponse();
    const deadline = startAskDeadline(res, 1_000);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.deadlineExceeded()).toBe(false);

    vi.advanceTimersByTime(1_000);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.deadlineExceeded()).toBe(true);
    deadline.cleanup();
  });

  it("aborts on a client disconnect (close before the response finished)", () => {
    const res = fakeResponse();
    const deadline = startAskDeadline(res, 60_000);

    res.emitClose(); // client went away mid-request

    expect(deadline.signal.aborted).toBe(true);
    // A disconnect is NOT a deadline: the caller must not send a refusal.
    expect(deadline.deadlineExceeded()).toBe(false);
    deadline.cleanup();
  });

  it("ignores a close that fires after the response finished normally", () => {
    const res = fakeResponse();
    const deadline = startAskDeadline(res, 60_000);

    res.finish(); // response fully flushed
    res.emitClose(); // normal end-of-response close

    expect(deadline.signal.aborted).toBe(false);
    deadline.cleanup();
  });

  it("cleanup stops the deadline timer from firing late", () => {
    const res = fakeResponse();
    const deadline = startAskDeadline(res, 1_000);

    deadline.cleanup();
    vi.advanceTimersByTime(5_000);

    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.deadlineExceeded()).toBe(false);
  });

  it("cleanup detaches the close listener so a later disconnect is ignored", () => {
    const res = fakeResponse();
    const deadline = startAskDeadline(res, 60_000);

    deadline.cleanup();
    res.emitClose();

    expect(deadline.signal.aborted).toBe(false);
  });
});
