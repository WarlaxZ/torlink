import tls from "node:tls";
import { FrameReader, frameCastMessage, type CastMessage } from "./protocol";
import type { CastDevice } from "./discover";

/**
 * One conversation with one Chromecast.
 *
 * The protocol, in the order it happens: CONNECT to `receiver-0`; LAUNCH the
 * default media receiver; read the app's `sessionId` and `transportId` out of
 * the RECEIVER_STATUS that answers; CONNECT again to that transport; LOAD on the
 * media namespace. PAUSE and PLAY are addressed to the transport thereafter, and
 * STOP goes back to the receiver namespace because it quits the app rather than
 * pausing the file.
 *
 * Every message carries a monotonic `requestId` and replies are matched by it.
 * MEDIA_STATUS also arrives UNSOLICITED, with a requestId of 0 — those are the
 * position updates, and they match no pending request.
 */

export const RECEIVER_APP_ID = "CC1AD845";

/**
 * How often to PING.
 *
 * A receiver drops a sender that goes quiet for about eight seconds, so this has
 * to be comfortably under that. Five is what every other sender uses.
 */
export const HEARTBEAT_MS = 5_000;

const SENDER_ID = "sender-torlink";
const RECEIVER_ID = "receiver-0";
const NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA = "urn:x-cast:com.google.cast.media";

/** How long to wait for a socket, and for a reply to a request. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * The part of a TLS socket this module uses.
 *
 * Injected rather than imported so the tests answer as a receiver instead of
 * needing a television on the desk.
 */
export interface CastSocket {
  write(data: Buffer): void;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: () => void): void;
  destroy(): void;
}

export type ConnectSocket = (host: string, port: number) => Promise<CastSocket>;

export interface CastMediaRequest {
  url: string;
  contentType: string;
  title: string;
  subtitleUrl?: string;
  subtitleLabel?: string;
}

export type CastPlayerState = "loading" | "playing" | "paused" | "idle";

export interface CastStatus {
  state: CastPlayerState;
  positionSec: number;
  /** Null when the receiver has not said — a manifest it is still reading. */
  durationSec: number | null;
}

export interface ConnectionDeps {
  connect?: ConnectSocket;
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** A failure with a message already fit to put on screen. */
export class CastError extends Error {}

const defaultConnect: ConnectSocket = (host, port) =>
  new Promise((resolve, reject) => {
    // rejectUnauthorized: false is load-bearing, not laziness. A Chromecast
    // presents a device-signed certificate and there is no chain to check it
    // against. It is acceptable because nothing secret crosses this socket: the
    // payload is a URL already available to anything on the LAN holding the
    // session's `?k=` token.
    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      socket.setTimeout(0);
      resolve({
        write: (data) => void socket.write(data),
        onData: (cb) => void socket.on("data", cb),
        onClose: (cb) => {
          socket.on("close", cb);
          // An error is a close as far as this module is concerned, and an
          // unhandled "error" event on a socket is a thrown exception in the
          // process — which in the TUI takes the terminal down with it.
          socket.on("error", () => cb());
        },
        destroy: () => void socket.destroy(),
      });
    });
    socket.once("error", reject);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error("timed out"));
    });
  });

interface Pending {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  /** Reply types that settle this request, beyond the expected one. */
  failures: string[];
  expect: string;
}

function playerState(raw: unknown): CastPlayerState {
  switch (String(raw)) {
    case "PLAYING":
      return "playing";
    case "PAUSED":
      return "paused";
    case "IDLE":
      return "idle";
    // BUFFERING and anything else the receiver invents read as "not showing you
    // a frame yet", which is what "loading" says on screen.
    default:
      return "loading";
  }
}

export class CastConnection {
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;
  private transportId: string | null = null;
  private sessionId: string | null = null;
  private mediaSessionId: number | null = null;
  private statusCb: ((status: CastStatus) => void) | null = null;
  private lostCb: ((message: string) => void) | null = null;
  private lost = false;
  private readonly reader = new FrameReader();

  private constructor(
    private readonly device: CastDevice,
    private readonly socket: CastSocket,
    private readonly heartbeat: unknown,
    private readonly clearHeartbeat: (handle: unknown) => void,
  ) {}

