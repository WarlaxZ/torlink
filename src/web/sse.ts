import type { DownloadQueue } from "../download/queue";

// Idle keep-alive. Proxies and phone browsers drop a silent connection; a
// periodic comment-ish event keeps it open without pretending state changed.
export const HEARTBEAT_MS = 25_000;

// Coalesce window for queue updates. The queue emits `update` on every progress
// tick across every torrent; a browser needs a few frames a second at most.
const FLUSH_MS = 250;

export function sseFrame(event: string, data: unknown): string {
  // JSON.stringify escapes newlines, so a payload can never inject a frame
  // boundary — that is the whole reason the data is always JSON here.
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

export type SseWrite = (chunk: string) => void;

/**
 * Push queue state to one SSE client: an immediate snapshot, a coalesced frame
 * per burst of queue activity, and a heartbeat while idle. Returns an
 * unsubscribe function.
 *
 * A write that throws means the socket is gone, so the subscription tears
 * itself down rather than leaking a listener and a timer per dead client.
 */
export function subscribeToQueue(
  queue: DownloadQueue,
  write: SseWrite,
  snapshot: () => unknown,
): () => void {
  let live = true;
  let pending = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (event: string, data: unknown): void => {
    if (!live) return;
    try {
      write(sseFrame(event, data));
    } catch {
      stop();
    }
  };

  const flush = (): void => {
    flushTimer = null;
    if (!live || !pending) return;
    pending = false;
    send("status", snapshot());
  };

  const onUpdate = (): void => {
    if (!live) return;
    pending = true;
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
    flushTimer.unref?.();
  };

  const heartbeat = setInterval(() => send("ping", null), HEARTBEAT_MS);
  heartbeat.unref?.();

  function stop(): void {
    if (!live) return;
    live = false;
    queue.off("update", onUpdate);
    clearInterval(heartbeat);
    if (flushTimer) clearTimeout(flushTimer);
  }

  queue.on("update", onUpdate);
  send("status", snapshot());

  return stop;
}
