import { describe, expect, it, vi } from "vitest";
import { CastError } from "./connection";
import { CastSessionRegistry, type StartCastInput } from "./session";
import type { CastDevice } from "./discover";

const DEVICE: CastDevice = {
  id: "abc",
  name: "Living Room TV",
  model: "Chromecast",
  host: "10.0.0.5",
  port: 8009,
};
const OTHER: CastDevice = {
  id: "k1",
  name: "Kitchen display",
  model: "Chromecast",
  host: "10.0.0.6",
  port: 8009,
};

function input(over: Partial<StartCastInput> = {}): StartCastInput {
  return {
    device: DEVICE,
    sid: "sess",
    index: 0,
    infoHash: "hash",
    filename: "Kepler.S02E04.1080p.WEB-DL.mkv",
    title: "Kepler S02E04",
    media: {
      url: "http://10.0.0.2:9161/stream/sess/0?k=t",
      contentType: "video/mp4",
      title: "Kepler S02E04",
    },
    ...over,
  };
}

function fakeConnection() {
  let statusCb: ((s: never) => void) | null = null;
  let lostCb: ((m: string) => void) | null = null;
  return {
    load: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    close: vi.fn(),
    onStatus(cb: never) {
      statusCb = cb;
    },
    onLost(cb: (m: string) => void) {
      lostCb = cb;
    },
    emitStatus(s: unknown) {
      (statusCb as unknown as (v: unknown) => void)(s);
    },
    emitLost(m: string) {
      lostCb!(m);
    },
  };
}

/** No default markPlayed: the real one writes the developer's own data dir. */
function registryWith(conn: ReturnType<typeof fakeConnection>) {
  return new CastSessionRegistry({
    openConnection: async () => conn as never,
    markPlayed: async () => {},
  });
}

describe("CastSessionRegistry", () => {
  it("has nothing active until something is cast", () => {
    expect(new CastSessionRegistry({ markPlayed: async () => {} }).active()).toBeNull();
  });

  it("loads the media and reports what is playing", async () => {
    const conn = fakeConnection();
    const active = await registryWith(conn).start(input());
    expect(conn.load).toHaveBeenCalledWith(input().media);
    expect(active.device.name).toBe("Living Room TV");
    expect(active).toMatchObject({ sid: "sess", index: 0, title: "Kepler S02E04" });
  });

  it("marks the file played on a successful load, exactly once", async () => {
    const markPlayed = vi.fn(async () => {});
    const registry = new CastSessionRegistry({
      openConnection: async () => fakeConnection() as never,
      markPlayed,
    });
    await registry.start(input());
    expect(markPlayed).toHaveBeenCalledExactlyOnceWith("hash", "Kepler.S02E04.1080p.WEB-DL.mkv");
  });

  it("marks nothing when the device refuses the file", async () => {
    const markPlayed = vi.fn(async () => {});
    const conn = fakeConnection();
    conn.load.mockRejectedValue(new CastError("Living Room TV couldn't play this file."));
    const registry = new CastSessionRegistry({
      openConnection: async () => conn as never,
      markPlayed,
    });
    await expect(registry.start(input())).rejects.toThrow(/couldn't play this file/);
    // A device that refused the file must not earn a ✓ — the rule the TUI's
    // onPlayed callback already follows.
    expect(markPlayed).not.toHaveBeenCalled();
    expect(registry.active()).toBeNull();
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it("never lets a history write failure fail a cast the user already started", async () => {
    const registry = new CastSessionRegistry({
      openConnection: async () => fakeConnection() as never,
      markPlayed: async () => {
        throw new Error("disk full");
      },
    });
    await expect(registry.start(input())).resolves.toMatchObject({ sid: "sess" });
  });

  it("replaces an existing cast, closing the first connection", async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    const conns = [first, second];
    const registry = new CastSessionRegistry({
      openConnection: async () => conns.shift() as never,
      markPlayed: async () => {},
    });
    await registry.start(input());
    await registry.start(input({ device: OTHER, sid: "sess2" }));
    expect(first.close).toHaveBeenCalledOnce();
    expect(registry.active()).toMatchObject({ sid: "sess2", device: { name: "Kitchen display" } });
  });

  it("keeps the latest status and notifies subscribers", async () => {
    const conn = fakeConnection();
    const registry = registryWith(conn);
    const changed = vi.fn();
    registry.onChange(changed);
    await registry.start(input());
    changed.mockClear();
    conn.emitStatus({ state: "playing", positionSec: 30, durationSec: 6_000 });
    expect(registry.active()!.status).toEqual({
      state: "playing",
      positionSec: 30,
      durationSec: 6_000,
    });
    expect(changed).toHaveBeenCalled();
  });

  it("starts at loading with no position, so nothing claims 0:00 of a file it has not read", async () => {
    const registry = registryWith(fakeConnection());
    const active = await registry.start(input());
    expect(active.status).toEqual({ state: "loading", positionSec: 0, durationSec: null });
  });

  it("clears the cast and leaves a notice when the connection is lost", async () => {
    const conn = fakeConnection();
    const registry = registryWith(conn);
    await registry.start(input());
    conn.emitLost("Lost the connection to Living Room TV.");
    expect(registry.active()).toBeNull();
    expect(registry.takeNotice()).toBe("Lost the connection to Living Room TV.");
    // Taken once: the front end that read it has shown it.
    expect(registry.takeNotice()).toBeNull();
  });

  it("ignores a lost report from a connection that has already been replaced", async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    const conns = [first, second];
    const registry = new CastSessionRegistry({
      openConnection: async () => conns.shift() as never,
      markPlayed: async () => {},
    });
    await registry.start(input());
    await registry.start(input({ sid: "sess2" }));
    // The first socket closing is the expected consequence of replacing it, and
    // must not tear down the cast that replaced it.
    first.emitLost("Lost the connection to Living Room TV.");
    expect(registry.active()).toMatchObject({ sid: "sess2" });
    expect(registry.takeNotice()).toBeNull();
  });

  it("stop closes the connection and clears the cast, with no notice — the user asked for it", async () => {
    const conn = fakeConnection();
    const registry = registryWith(conn);
    await registry.start(input());
    await registry.stop();
    expect(conn.stop).toHaveBeenCalledOnce();
    expect(conn.close).toHaveBeenCalledOnce();
    expect(registry.active()).toBeNull();
    expect(registry.takeNotice()).toBeNull();
  });

  it("passes play and pause through", async () => {
    const conn = fakeConnection();
    const registry = registryWith(conn);
    await registry.start(input());
    await registry.pause();
    await registry.play();
    expect(conn.pause).toHaveBeenCalledOnce();
    expect(conn.play).toHaveBeenCalledOnce();
  });

  it("refuses a command when nothing is casting", async () => {
    const registry = new CastSessionRegistry({ markPlayed: async () => {} });
    await expect(registry.pause()).rejects.toThrow(/nothing is casting/i);
    await expect(registry.play()).rejects.toThrow(/nothing is casting/i);
    // Stop is the exception: stopping nothing is what the caller wanted anyway.
    await expect(registry.stop()).resolves.toBeUndefined();
  });

  it("unsubscribes cleanly", async () => {
    const registry = new CastSessionRegistry({
      openConnection: async () => fakeConnection() as never,
      markPlayed: async () => {},
    });
    const changed = vi.fn();
    registry.onChange(changed)();
    await registry.start(input());
    expect(changed).not.toHaveBeenCalled();
  });
});
