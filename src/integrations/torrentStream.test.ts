import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { streamTorrent } from "./torrentStream";

// Minimal fakes ---------------------------------------------------------------
function fakeServer() {
  return {
    listen: (_p: number, _h: string | (() => void), cb?: () => void) => {
      const done = typeof _h === "function" ? _h : cb;
      done?.();
    },
    address: () => ({ port: 54321 }),
    close: (cb?: () => void) => cb?.(),
    destroy: (cb?: () => void) => cb?.(),
  };
}

function fakeTorrent() {
  const t = new EventEmitter() as any;
  t.infoHash = "abc123";
  t.name = "Big Buck Bunny";
  t.done = false;
  t.files = [
    { name: "readme.txt", path: "Big Buck Bunny/readme.txt", length: 100 },
    { name: "bbb.mp4", path: "Big Buck Bunny/bbb.mp4", length: 5000 },
  ];
  return t;
}

function fakeClient(torrent: any) {
  return {
    add: (_magnet: string, _opts: unknown) => {
      queueMicrotask(() => torrent.emit("metadata"));
      return torrent;
    },
    createServer: () => fakeServer(),
    get: () => torrent,
    remove: (_id: string, cb?: () => void) => cb?.(),
    destroy: (cb?: () => void) => cb?.(),
  };
}

describe("streamTorrent", () => {
  it("maps files to local server URLs after metadata", async () => {
    const torrent = fakeTorrent();
    const rm = vi.fn(async () => {});
    const session = await streamTorrent("magnet:?xt=urn:btih:abc123", {
      createClient: () => fakeClient(torrent) as any,
      mkdtemp: async () => "/tmp/torlink-stream-x",
      rm,
    });
    expect(session.name).toBe("Big Buck Bunny");
    const mp4 = session.files.find((f) => f.filename === "bbb.mp4")!;
    expect(mp4.bytes).toBe(5000);
    expect(mp4.url).toBe(
      "http://localhost:54321/webtorrent/abc123/Big%20Buck%20Bunny/bbb.mp4",
    );
  });

  it("stop() without keep removes the temp dir", async () => {
    const torrent = fakeTorrent();
    const rm = vi.fn(async () => {});
    const session = await streamTorrent("magnet:?x", {
      createClient: () => fakeClient(torrent) as any,
      mkdtemp: async () => "/tmp/torlink-stream-y",
      rm,
    });
    await session.stop();
    expect(rm).toHaveBeenCalledWith("/tmp/torlink-stream-y");
  });

  it("stop({keep:true}) leaves the temp dir in place", async () => {
    const torrent = fakeTorrent();
    const rm = vi.fn(async () => {});
    const session = await streamTorrent("magnet:?x", {
      createClient: () => fakeClient(torrent) as any,
      mkdtemp: async () => "/tmp/torlink-stream-z",
      rm,
    });
    await session.stop({ keep: true });
    expect(rm).not.toHaveBeenCalled();
  });

  it("rejects when metadata never arrives before the timeout", async () => {
    const torrent = new EventEmitter() as any; // never emits metadata
    const client = {
      add: () => torrent,
      createServer: () => fakeServer(),
      get: () => torrent,
      remove: (_i: string, cb?: () => void) => cb?.(),
      destroy: (cb?: () => void) => cb?.(),
    };
    const rm = vi.fn(async () => {});
    await expect(
      streamTorrent("magnet:?x", {
        createClient: () => client as any,
        mkdtemp: async () => "/tmp/torlink-stream-timeout",
        rm,
        metadataTimeoutMs: 5,
      }),
    ).rejects.toThrow(/no peers|metadata|timed out/i);
    expect(rm).toHaveBeenCalledWith("/tmp/torlink-stream-timeout");
  });
});
