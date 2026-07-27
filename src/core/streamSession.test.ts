import { describe, expect, it, vi } from "vitest";
import { NO_DEBRID_TOKEN, StreamSessionRegistry } from "./streamSession";
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
      backend: "torrent",
      state: "ready",
      name: "Some Release",
      createdAt: 5000,
    });
    expect(session.files).toEqual(FILES);
    expect(session.progress).toBe(100);
    expect(registry.get("sess1")).toBe(session);
    expect(registry.list()).toHaveLength(1);
  });

  it("falls back to the caller's name when the torrent has no name of its own", async () => {
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => ({ ...fakeTorrentSession(), name: "" }),
    });

    const session = await registry.start({
      ...INPUT,
      name: "Fallback Name",
      route: { kind: "torrent-auto" },
    });

    expect(session.name).toBe("Fallback Name");
  });

  it("prefers the torrent's own name over the caller's", async () => {
    // The swarm's name is the authoritative one: the caller's came from a
    // tracker listing, which is often mangled or truncated.
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => ({ ...fakeTorrentSession(), name: "Real.Swarm.Name" }),
    });

    const session = await registry.start({
      ...INPUT,
      name: "Listing Name",
      route: { kind: "torrent-auto" },
    });

    expect(session.name).toBe("Real.Swarm.Name");
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

  it("clears files when the backend fails after they were adopted", async () => {
    // Pins a defensive invariant: an errored session must never expose files.
    // No current backend can actually fail after file adoption — streamTorrent
    // snapshots `name` into a plain property, and the RD path assigns `files`
    // only once its await has resolved — so the throwing `name` getter below is
    // a deliberately impossible handle, the only way to reach the reset. Kept
    // because a future backend doing real work after adoption would need it.
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => ({
        get name(): string {
          throw new Error("torrent destroyed");
        },
        files: FILES,
        dir: "/tmp/x",
        isComplete: () => false,
        stop: vi.fn(async () => {}),
      }),
      idFactory: () => "sess1",
      capabilityFactory: () => "cap1",
    });

    const session = await registry.start({ ...INPUT, route: { kind: "torrent-auto" } });

    expect(session.state).toBe("error");
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

  it("hands the backend the magnet, not the bare info hash", async () => {
    const streamTorrentImpl = vi.fn(async () => fakeTorrentSession());
    const registry = new StreamSessionRegistry({ streamTorrentImpl });

    await registry.start({ ...INPUT, route: { kind: "torrent-auto" } });

    expect(streamTorrentImpl).toHaveBeenCalledWith(INPUT.magnet, expect.anything());
  });

  it("discards the download by default so temp data isn't left on disk", async () => {
    const stop = vi.fn(async () => {});
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => fakeTorrentSession(stop),
      idFactory: () => "sess1",
    });

    await registry.start({ ...INPUT, route: { kind: "torrent-auto" } });
    await registry.stop("sess1");

    expect(stop).toHaveBeenCalledWith({ keep: false });
  });

  it("aborts a backend that is still resolving when the session is stopped", async () => {
    // The handle doesn't exist yet, so stopping can only take effect through the
    // signal. Without it the swarm would keep running after shutdown.
    let seen: AbortSignal | undefined;
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async (_magnet, opts) => {
        seen = opts.signal;
        await gate;
        throw new Error("Stream cancelled.");
      },
      idFactory: () => "sess1",
    });

    const starting = registry.start({ ...INPUT, route: { kind: "torrent-auto" } });
    await Promise.resolve();
    await registry.stop("sess1");

    expect(seen?.aborted).toBe(true);
    release();
    const session = await starting;
    expect(session.state).toBe("error");
    expect(session.error).toBe("Stream cancelled.");
  });

  it("stops a handle that arrives after the session was already stopped", async () => {
    // A backend that ignores its signal still hands back a live WebTorrent
    // client. Nothing references it any more, so if the registry kept it the
    // swarm and its /tmp directory would survive shutdown.
    const stop = vi.fn(async () => {});
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => {
        await gate;
        return fakeTorrentSession(stop);
      },
      idFactory: () => "sess1",
    });

    const starting = registry.start({ ...INPUT, route: { kind: "torrent-auto" } });
    await registry.stop("sess1");
    release();
    const session = await starting;

    expect(stop).toHaveBeenCalledWith({ keep: false });
    expect(session.state).toBe("error");
    expect(session.backendHandle).toBeNull();
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
    // Read off the session mid-flight, not off the callback argument: the
    // session is already in the registry before the backend is invoked, and by
    // the time `start` resolves `progress` has been overwritten with 100. This
    // is what pins the callback actually being wired into the session.
    let progressDuringResolve: number | null = null;
    const registry: StreamSessionRegistry = new StreamSessionRegistry({
      resolveDebridImpl: async (_token, _magnet, opts) => {
        opts.onProgress?.(50);
        progressDuringResolve = registry.list()[0]!.progress;
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

    expect(session.backend).toBe("realdebrid");
    expect(session.state).toBe("ready");
    expect(session.files).toEqual(RD_FILES);
    expect(progressDuringResolve).toBe(50);
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
    // By identity, not by shape: the constant is exported so the web layer can
    // recognise this specific failure and prompt for a token.
    expect(session.error).toBe(NO_DEBRID_TOKEN);
    expect(resolveDebridImpl).not.toHaveBeenCalled();
    expect(streamTorrentImpl).not.toHaveBeenCalled();
  });

  it("forgets a ready RD session without a backend handle to stop", async () => {
    // Nothing local to tear down on this route — the files are RD's HTTPS links
    // — so stopping is just forgetting, and must not trip over the null handle.
    const registry = new StreamSessionRegistry({
      resolveDebridImpl: async () => RD_FILES,
      idFactory: () => "sess1",
    });

    await registry.start({ ...INPUT, route: { kind: "realdebrid" }, debridToken: "tok" });
    await expect(registry.stop("sess1")).resolves.toBeUndefined();

    expect(registry.get("sess1")).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  it("aborts an in-flight Real-Debrid poll when the session is stopped", async () => {
    // RD polling can sit in a stall window for minutes; a stop has to cut it
    // short rather than let it run on against the user's account.
    let seen: AbortSignal | undefined;
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const registry = new StreamSessionRegistry({
      resolveDebridImpl: async (_token, _magnet, opts) => {
        seen = opts.signal;
        await gate;
        return RD_FILES;
      },
      idFactory: () => "sess1",
    });

    const starting = registry.start({
      ...INPUT,
      route: { kind: "realdebrid" },
      debridToken: "tok",
    });
    await Promise.resolve();
    await registry.stop("sess1");

    expect(seen?.aborted).toBe(true);
    release();
    await starting;
    // Nothing to stop on this route — the files are RD's HTTPS links — but the
    // late resolve must not resurrect the session it already forgot.
    expect(registry.list()).toEqual([]);
    expect(registry.get("sess1")).toBeNull();
  });
});

describe("StreamSessionRegistry — begin", () => {
  it("returns a resolving session before the backend has answered", async () => {
    // What makes POST /api/stream answerable: a Real-Debrid cache can take
    // minutes, so the id and capability have to be available immediately.
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => {
        await gate;
        return fakeTorrentSession();
      },
      idFactory: () => "sess1",
      capabilityFactory: () => "cap1",
    });

    const { session, done } = registry.begin({ ...INPUT, route: { kind: "torrent-auto" } });

    expect(session).toMatchObject({ id: "sess1", capability: "cap1", state: "resolving" });
    expect(registry.get("sess1")).toBe(session);
    release();
    await done;
    // Same object, mutated in place — which is why polling get() works.
    expect(registry.get("sess1")).toBe(session);
    expect(session.state).toBe("ready");
  });

  it("reports a backend failure on the session rather than rejecting done", async () => {
    // A dropped `done` must not become an unhandled rejection: the HTTP route
    // deliberately doesn't await it.
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => {
        throw new Error("No peers found");
      },
      idFactory: () => "sess1",
    });

    const { session, done } = registry.begin({ ...INPUT, route: { kind: "torrent-auto" } });
    await expect(done).resolves.toBe(session);
    expect(session.state).toBe("error");
    expect(session.error).toBe("No peers found");
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
