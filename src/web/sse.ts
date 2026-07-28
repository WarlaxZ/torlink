import type { DownloadQueue } from "../download/queue";

// Keep-alive interval. Proxies and phone browsers drop a silent connection; a
// `ping` event with a null payload keeps it open without pretending state
// changed. It fires unconditionally rather than being reset by a status frame,
// so a busy connection can see a ping 1ms after an update. That is deliberate:
// one interval with no reset path is simpler than the alternative, and a ~24
// byte frame against four status frames a second is not worth the extra state.
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
  // JSON.stringify returns the *value* undefined — not a string — for undefined
  // input and for anything it cannot represent (a function, a symbol). All of
  // those would interpolate as the text "data: undefined", which is the one
  // thing a client's JSON.parse cannot survive, so coalesce the lot to null.
  return `event: ${name}\ndata: ${JSON.stringify(data) ?? "null"}\n\n`;
}

export type SseWrite = (chunk: string) => void;

/**
 * One SSE connection's lifecycle, with no idea what it is streaming.
 *
 * Extracted from `subscribeToQueue` when `/api/search` needed the same three
 * behaviours — send-or-tear-down, heartbeat, once-only stop — over a completely
 * different producer. Everything queue-shaped (the coalescing window, the
 * `update` listener) stayed behind in `subscribeToQueue`; what is here is only
 * what any SSE producer needs. The alternative was a second implementation of
 * exactly this in the search route, which is how the four copy-drift bugs in
 * this project's history started.
 */
export interface SseChannel {
  /**
   * Frame and write one event. `build` is a thunk, not a value, so that a
   * throwing producer is caught *here* instead of at the call site — evaluating
   * it in the argument list would put it outside the try, which is exactly the
   * bug this shape fixes. Do not "simplify" it back to a value. Note the cost:
   * a serialisation failure (circular structure, BigInt) is indistinguishable
   * from a dead socket and presents as a browser that keeps dropping its
   * connection. That trade is deliberate, but it is the first thing to rule out
   * when debugging that.
   *
   * Nothing is rethrown: most sends run from a timer or a promise callback,
   * where an escaping error is a process-level uncaughtException, and one
   * broken browser connection must not take down the daemon.
   */
  send: (event: string, build: () => unknown) => void;
  /** Idempotent teardown: clears the heartbeat, then runs the caller's cleanup. */
  stop: () => void;
  /** False once `stop` has run. Producers check it before doing more work. */
  readonly alive: boolean;
}

/**
 * Open an SSE channel over `write`, with a heartbeat running until it stops.
 *
 * `onClose` is the producer's own teardown (an event listener to remove, a
 * timer to clear, an AbortController to fire) and runs exactly once, whether
 * the stop came from the client hanging up, from the caller, or from a failed
 * write. Register everything that must not outlive the connection there:
 * a route that leaks it leaks per dead client on a process that runs for weeks.
 */
export function openSseChannel(write: SseWrite, onClose?: () => void): SseChannel {
  let live = true;

  // Both of these are hoisted `function` declarations on purpose: `send` closes
  // over `stop` and `stop` is referenced by the `setInterval` below, and only a
  // declaration is initialised early enough for the catch path to work. Written
  // as `const` arrows, `send`'s catch is a TDZ error.
  function send(event: string, build: () => unknown): void {
    if (!live) return;
    try {
      write(sseFrame(event, build()));
    } catch {
      stop();
    }
  }

  function stop(): void {
    if (!live) return;
    live = false;
    clearInterval(heartbeat);
    onClose?.();
  }

  const heartbeat = setInterval(() => send("ping", () => null), HEARTBEAT_MS);
  // Not optional-chained on purpose. Under this tsconfig (`types: ["node"]`, no
  // DOM) this is a NodeJS.Timeout and `unref` always exists, so `?.` would buy
  // nothing today and would silently skip the unref — quietly holding the
  // process open — if the types ever drifted to the DOM's number overload.
  heartbeat.unref();

  return {
    send,
    stop,
    get alive(): boolean {
      return live;
    },
  };
}

/**
 * Push queue state to one SSE client: an immediate snapshot, a coalesced frame
 * per burst of queue activity, and a periodic heartbeat. Returns an unsubscribe
 * function.
 */
export function subscribeToQueue(
  queue: DownloadQueue,
  write: SseWrite,
  snapshot: () => unknown,
): () => void {
  let pending = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const channel = openSseChannel(write, () => {
    queue.off("update", onUpdate);
    if (flushTimer) clearTimeout(flushTimer);
  });

  const flush = (): void => {
    // Released before the write, so an `update` emitted synchronously from
    // inside `write` arms a fresh timer and gets its own frame one window later
    // instead of being swallowed by this one.
    flushTimer = null;
    if (!channel.alive || !pending) return;
    // Clearing `pending` is what makes a second flush a no-op, which is why
    // dropping it alone changes nothing observable — it only earns its keep
    // together with the throttle guard below.
    pending = false;
    channel.send("status", snapshot);
  };

  // Hoisted, because the `onClose` closure above references it before this line.
  function onUpdate(): void {
    if (!channel.alive) return;
    pending = true;
    // The throttle. Without this a burst of N progress ticks schedules N
    // timers; the extras are harmless to the output but they are still N-1
    // orphaned timers per burst per client.
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
    // See the heartbeat's unref above for why this is not optional-chained.
    flushTimer.unref();
  }

  // Subscribe before the first send, so a `snapshot` that throws immediately
  // unwinds through `stop` with the listener already registered and therefore
  // removable. Reversed, `stop` would run before `on`, and the listener added
  // afterwards would outlive the subscription — inert, since every path checks
  // `alive`, but still a listener per dead client on a long-lived daemon.
  queue.on("update", onUpdate);
  channel.send("status", snapshot);

  return channel.stop;
}
