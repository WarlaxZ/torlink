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

  it("emits a comment for a heartbeat", () => {
    expect(sseFrame("ping", null)).toBe("event: ping\ndata: null\n\n");
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
