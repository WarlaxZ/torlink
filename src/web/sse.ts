import type { DownloadQueue } from "../download/queue";

// Idle keep-alive. Proxies and phone browsers drop a silent connection; a `ping`
// event with a null payload keeps it open without pretending state changed.
export const HEARTBEAT_MS = 25_000;

// Coalesce window for queue updates. The queue emits `update` on every progress
// tick across every torrent; a browser needs a few frames a second at most.
const FLUSH_MS = 250;

export function sseFrame(event: string, data: unknown): string {
  // Neither half of a frame may contain a raw newline, or a client sees two
  // events where we sent one. The payload is safe for free: JSON.stringify
  // escapes newlines, which is the whole reason the data is always JSON here.
  // The event name has no such guarantee, so strip them — every caller passes a
  // literal today, but a name derived from a request path would otherwise let
  // the caller forge events.
  const name = event.replace(/[\r\n]/g, "");
  return `event: ${name}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

export type SseWrite = (chunk: string) => void;

/**
 * Push queue state to one SSE client: an immediate snapshot, a coalesced frame
 * per burst of queue activity, and a heartbeat while idle. Returns an
 * unsubscribe function.
 *
 * Anything that throws on the way to the socket — the write itself, the
 * caller's `snapshot`, or serialising its result — means this client is done,
 * so the subscription tears itself down rather than leaking a listener and a
 * timer per dead client. Nothing is rethrown: most of these run from a timer
 * callback, where an escaping error is a process-level uncaughtException, and
 * one broken browser connection must not take down the daemon.
 */
export function subscribeToQueue(
  queue: DownloadQueue,
  write: SseWrite,
  snapshot: () => unknown,
): () => void {
  let live = true;
  let pending = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  // `data` is a thunk, not a value, so that a throwing `snapshot` is caught
  // here instead of at the call site — evaluating it in the argument list would
  // put it outside this try. Note the cost: a serialisation failure (circular
  // structure, BigInt) is indistinguishable from a dead socket and presents as
  // a browser that keeps dropping its connection. That trade is deliberate, but
  // it is the first thing to rule out when debugging exactly that symptom.
  const send = (event: string, data: () => unknown): void => {
    if (!live) return;
    try {
      write(sseFrame(event, data()));
    } catch {
      stop();
    }
  };

  const flush = (): void => {
    flushTimer = null;
    if (!live || !pending) return;
    // Clearing `pending` is what makes a second flush a no-op, which is why
    // dropping it alone changes nothing observable — it only earns its keep
    // together with the throttle guard below.
    pending = false;
    send("status", snapshot);
  };

  const onUpdate = (): void => {
    if (!live) return;
    pending = true;
    // The throttle. Without this a burst of N progress ticks schedules N
    // timers; the extras are harmless to the output but they are still N-1
    // orphaned timers per burst per client.
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
    flushTimer.unref?.();
  };

  const heartbeat = setInterval(() => send("ping", () => null), HEARTBEAT_MS);
  heartbeat.unref?.();

  // Load-bearing `function` declaration: `send` above closes over `stop` before
  // this point, and only a hoisted declaration is initialised that early. The
  // rest of this function uses `const` arrows; rewriting this one to match
  // makes `send`'s catch a TDZ error.
  function stop(): void {
    if (!live) return;
    live = false;
    queue.off("update", onUpdate);
    clearInterval(heartbeat);
    if (flushTimer) clearTimeout(flushTimer);
  }

  // Subscribe before the first send, so a `snapshot` that throws immediately
  // unwinds through `stop` and leaves nothing behind. The reverse order would
  // leak the listener and the heartbeat with no handle to clean them up.
  queue.on("update", onUpdate);
  send("status", snapshot);

  return stop;
}
