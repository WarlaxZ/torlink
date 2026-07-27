import { describe, expect, it, vi } from "vitest";
import { HEARTBEAT_MS, sseFrame, subscribeToQueue } from "./sse";
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

  // `JSON.stringify(undefined)` is the value `undefined`, which would render as
  // the literal text "data: undefined" — not JSON, so `JSON.parse` on the
  // client throws. The `?? null` in sseFrame exists only for this case.
  it("renders a missing payload as null rather than the text undefined", () => {
    expect(sseFrame("status", undefined)).toBe("event: status\ndata: null\n\n");
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
});
