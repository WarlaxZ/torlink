import { describe, expect, it, vi } from "vitest";
import { HEARTBEAT_MS, sseFrame, subscribeToCasts, subscribeToQueue } from "./sse";
import { DownloadQueue } from "../download/queue";

describe("sseFrame", () => {
  it("formats an event with a JSON payload", () => {
    expect(sseFrame("status", { a: 1 })).toBe('event: status\ndata: {"a":1}\n\n');
  });

  it("escapes newlines so a multi-line payload cannot break the frame", () => {
    expect(sseFrame("status", { s: "a\nb" })).toBe('event: status\ndata: {"s":"a\\nb"}\n\n');
  });

  it("emits a null-payload event for a heartbeat", () => {
    expect(sseFrame("ping", null)).toBe("event: ping\ndata: null\n\n");
  });

  it("strips newlines from the event name so it cannot forge a second event", () => {
    expect(sseFrame("status\n\nevent: ping\ndata: null", { a: 1 })).toBe(
      'event: statusevent: pingdata: null\ndata: {"a":1}\n\n',
    );
    expect(sseFrame("status\r\nx", null)).toBe("event: statusx\ndata: null\n\n");
  });

  // `JSON.stringify` returns the value `undefined` — not a string — for several
  // inputs, all of which would render as the literal text "data: undefined".
  // That is not JSON, so `JSON.parse` on the client throws. Nullish input is
  // only the most obvious member of the family; anything unrepresentable does
  // the same, which is why the fallback is on the stringify result rather than
  // on the input.
  it("renders a missing payload as null rather than the text undefined", () => {
    expect(sseFrame("status", undefined)).toBe("event: status\ndata: null\n\n");
  });

  it("renders an unserialisable payload as null rather than the text undefined", () => {
    expect(sseFrame("status", () => 1)).toBe("event: status\ndata: null\n\n");
    expect(sseFrame("status", Symbol("nope"))).toBe("event: status\ndata: null\n\n");
  });
});

