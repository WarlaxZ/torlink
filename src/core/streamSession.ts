import { randomBytes, randomUUID } from "node:crypto";
import { streamTorrent, type TorrentStreamSession } from "../integrations/torrentStream";
import { resolveMagnet } from "../integrations/realdebrid";
import type { ResolveOptions } from "../integrations/realdebrid";
import type { StreamFile } from "../util/player";
import type { StreamRoute } from "./streamRoute";

export type StreamSessionState = "resolving" | "ready" | "error";
export type StreamBackend = "realdebrid" | "torrent";

export interface StreamSession {
  id: string;
  // Grants read access to this session's media for clients that cannot send an
  // Authorization header (<video>, <img>, VLC). Read-only and session-scoped.
  capability: string;
  backendHandle: TorrentStreamSession | null;
  // Which backend actually serves this session. Distinct from StartStreamInput's
  // `route`, which is the three-way routing decision that led here.
  backend: StreamBackend;
  name: string;
  state: StreamSessionState;
  // Upstream URLs: a Real-Debrid link, or a localhost WebTorrent URL. These stay
  // server-side; clients receive /stream/:sid/:idx handles instead (phase 2).
  files: StreamFile[];
  progress: number;
  error?: string;
  createdAt: number;
}

export type StreamTorrentImpl = (
  magnet: string,
  opts: { signal?: AbortSignal },
) => Promise<TorrentStreamSession>;

export type ResolveDebridImpl = (
  token: string,
  magnet: string,
  opts: ResolveOptions,
) => Promise<StreamFile[]>;

export interface StreamSessionDeps {
  streamTorrentImpl?: StreamTorrentImpl;
  resolveDebridImpl?: ResolveDebridImpl;
  idFactory?: () => string;
  capabilityFactory?: () => string;
  now?: () => number;
}

export interface StartStreamInput {
  infoHash: string;
  magnet: string;
  name: string;
  route: StreamRoute;
  // Required for the realdebrid route. Absent is an error, never a silent
  // downgrade to P2P: that would expose the user's IP after they deliberately
  // configured Real-Debrid.
  debridToken?: string;
}

export const NO_DEBRID_TOKEN = "No Real-Debrid token configured for this stream.";

/**
 * Owns live stream sessions for the whole process, so the TUI and the browser
 * see one list: a session started in the terminal is playable in a browser and
 * vice versa. One session type covers both backends — a Real-Debrid resolve and
 * a local WebTorrent swarm differ only in where `files` come from.
 */
export class StreamSessionRegistry {
  private readonly sessions = new Map<string, StreamSession>();
  // Cancellation lives beside the session rather than on it: `StreamSession` is
  // a data shape the web layer will serialise, and an AbortController is
  // neither serialisable nor any business of a client.
  private readonly aborts = new Map<string, AbortController>();
  private readonly streamTorrentImpl: StreamTorrentImpl;
  private readonly resolveDebridImpl: ResolveDebridImpl;
  private readonly idFactory: () => string;
  private readonly capabilityFactory: () => string;
  private readonly now: () => number;

  constructor(deps: StreamSessionDeps = {}) {
    this.streamTorrentImpl = deps.streamTorrentImpl ?? streamTorrent;
    this.resolveDebridImpl = deps.resolveDebridImpl ?? resolveMagnet;
    this.idFactory = deps.idFactory ?? (() => randomUUID());
    this.capabilityFactory = deps.capabilityFactory ?? (() => randomBytes(24).toString("base64url"));
    this.now = deps.now ?? Date.now;
  }

  list(): StreamSession[] {
    return [...this.sessions.values()];
  }

  get(id: string): StreamSession | null {
    return this.sessions.get(id) ?? null;
  }

  /**
   * Start a session and resolve once its files are known (or it has failed).
   * A failure is reported as `state: "error"` with the message the TUI would
   * have shown, not a thrown exception — both front-ends render it the same way.
   */
  async start(input: StartStreamInput): Promise<StreamSession> {
    const viaDebrid = input.route.kind === "realdebrid";
    const session: StreamSession = {
      id: this.idFactory(),
      capability: this.capabilityFactory(),
      backendHandle: null,
      backend: viaDebrid ? "realdebrid" : "torrent",
      name: input.name,
      state: "resolving",
      files: [],
      progress: 0,
      createdAt: this.now(),
    };
    this.sessions.set(session.id, session);
    const abort = new AbortController();
    this.aborts.set(session.id, abort);

    try {
      if (viaDebrid) {
        if (!input.debridToken) throw new Error(NO_DEBRID_TOKEN);
        session.files = await this.resolveDebridImpl(input.debridToken, input.magnet, {
          knownHash: input.infoHash,
          signal: abort.signal,
          onProgress: (percent) => {
            session.progress = percent;
          },
        });
      } else {
        const handle = await this.streamTorrentImpl(input.magnet, { signal: abort.signal });
        session.backendHandle = handle;
        session.files = handle.files;
        session.name = handle.name || input.name;
      }
      session.state = "ready";
      session.progress = 100;
    } catch (e) {
      // Includes the abort case: a session cancelled mid-resolve lands in
      // `error` with the backend's cancellation message, which is the state a
      // caller polling the registry should see.
      session.state = "error";
      session.error = e instanceof Error ? e.message : String(e);
      session.files = [];
    } finally {
      this.aborts.delete(session.id);
    }
    return session;
  }

  // Stop a session and forget it. `keep` is passed through to the WebTorrent
  // backend so a completed stream's files can be retained on disk.
  async stop(id: string, opts: { keep?: boolean } = {}): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    // Abort first, and unconditionally: a session still resolving has no handle
    // to stop, and without this the swarm it is joining (or the Real-Debrid
    // poll, which can sit in a stall window for minutes) would outlive it.
    this.aborts.get(id)?.abort();
    this.aborts.delete(id);
    if (session.backendHandle) {
      // A backend that fails to shut down cleanly is deliberately ignored: stop
      // is called on shutdown and while tearing other sessions down, where
      // there is nothing useful left to do with the error.
      await session.backendHandle.stop({ keep: opts.keep === true }).catch(() => {});
    }
  }

  // Stop everything — used on shutdown so no WebTorrent client outlives the app.
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