  static async open(device: CastDevice, deps: ConnectionDeps = {}): Promise<CastConnection> {
    const connect = deps.connect ?? defaultConnect;
    const setTimer = deps.setInterval ?? ((cb, ms) => setInterval(cb, ms));
    const clearTimer = deps.clearInterval ?? ((handle) => clearInterval(handle as never));
    let socket: CastSocket;
    try {
      socket = await connect(device.host, device.port);
    } catch {
      // The reason is never shown: ECONNREFUSED, EHOSTUNREACH and a timeout all
      // mean the same thing to someone holding a remote control.
      throw new CastError(`${device.name} didn't answer — it may be off.`);
    }
    let conn: CastConnection | null = null;
    const timer = setTimer(() => conn?.ping(), HEARTBEAT_MS);
    conn = new CastConnection(device, socket, timer, clearTimer);
    socket.onData((chunk) => conn!.receive(chunk));
    socket.onClose(() => conn!.fail(`Lost the connection to ${device.name}.`));
    conn.send(NS_CONNECTION, RECEIVER_ID, { type: "CONNECT" });
    return conn;
  }

  onStatus(cb: (status: CastStatus) => void): void {
    this.statusCb = cb;
  }

  onLost(cb: (message: string) => void): void {
    this.lostCb = cb;
  }

  close(): void {
    this.clearHeartbeat(this.heartbeat);
    this.socket.destroy();
  }

  async load(req: CastMediaRequest): Promise<void> {
    const launch = await this.request(NS_RECEIVER, RECEIVER_ID, "RECEIVER_STATUS", ["LAUNCH_ERROR"], (requestId) => ({
      type: "LAUNCH",
      requestId,
      appId: RECEIVER_APP_ID,
    })).catch((e: unknown) => {
      if (e instanceof CastError) throw e;
      throw new CastError(`${this.device.name} wouldn't start the player.`);
    });
    const app = ((launch.status as { applications?: Record<string, unknown>[] } | undefined)
      ?.applications ?? []).find((a) => a.appId === RECEIVER_APP_ID);
    const transportId = typeof app?.transportId === "string" ? app.transportId : null;
    const sessionId = typeof app?.sessionId === "string" ? app.sessionId : null;
    if (!transportId || !sessionId) {
      throw new CastError(`${this.device.name} wouldn't start the player.`);
    }
    this.transportId = transportId;
    this.sessionId = sessionId;
    // A media message to an app we have not joined is dropped silently, which
    // presents as a LOAD that never answers.
    this.send(NS_CONNECTION, transportId, { type: "CONNECT" });

    const media: Record<string, unknown> = {
      contentId: req.url,
      contentType: req.contentType,
      streamType: "BUFFERED",
      metadata: { metadataType: 0, title: req.title },
    };
    if (req.subtitleUrl) {
      media.tracks = [
        {
          trackId: 1,
          type: "TEXT",
          trackContentId: req.subtitleUrl,
          trackContentType: "text/vtt",
          subtype: "SUBTITLES",
          name: req.subtitleLabel ?? "Subtitles",
          language: "en",
        },
      ];
    }
    const status = await this.request(
      NS_MEDIA,
      transportId,
      "MEDIA_STATUS",
      ["LOAD_FAILED", "LOAD_CANCELLED"],
      (requestId) => {
        const body: Record<string, unknown> = {
          type: "LOAD",
          requestId,
          sessionId,
          media,
          autoplay: true,
        };
        if (req.subtitleUrl) body.activeTrackIds = [1];
        return body;
      },
    ).catch((e: unknown) => {
      if (e instanceof CastError) throw e;
      throw new CastError(`${this.device.name} couldn't play this file.`);
    });
    this.absorbMediaStatus(status);
  }

  async play(): Promise<void> {
    await this.mediaCommand("PLAY");
  }

  async pause(): Promise<void> {
    await this.mediaCommand("PAUSE");
  }

