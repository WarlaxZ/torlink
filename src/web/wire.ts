// The wire format of the status payload, declared once for both ends.
//
// This is a *types-only* module and must stay that way: it imports nothing, so
// it drags in no Node builtin and no app module. That is what lets
// `src/web/static/dashboard.ts` — which is bundled with `platform: "browser"` —
// reference these types with `import type` (erased at build time) while
// `src/daemon/serve.ts` uses them as the declared return type of
// `statusPayload`. One declaration, checked at the producer and at the consumer.
//
// It lives here rather than in `src/web/static/` (a browser bundle the daemon
// must not import from) or in `src/download/types.ts` (the queue's internal
// shape, which is free to change without breaking a documented HTTP response).
// It is a wire contract owned by the web layer, so it sits at the top of that
// layer with no dependencies of its own.
//
// Why it exists at all: this shape has now drifted three times. A hand-copied
// `statusPayload` dropped `uploadSpeed`; the browser's own copy of these
// interfaces let `progress` be read as a 0..1 fraction when the producer sends
// an integer percent; and before this module there was no compile-time link at
// all, so renaming a field typechecked on both sides and rendered nothing.

/**
 * One in-flight (or paused / queued / failed) download.
 *
 * UNITS — the two conventions here are indistinguishable by inspection, so they
 * are spelled out. Get one wrong and the browser silently renders a plausible
 * wrong number:
 *
 * - `progress` is an **integer percent, 0–100** — `QueueItem.progress`, passed
 *   through unchanged, and exactly what the TUI prints as `${it.progress}%`. It
 *   is NOT a 0..1 fraction. A running torrent is capped at 99 by the queue, so
 *   100 means finished.
 * - `speed` is **bytes per second**.
 */
export interface StatusDownload {
  id: string;
  name: string;
  status: string;
  /** Integer percent, 0–100 (not a 0..1 fraction). */
  progress: number;
  peers: number;
  /** Bytes per second. */
  speed: number;
}

/** One torrent being seeded. `uploaded` is bytes; `uploadSpeed` is bytes/sec. */
export interface StatusSeed {
  id: string;
  name: string;
  status: string;
  peers: number;
  /** Total bytes uploaded this session. */
  uploaded: number;
  /** Bytes per second. */
  uploadSpeed: number;
}

/** The body of GET /status, GET /downloads, GET /api/status and each SSE frame. */
export interface StatusPayload {
  downloads: StatusDownload[];
  seeds: StatusSeed[];
}