describe("subscribeToQueue", () => {
  it("sends an immediate snapshot then one per update", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const write = vi.fn();
      const stop = subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));

      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]![0]).toContain("event: status");

      queue.emit("update");
      vi.advanceTimersByTime(300);
      expect(write).toHaveBeenCalledTimes(2);

      stop();
      queue.emit("update");
      vi.advanceTimersByTime(300);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Deliberately literal, not `FLUSH_MS`-derived: a test that computes its own
  // timing from the constant under test passes at any value of that constant
  // and so pins only "there is a delay", never "the delay is 250ms".
  it("holds an update for the full 250ms window before flushing", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const write = vi.fn();
      const stop = subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));
      write.mockClear();

      queue.emit("update");
      vi.advanceTimersByTime(249);
      expect(write).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(write).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // The synchronous-burst test below coalesces at any window length, including
  // zero. Spreading the updates across the window is what actually distinguishes
  // a 250ms window from a short one, which would flush each update separately.
  it("coalesces updates spread across the window into one frame", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const write = vi.fn();
      const stop = subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));
      write.mockClear();

      queue.emit("update");
      vi.advanceTimersByTime(100);
      queue.emit("update");
      vi.advanceTimersByTime(100);
      queue.emit("update");
      vi.advanceTimersByTime(100);

      expect(write).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a burst of updates into one frame", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const write = vi.fn();
      const stop = subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));
      write.mockClear();

      for (let i = 0; i < 20; i++) queue.emit("update");
      vi.advanceTimersByTime(300);

      expect(write).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a heartbeat while idle", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const write = vi.fn();
      const stop = subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));
      write.mockClear();

      vi.advanceTimersByTime(HEARTBEAT_MS + 10);

      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]![0]).toContain("event: ping");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Literal 25_000 for the same reason as the flush window: the test above
  // advances by `HEARTBEAT_MS + 10`, which is self-referential and therefore
  // proves only that a heartbeat exists, at any interval.
  it("sends the first heartbeat at 25s and not before", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const write = vi.fn();
      const stop = subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));
      write.mockClear();

      vi.advanceTimersByTime(24_999);
      expect(write).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]![0]).toContain("event: ping");

      // The exported constant is part of the contract — a client uses it to size
      // its own connection timeout — so it must agree with the observed timing.
      expect(HEARTBEAT_MS).toBe(25_000);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // A burst produces one *frame* either way, because a second flush finds
  // nothing pending — so counting writes cannot see the throttle. What the
  // throttle actually buys is one timer per burst instead of one per tick, and
  // the queue emits `update` on every progress tick of every torrent.
  it("schedules a single flush timer for a burst of updates", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const stop = subscribeToQueue(queue, vi.fn(), () => ({ downloads: [], seeds: [] }));
      const idle = vi.getTimerCount();

      for (let i = 0; i < 20; i++) queue.emit("update");

      expect(vi.getTimerCount()).toBe(idle + 1);
      vi.advanceTimersByTime(300);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // A dead browser connection must not leave anything of itself behind: the
  // process is a long-running daemon and clients come and go.
  it("removes its queue listener on stop", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const stop = subscribeToQueue(queue, vi.fn(), () => ({ downloads: [], seeds: [] }));
      expect(queue.listenerCount("update")).toBe(1);

      stop();

      expect(queue.listenerCount("update")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears both the heartbeat and a pending flush on stop", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const stop = subscribeToQueue(queue, vi.fn(), () => ({ downloads: [], seeds: [] }));
      queue.emit("update");
      expect(vi.getTimerCount()).toBe(2);

      stop();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // U12 supplies a real snapshot over live queue state; the fixture above is the
  // only reason it cannot throw today. A throw must be handled like a dead
  // socket, not propagated: at subscribe time it would escape with the listener
  // and heartbeat already installed and no handle to clear them, and from a
  // flush it would escape a setTimeout callback as an uncaughtException.
  it("tears down without rethrowing when the initial snapshot throws", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const snapshot = () => {
        throw new Error("snapshot failed");
      };

      expect(() => subscribeToQueue(queue, vi.fn(), snapshot)).not.toThrow();

      expect(queue.listenerCount("update")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tears down without rethrowing when a snapshot throws during a flush", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const write = vi.fn();
      let healthy = true;
      subscribeToQueue(queue, write, () => {
        if (!healthy) throw new Error("snapshot failed");
        return { downloads: [], seeds: [] };
      });
      healthy = false;
      write.mockClear();

      queue.emit("update");
      expect(() => vi.advanceTimersByTime(300)).not.toThrow();

      expect(write).not.toHaveBeenCalled();
      expect(queue.listenerCount("update")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Note this one throws on the *first* frame, so by the mockClear the
  // subscription is already dead and the rest only exercises the `!live`
  // short-circuits. The test below covers the shape a real client actually
  // fails in: connected fine, then went away mid-stream.
  it("stops writing once the write callback throws", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const write = vi.fn(() => {
        throw new Error("socket closed");
      });
      subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));
      write.mockClear();

      queue.emit("update");
      vi.advanceTimersByTime(300);
      queue.emit("update");
      vi.advanceTimersByTime(300);

      expect(write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tears itself down when a write fails mid-stream", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      let connected = true;
      const write = vi.fn(() => {
        if (!connected) throw new Error("socket closed");
      });
      subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));
      expect(write).toHaveBeenCalledTimes(1);
      connected = false;
      write.mockClear();

      queue.emit("update");
      expect(() => vi.advanceTimersByTime(300)).not.toThrow();

      // The failing write itself happened; nothing after it may.
      expect(write).toHaveBeenCalledTimes(1);
      expect(queue.listenerCount("update")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      queue.emit("update");
      vi.advanceTimersByTime(300);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // `flushTimer` is released at the top of `flush`, before the write, so an
  // update emitted synchronously from inside `write` is neither lost (it arms a
  // new timer) nor folded into the frame being written (it gets its own).
  it("gives an update emitted during a write its own later frame", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      let reentered = false;
      const write = vi.fn(() => {
        if (write.mock.calls.length === 2 && !reentered) {
          reentered = true;
          queue.emit("update");
        }
      });
      const stop = subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));

      queue.emit("update");
      vi.advanceTimersByTime(250);
      expect(write).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(249);
      expect(write).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(write).toHaveBeenCalledTimes(3);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a timer armed during the write that then fails", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      let connected = true;
      const write = vi.fn(() => {
        if (!connected) {
          // Arm a fresh flush timer, then die — `stop` must clear the new timer,
          // not the one `flush` already released.
          queue.emit("update");
          throw new Error("socket closed");
        }
      });
      subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));
      connected = false;

      queue.emit("update");
      expect(() => vi.advanceTimersByTime(300)).not.toThrow();

      expect(vi.getTimerCount()).toBe(0);
      expect(queue.listenerCount("update")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Real timers on purpose. An SSE subscription must never be the reason the
  // process stays alive, and `process.getActiveResourcesInfo()` is the public
  // API that sees it: an unref'd Timeout is simply absent from the list. This
  // is a different guarantee from `stop()` clearing the timers — it covers the
  // client nobody remembered to stop.
  it("does not keep the process alive", () => {
    const queue = new DownloadQueue();
    const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timeouts();
    const stop = subscribeToQueue(queue, vi.fn(), () => ({ downloads: [], seeds: [] }));
    try {
      queue.emit("update");

      expect(timeouts()).toBe(before);
    } finally {
      stop();
    }
  });
});

describe("subscribeToCasts", () => {
  /** The one method sse.ts needs, so it imports nothing from src/core/cast. */
  function fakeCasts() {
    const listeners = new Set<() => void>();
    return {
      onChange(cb: () => void): () => void {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
      changed(): void {
        for (const cb of [...listeners]) cb();
      },
      count(): number {
        return listeners.size;
      },
    };
  }

  function frames(written: string[]): string[] {
    return written.join("").split("\n\n").filter(Boolean);
  }

  it("sends the current cast state at once, so a page arriving mid-cast is not blank", () => {
    const written: string[] = [];
    const casts = fakeCasts();
    const stop = subscribeToQueue(
      new DownloadQueue(),
      (c) => written.push(c),
      () => ({ downloads: [], seeds: [] }),
      subscribeToCasts(casts, () => ({ casting: null, notice: null })),
    );
    try {
      const cast = frames(written).filter((f) => f.startsWith("event: cast"));
      expect(cast).toHaveLength(1);
      expect(cast[0]).toContain('"casting":null');
    } finally {
      stop();
    }
  });

  it("sends a frame whenever the cast changes", () => {
    const written: string[] = [];
    const casts = fakeCasts();
    let state: unknown = { casting: null, notice: null };
    const stop = subscribeToQueue(
      new DownloadQueue(),
      (c) => written.push(c),
      () => ({ downloads: [], seeds: [] }),
      subscribeToCasts(casts, () => state),
    );
    try {
      state = {
        casting: {
          deviceName: "Living Room TV",
          title: "Kepler S02E04",
          state: "playing",
          positionSec: 12,
          durationSec: 600,
        },
        notice: null,
      };
      casts.changed();
      const cast = frames(written).filter((f) => f.startsWith("event: cast"));
      expect(cast).toHaveLength(2);
      expect(cast[1]).toContain("Living Room TV");
    } finally {
      stop();
    }
  });

  it("shares the queue's channel, so a browser needs one EventSource", () => {
    const written: string[] = [];
    const casts = fakeCasts();
    const stop = subscribeToQueue(
      new DownloadQueue(),
      (c) => written.push(c),
      () => ({ downloads: [], seeds: [] }),
      subscribeToCasts(casts, () => ({ casting: null, notice: null })),
    );
    try {
      expect(frames(written).some((f) => f.startsWith("event: status"))).toBe(true);
      expect(frames(written).some((f) => f.startsWith("event: cast"))).toBe(true);
    } finally {
      stop();
    }
  });

  it("unsubscribes from the registry when the connection ends", () => {
    const written: string[] = [];
    const casts = fakeCasts();
    const stop = subscribeToQueue(
      new DownloadQueue(),
      (c) => written.push(c),
      () => ({ downloads: [], seeds: [] }),
      subscribeToCasts(casts, () => ({ casting: null, notice: null })),
    );
    expect(casts.count()).toBe(1);
    stop();
    // A listener per dead client on a process that runs for weeks is the leak
    // every producer in this module is careful about.
    expect(casts.count()).toBe(0);
    const before = written.length;
    casts.changed();
    expect(written.length).toBe(before);
  });

  it("is optional: the queue stream works with no cast producer attached", () => {
    const written: string[] = [];
    const stop = subscribeToQueue(new DownloadQueue(), (c) => written.push(c), () => ({
      downloads: [],
      seeds: [],
    }));
    try {
      expect(frames(written).some((f) => f.startsWith("event: status"))).toBe(true);
      expect(frames(written).some((f) => f.startsWith("event: cast"))).toBe(false);
    } finally {
      stop();
    }
  });
});