  /**
   * Quit the receiver app.
   *
   * Not a media STOP: quitting hands the television back to its own screen,
   * which is what "stop casting" means to the person who pressed it. Tolerant of
   * having nothing to stop, because a stop button that errors is worse than one
   * that does nothing.
   */
  async stop(): Promise<void> {
    if (!this.sessionId) return;
    this.send(NS_RECEIVER, RECEIVER_ID, {
      type: "STOP",
      requestId: this.nextRequestId++,
      sessionId: this.sessionId,
    });
  }

  private async mediaCommand(type: "PLAY" | "PAUSE"): Promise<void> {
    if (this.mediaSessionId === null || !this.transportId) {
      throw new CastError("nothing is playing on this device.");
    }
    this.send(NS_MEDIA, this.transportId, {
      type,
      requestId: this.nextRequestId++,
      mediaSessionId: this.mediaSessionId,
    });
  }

  private ping(): void {
    if (this.lost) return;
    this.send(NS_HEARTBEAT, RECEIVER_ID, { type: "PING" });
  }

  private send(namespace: string, destinationId: string, payload: unknown): void {
    const message: CastMessage = {
      sourceId: SENDER_ID,
      destinationId,
      namespace,
      payload: JSON.stringify(payload),
    };
    try {
      this.socket.write(frameCastMessage(message));
    } catch {
      this.fail(`Lost the connection to ${this.device.name}.`);
    }
  }

  private request(
    namespace: string,
    destinationId: string,
    expect: string,
    failures: string[],
    build: (requestId: number) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const requestId = this.nextRequestId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, expect, failures });
      this.send(namespace, destinationId, build(requestId));
    });
  }

  private receive(chunk: Buffer): void {
    let messages: CastMessage[];
    try {
      messages = this.reader.push(chunk);
    } catch {
      // A malformed frame is a connection we can no longer follow. Reported, not
      // thrown: in the TUI an unhandled error takes the terminal with it.
      this.fail(`Lost the connection to ${this.device.name}.`);
      return;
    }
    for (const message of messages) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(message.payload) as Record<string, unknown>;
      } catch {
        continue; // Not JSON, so not something this sender speaks.
      }
      this.dispatch(message.namespace, payload);
    }
  }

  private dispatch(namespace: string, payload: Record<string, unknown>): void {
    const type = String(payload.type ?? "");
    if (namespace === NS_HEARTBEAT) {
      if (type === "PING") this.send(NS_HEARTBEAT, RECEIVER_ID, { type: "PONG" });
      return;
    }
    if (namespace === NS_MEDIA && type === "MEDIA_STATUS") {
      // Absorbed before the pending lookup so an UNSOLICITED status (requestId
      // 0) still updates position — that is what most of them are.
      this.absorbMediaStatus(payload);
    }
    const requestId = Number(payload.requestId ?? 0);
    const waiting = this.pending.get(requestId);
    if (!waiting) return;
    if (waiting.expect === type) {
      this.pending.delete(requestId);
      waiting.resolve(payload);
      return;
    }
    if (waiting.failures.includes(type)) {
      this.pending.delete(requestId);
      // A plain Error, deliberately: `CastError` means "this message is already
      // fit for the screen", and a receiver's reply type is not. The caller maps
      // it, and passes a real CastError — a lost connection — straight through.
      waiting.reject(new Error(type));
    }
  }

  private absorbMediaStatus(payload: Record<string, unknown>): void {
    const entry = (payload.status as Record<string, unknown>[] | undefined)?.[0];
    if (!entry) return;
    if (typeof entry.mediaSessionId === "number") this.mediaSessionId = entry.mediaSessionId;
    const duration = (entry.media as { duration?: unknown } | undefined)?.duration;
    this.statusCb?.({
      state: playerState(entry.playerState),
      positionSec: typeof entry.currentTime === "number" ? entry.currentTime : 0,
      durationSec: typeof duration === "number" ? duration : null,
    });
  }

  /**
   * The one exit for every way this connection can end badly.
   *
   * Idempotent: a socket reports `error` and then `close`, and the user must not
   * be told twice. Pending requests are rejected here rather than left to time
   * out, because a LOAD that never settles is a spinner that never stops.
   */
  private fail(message: string): void {
    if (this.lost) return;
    this.lost = true;
    this.clearHeartbeat(this.heartbeat);
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      waiting.reject(new CastError(message));
    }
    this.lostCb?.(message);
  }
}
