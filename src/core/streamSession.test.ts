import { describe, expect, it, vi } from "vitest";
import { StreamSessionRegistry } from "./streamSession";
import type { TorrentStreamSession } from "../integrations/torrentStream";
import type { StreamFile } from "../util/player";

const FILES: StreamFile[] = [
  { url: "http://localhost:1234/webtorrent/abc/big.mkv", filename: "big.mkv", bytes: 900 },
  { url: "http://localhost:1234/webtorrent/abc/small.mkv", filename: "small.mkv", bytes: 100 },
];

function fakeTorrentSession(stop = vi.fn(async () => {})): TorrentStreamSession {
  return {
    name: "Some Release",
    files: FILES,
    dir: "/tmp/x",
    isComplete: () => false,
    stop,
  };
}

const INPUT = { infoHash: "abc", magnet: "magnet:?xt=urn:btih:abc", name: "Some Release" };

describe("StreamSessionRegistry — torrent route", () => {
  it("starts a ready session with the torrent's files", async () => {
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => fakeTorrentSession(),
      idFactory: () => "sess1",
      capabilityFactory: () => "cap1",
      now: () => 5000,
    });

    const session = await registry.start({ ...INPUT, route: { kind: "torrent-auto" } });

    expect(session).toMatchObject({
      id: "sess1",
      capability: "cap1",
      route: "torrent",
      state: "ready",
      name: "Some Release",
      createdAt: 5000,
    });
    expect(session.files).toEqual(FILES);
    expect(registry.get("sess1")).toBe(session);
    expect(registry.list()).toHaveLength(1);
  });

  it("marks the session failed when the torrent never resolves", async () => {
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => {
        throw new Error("No peers found — couldn't start the stream (metadata timed out).");
      },
      idFactory: () => "sess1",
      capabilityFactory: () => "cap1",
    });

    const session = await registry.start({ ...INPUT, route: { kind: "torrent-auto" } });

    expect(session.state).toBe("error");
    expect(session.error).toBe("No peers found — couldn't start the stream (metadata timed out).");
    expect(session.files).toEqual([]);
  });

  it("stops the underlying session and forgets it", async () => {
    const stop = vi.fn(async () => {});
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => fakeTorrentSession(stop),
      idFactory: () => "sess1",
      capabilityFactory: () => "cap1",
    });

    await registry.start({ ...INPUT, route: { kind: "torrent-auto" } });
    await registry.stop("sess1", { keep: true });

    expect(stop).toHaveBeenCalledWith({ keep: true });
    expect(registry.get("sess1")).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  it("stopping an unknown id is a no-op", async () => {
    const registry = new StreamSessionRegistry({});
    await expect(registry.stop("nope")).resolves.toBeUndefined();
  });
});

describe("StreamSessionRegistry — Real-Debrid route", () => {
  const RD_FILES: StreamFile[] = [
    { url: "https://dl.real-debrid.com/d/XYZ/big.mkv", filename: "big.mkv", bytes: 900 },
  ];

  it("resolves through Real-Debrid and reports progress while resolving", async () => {
    const progressSeen: number[] = [];
    const registry = new StreamSessionRegistry({
      resolveDebridImpl: async (_token, _magnet, opts) => {
        opts.onProgress?.(50);
        progressSeen.push(50);
        return RD_FILES;
      },
      idFactory: () => "sess1",
      capabilityFactory: () => "cap1",
    });

    const session = await registry.start({
      ...INPUT,
      route: { kind: "realdebrid" },
      debridToken: "tok",
    });

    expect(session.route).toBe("realdebrid");
    expect(session.state).toBe("ready");
    expect(session.files).toEqual(RD_FILES);
    expect(progressSeen).toEqual([50]);
  });

  it("passes the info hash as knownHash so an existing RD torrent is reused", async () => {
    const resolveDebridImpl = vi.fn(async () => RD_FILES);
    const registry = new StreamSessionRegistry({ resolveDebridImpl });

    await registry.start({ ...INPUT, route: { kind: "realdebrid" }, debridToken: "tok" });

    expect(resolveDebridImpl).toHaveBeenCalledWith(
      "tok",
      INPUT.magnet,
      expect.objectContaining({ knownHash: "abc" }),
    );
  });

  it("fails without a token rather than silently falling back to P2P", async () => {
    const resolveDebridImpl = vi.fn(async () => RD_FILES);
    const streamTorrentImpl = vi.fn(async () => fakeTorrentSession());
    const registry = new StreamSessionRegistry({ resolveDebridImpl, streamTorrentImpl });

    const session = await registry.start({ ...INPUT, route: { kind: "realdebrid" } });

    expect(session.state).toBe("error");
    expect(session.error).toMatch(/Real-Debrid token/i);
    expect(resolveDebridImpl).not.toHaveBeenCalled();
    expect(streamTorrentImpl).not.toHaveBeenCalled();
  });
});

describe("StreamSessionRegistry — stopAll", () => {
  it("stops every live session", async () => {
    const stopA = vi.fn(async () => {});
    const stopB = vi.fn(async () => {});
    let n = 0;
    // Counted separately from `n`: which stop a session gets must not depend on
    // whether the registry mints its id before or after it starts the backend.
    let started = 0;
    const stops = [stopA, stopB];
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => fakeTorrentSession(stops[started++]!),
      idFactory: () => `sess${++n}`,
      capabilityFactory: () => "cap",
    });

    await registry.start({ ...INPUT, route: { kind: "torrent-auto" } });
    await registry.start({ ...INPUT, infoHash: "def", route: { kind: "torrent-auto" } });
    await registry.stopAll();

    expect(stopA).toHaveBeenCalled();
    expect(stopB).toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
  });
});
