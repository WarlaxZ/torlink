// A sleep that gives up early when a signal aborts.
//
// Small enough to look like it belongs inline in app.ts, and it did for one
// commit — but it has two ways to be wrong that no amount of reading catches
// (never resolving on abort; leaving its listener attached), and app.ts is
// unreachable by any test in this repo. So it lives here, where a test can hold
// it to both. CLAUDE.md's rule about decisions living in pure modules, applied to
// a utility whose failure modes are a hang and a leak.

/**
 * Resolve after `ms`, or as soon as `signal` aborts — whichever comes first.
 *
 * RESOLVES ON ABORT, never rejects. The only caller is `runPlay`'s polling loop,
 * whose very next line is an abort check; rejecting would mean a try/catch there
 * to reach the same branch, and an unhandled rejection if anyone forgot it.
 *
 * Without the early resolve, pressing Cancel mid-poll leaves the button looking
 * inert for the rest of the second — long enough to be pressed again, which is
 * the habit the whole change is trying to break.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Already aborted is not an edge case: the signal is per-play and a cancel
    // can land between two polls, so the next sleep starts life aborted.
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // The listener is removed on BOTH paths. Left attached, it keeps this closure
    // — and so the timer — reachable for as long as the signal itself is, which
    // for a long-lived controller means until the tab closes.
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
