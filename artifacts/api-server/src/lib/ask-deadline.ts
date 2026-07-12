/**
 * Overall /ask deadline + client-disconnect cancellation.
 *
 * Backs one AbortController with two independent triggers:
 *   - a wall-clock timer (the DeadlineConfig.askDeadlineMs budget), and
 *   - the response closing before it finished writing (the CSR closed the tab).
 *
 * The controller's signal is threaded into every external provider call on the
 * ask path, so either trigger cancels the in-flight embedding / rerank /
 * generation request instead of letting it run to its own timeout while the
 * user waits or after they have already gone.
 *
 * `deadlineExceeded()` lets the route distinguish the two: a deadline trip
 * fails closed with the canned refusal (someone is still waiting); a plain
 * disconnect just stops work (no one is there to receive anything).
 *
 * Framework-agnostic on purpose (accepts the minimal surface of an Express
 * response) so the timer/abort lifecycle is unit-testable without an HTTP
 * server.
 */

/** The minimal `res` surface this helper needs — Express's Response satisfies it. */
export interface DeadlineResponse {
  /** True once the full response has been flushed (normal completion). */
  readonly writableFinished: boolean;
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

export const DEADLINE_REASON = "ask-deadline-exceeded";

export interface AskDeadline {
  signal: AbortSignal;
  /** True only when the wall-clock budget tripped the abort (not a disconnect). */
  deadlineExceeded: () => boolean;
  /** Clear the timer and detach the close listener. Idempotent; always call in finally. */
  cleanup: () => void;
}

export function startAskDeadline(res: DeadlineResponse, deadlineMs: number): AskDeadline {
  const controller = new AbortController();
  let deadlineExceeded = false;
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    deadlineExceeded = true;
    controller.abort(DEADLINE_REASON);
  }, deadlineMs);
  // Node keeps the event loop alive for pending timers; the ask path is
  // short-lived and always calls cleanup(), but unref anyway so a stray timer
  // can never hold the process open.
  if (typeof timer.unref === "function") timer.unref();

  const onClose = (): void => {
    // `close` also fires on normal completion; only a close BEFORE the response
    // finished writing means the client actually disconnected.
    if (settled || res.writableFinished) return;
    controller.abort();
  };
  res.on("close", onClose);

  return {
    signal: controller.signal,
    deadlineExceeded: () => deadlineExceeded,
    cleanup: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.off("close", onClose);
    }
  };
}
