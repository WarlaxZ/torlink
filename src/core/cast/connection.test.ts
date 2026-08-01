import { describe, expect, it, vi } from "vitest";
import { FrameReader, frameCastMessage, type CastMessage } from "./protocol";
import { CastConnection, CastError, RECEIVER_APP_ID, type CastSocket } from "./connection";
import type { CastDevice } from "./discover";

const DEVICE: CastDevice = {
  id: "abc123",
  name: "Living Room TV",
  model: "Chromecast",
  host: "192.168.0.40",
  port: 8009,
};

const RECEIVER_NS = "urn:x-cast:com.google.cast.receiver";
const MEDIA_NS = "urn:x-cast:com.google.cast.media";
const HEARTBEAT_NS = "urn:x-cast:com.google.cast.tp.heartbeat";

/**
 * A socket that records what was sent and lets a test answer as a receiver.
 * The whole point of injecting the socket: every failure below is a test, not
 * a story about a television.
 */
function fakeSocket() {
  const sent: CastMessage[] = [];
  const reader = new FrameReader();
  let dataCb: (chunk: Buffer) => void = () => {};
  let closeCb: () => void = () => {};
  const destroy = vi.fn();
  const socket: CastSocket = {
    write: (data) => {
      sent.push(...reader.push(data));
    },
    onData: (cb) => {
      dataCb = cb;
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    destroy,
  };
  return {
    socket,
    sent,
    destroy,
    /** Answer as the receiver. */
    reply(namespace: string, payload: unknown): void {
      dataCb(
        frameCastMessage({
          sourceId: "receiver-0",
          destinationId: "sender-torlink",
          namespace,
          payload: JSON.stringify(payload),
        }),
      );
    },
    /** Deliver a raw chunk, for the malformed-frame case. */
    raw(chunk: Buffer): void {
      dataCb(chunk);
    },
    drop(): void {
      closeCb();
    },
    payloads(): Record<string, unknown>[] {
      return sent.map((m) => JSON.parse(m.payload) as Record<string, unknown>);
    },
    typesSent(): string[] {
      return this.payloads().map((p) => String(p.type));
    },
    /** The request id of the first message of this type. */
    requestId(type: string): number {
      return Number(this.payloads().find((p) => p.type === type)!.requestId);
    },
    payload(type: string): Record<string, unknown> {
      return this.payloads().find((p) => p.type === type)!;
    },
    message(type: string): CastMessage {
      return this.sent.find((m) => (JSON.parse(m.payload) as { type?: string }).type === type)!;
    },
  };
}

function launched(requestId: number) {
  return {
    type: "RECEIVER_STATUS",
    requestId,
    status: {
      applications: [{ appId: RECEIVER_APP_ID, sessionId: "sess-1", transportId: "transport-1" }],
    },
  };
}

function mediaStatus(requestId: number, over: Record<string, unknown> = {}) {
  return {
    type: "MEDIA_STATUS",
    requestId,
    status: [
      {
        mediaSessionId: 7,
        playerState: "PLAYING",
        currentTime: 12.5,
        media: { duration: 6_120 },
        ...over,
      },
    ],
  };
}

async function openWith(fake: ReturnType<typeof fakeSocket>) {
  return CastConnection.open(DEVICE, {
    connect: async () => fake.socket,
    setInterval: () => ({}),
    clearInterval: () => {},
  });
}

/** Open, launch and load, answering as a receiver would. */
async function playing() {
  const fake = fakeSocket();
  const conn = await openWith(fake);
  const statuses: { state: string; positionSec: number; durationSec: number | null }[] = [];
  conn.onStatus((s) => statuses.push(s));
  const loading = conn.load({
    url: "http://192.168.0.98:9161/stream/s/0?k=t",
    contentType: "video/mp4",
    title: "Kestrel 2010",
  });
  fake.reply(RECEIVER_NS, launched(fake.requestId("LAUNCH")));
  await vi.waitFor(() => expect(fake.typesSent()).toContain("LOAD"));
  fake.reply(MEDIA_NS, mediaStatus(fake.requestId("LOAD")));
  await loading;
  return { fake, conn, statuses };
}

describe("CastConnection.open", () => {
  it("connects to the receiver before anything else", async () => {
    const fake = fakeSocket();
    await openWith(fake);
    expect(fake.typesSent()).toEqual(["CONNECT"]);
  });

  it("is a CastError naming the device when the socket will not open", async () => {
    await expect(
      CastConnection.open(DEVICE, {
        connect: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).rejects.toThrow(/Living Room TV didn't answer/);
  });
});

describe("load", () => {
  it("launches the default receiver, then connects to its transport, then loads", async () => {
    const { fake } = await playing();
    expect(fake.typesSent()).toEqual(["CONNECT", "LAUNCH", "CONNECT", "LOAD"]);
    const load = fake.payload("LOAD");
    expect(load.sessionId).toBe("sess-1");
    expect(load.autoplay).toBe(true);
    const media = load.media as Record<string, unknown>;
    expect(media.contentId).toBe("http://192.168.0.98:9161/stream/s/0?k=t");
    expect(media.contentType).toBe("video/mp4");
    expect(media.streamType).toBe("BUFFERED");
    expect((media.metadata as { title: string }).title).toBe("Kestrel 2010");
    // The LOAD is addressed to the app's transport, not to receiver-0.
    expect(fake.message("LOAD").destinationId).toBe("transport-1");
  });

  it("passes a subtitle as a track and activates it", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const loading = conn.load({
      url: "http://192.168.0.98:9161/stream/s/0?k=t",
      contentType: "video/mp4",
      title: "Kepler S02E04",
      subtitleUrl: "http://192.168.0.98:9161/stream/s/1.vtt?k=t",
      subtitleLabel: "English",
    });
    fake.reply(RECEIVER_NS, launched(fake.requestId("LAUNCH")));
    await vi.waitFor(() => expect(fake.typesSent()).toContain("LOAD"));
    const load = fake.payload("LOAD");
    expect((load.media as Record<string, unknown>).tracks).toEqual([
      {
        trackId: 1,
        type: "TEXT",
        trackContentId: "http://192.168.0.98:9161/stream/s/1.vtt?k=t",
        trackContentType: "text/vtt",
        subtype: "SUBTITLES",
        name: "English",
        language: "en",
      },
    ]);
    expect(load.activeTrackIds).toEqual([1]);
    fake.reply(MEDIA_NS, mediaStatus(fake.requestId("LOAD")));
    await loading;
  });

  it("sends no tracks key at all when there is no subtitle", async () => {
    const { fake } = await playing();
    const media = fake.payload("LOAD").media as Record<string, unknown>;
    // An empty tracks array is not the same as no tracks: the receiver reads it
    // as "this file has no text tracks", which is a different claim.
    expect("tracks" in media).toBe(false);
    expect("activeTrackIds" in fake.payload("LOAD")).toBe(false);
  });

  it("rejects with a message fit for the screen when the receiver will not launch", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const loading = conn.load({ url: "http://h/s", contentType: "video/mp4", title: "Kestrel 2010" });
    fake.reply(RECEIVER_NS, {
      type: "LAUNCH_ERROR",
      requestId: fake.requestId("LAUNCH"),
      reason: "CANCELLED",
    });
    await expect(loading).rejects.toThrow(/Living Room TV wouldn't start the player/);
  });

  it("rejects on LOAD_FAILED, as a CastError", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const loading = conn.load({ url: "http://h/s", contentType: "video/mp4", title: "Kestrel 2010" });
    fake.reply(RECEIVER_NS, launched(fake.requestId("LAUNCH")));
    await vi.waitFor(() => expect(fake.typesSent()).toContain("LOAD"));
    fake.reply(MEDIA_NS, {
      type: "LOAD_FAILED",
      requestId: fake.requestId("LOAD"),
      detailedErrorCode: 905,
    });
    await expect(loading).rejects.toBeInstanceOf(CastError);
    await expect(loading).rejects.toThrow(/couldn't play this file/);
  });

  it("rejects on LOAD_CANCELLED too", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const loading = conn.load({ url: "http://h/s", contentType: "video/mp4", title: "Kestrel 2010" });
    fake.reply(RECEIVER_NS, launched(fake.requestId("LAUNCH")));
    await vi.waitFor(() => expect(fake.typesSent()).toContain("LOAD"));
    fake.reply(MEDIA_NS, { type: "LOAD_CANCELLED", requestId: fake.requestId("LOAD") });
    await expect(loading).rejects.toThrow(/couldn't play this file/);
  });
});

describe("status and commands", () => {
  it("reports position and duration from MEDIA_STATUS, in seconds", async () => {
    const { statuses } = await playing();
    expect(statuses.at(-1)).toEqual({ state: "playing", positionSec: 12.5, durationSec: 6_120 });
  });

  it("reports a null duration for an unknown-length source rather than zero", async () => {
    const { fake, statuses } = await playing();
    fake.reply(MEDIA_NS, mediaStatus(0, { media: {} }));
    await vi.waitFor(() => expect(statuses.at(-1)!.durationSec).toBeNull());
  });

  it("maps PAUSED, BUFFERING and IDLE", async () => {
    const { fake, statuses } = await playing();
    fake.reply(MEDIA_NS, mediaStatus(0, { playerState: "PAUSED" }));
    await vi.waitFor(() => expect(statuses.at(-1)!.state).toBe("paused"));
    fake.reply(MEDIA_NS, mediaStatus(0, { playerState: "BUFFERING" }));
    await vi.waitFor(() => expect(statuses.at(-1)!.state).toBe("loading"));
    fake.reply(MEDIA_NS, mediaStatus(0, { playerState: "IDLE" }));
    await vi.waitFor(() => expect(statuses.at(-1)!.state).toBe("idle"));
  });

  it("addresses PAUSE and PLAY to the media session the receiver named", async () => {
    const { fake, conn } = await playing();
    void conn.pause();
    void conn.play();
    expect(fake.payload("PAUSE").mediaSessionId).toBe(7);
    expect(fake.payload("PLAY").mediaSessionId).toBe(7);
    expect(fake.message("PAUSE").destinationId).toBe("transport-1");
  });

  it("stops by quitting the receiver app, so the TV returns to its own screen", async () => {
    const { fake, conn } = await playing();
    await conn.stop();
    expect(fake.payload("STOP").sessionId).toBe("sess-1");
    expect(fake.message("STOP").namespace).toBe(RECEIVER_NS);
  });

  it("refuses a command before anything is loaded, rather than sending a broken one", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    await expect(conn.pause()).rejects.toThrow(/nothing is playing/);
    await expect(conn.play()).rejects.toThrow(/nothing is playing/);
  });
});

describe("heartbeat and loss", () => {
  it("pings the receiver on the heartbeat interval", async () => {
    const fake = fakeSocket();
    let tick: (() => void) | null = null;
    await CastConnection.open(DEVICE, {
      connect: async () => fake.socket,
      setInterval: (cb) => {
        tick = cb;
        return {};
      },
      clearInterval: () => {},
    });
    tick!();
    expect(fake.typesSent()).toEqual(["CONNECT", "PING"]);
  });

  it("answers the device's own PING with a PONG", async () => {
    const fake = fakeSocket();
    await openWith(fake);
    fake.reply(HEARTBEAT_NS, { type: "PING" });
    expect(fake.typesSent()).toEqual(["CONNECT", "PONG"]);
  });

  it("reports the connection lost, once, when the socket drops", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const lost = vi.fn();
    conn.onLost(lost);
    fake.drop();
    fake.drop();
    expect(lost).toHaveBeenCalledOnce();
    expect(lost).toHaveBeenCalledWith("Lost the connection to Living Room TV.");
  });

  it("rejects a pending request when the socket drops, rather than hanging forever", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const loading = conn.load({ url: "http://h/s", contentType: "video/mp4", title: "Kestrel 2010" });
    fake.drop();
    await expect(loading).rejects.toThrow(/Lost the connection to Living Room TV/);
  });

  it("destroys the socket and stops the heartbeat on close", async () => {
    const fake = fakeSocket();
    const cleared = vi.fn();
    const conn = await CastConnection.open(DEVICE, {
      connect: async () => fake.socket,
      setInterval: () => ({ handle: 1 }),
      clearInterval: cleared,
    });
    conn.close();
    expect(fake.destroy).toHaveBeenCalledOnce();
    expect(cleared).toHaveBeenCalledOnce();
  });

  it("reports loss rather than throwing when a frame is malformed", async () => {
    // FrameReader throws on a length past its cap. In a TUI process an
    // unhandled error can take the whole terminal down, so this must surface as
    // a lost connection like any other.
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const lost = vi.fn();
    conn.onLost(lost);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(0xffffffff, 0);
    expect(() => fake.raw(header)).not.toThrow();
    expect(lost).toHaveBeenCalledOnce();
  });
});
