import { randomBytes, randomUUID } from "node:crypto";
import { streamTorrent, type TorrentStreamSession } from "../integrations/torrentStream";
import { getDebridProvider } from "../integrations/debrid";
import type { DebridProviderId, ResolveOptions } from "../integrations/debrid/types";
import type { StreamFile } from "../util/player";
import type { StreamRoute } from "./streamRoute";

export type StreamSessionState = "resolving" | "ready" | "error";
export type StreamBackend = "debrid" | "torrent";

export interface StreamSession {
  id: string;
  // Grants read access to this session's media for clients that cannot send an
  // Authorization header (<video>, <img>, VLC). Read-only and session-scoped.
  capability: string;
  backendHandle: TorrentStreamSession | null;
  // Which backend actually serves this session. Distinct from StartStreamInput's
  // `route`, which is the three-way routing decision that led here.
  backend: StreamBackend;
  // Which debrid service served it, when `backend` is "debrid".
  provider?: DebridProviderId;
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
  provider: DebridProviderId,
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
  // Required for the debrid route. Absent is an error, never a silent
  // downgrade to P2P: that would expose the user's IP after they deliberately
  // configured a debrid service.
  debridToken?: string;
  // Which provider `debridToken` belongs to. Required for the debrid route.
  debridProvider?: DebridProviderId;
}

export const NO_DEBRID_TOKEN = "No debrid token configured for this stream.";

/**
 * Owns live stream sessions for the whole process, so the TUI and the browser
 * see one list: a session started in the terminal is playable in a browser and
 * vice versa. One session type covers both backends — a debrid resolve and
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
    this.resolveDebridImpl =
      deps.resolveDebridImpl ??
      ((provider, token, magnet, opts) => getDebridProvider(provider).resolveMagnet(token, magnet, opts));
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
    return this.begin(input).done;
  }

  /**
   * Register a session and resolve it in the background, returning as soon as
   * the session object exists.
   *
   * This is the split `start()` needs for an HTTP caller. The TUI can sit on a
   * promise for as long as Real-Debrid takes to cache a torrent (minutes, with
   * a progress bar); a `POST /api/stream` cannot — a browser, and anything
   * proxying for it, will have given up long before, and the user would be left
   * with a session running server-side that they never got an id for. So the
   * route answers immediately with a `resolving` session and polls
   * `GET /api/stream/:sid`, which sees the same object being mutated in place.
   *
   * `done` settles when the session reaches `ready` or `error` and never
   * rejects, so a caller that drops it cannot produce an unhandled rejection.
   */
  begin(input: StartStreamInput): { session: StreamSession; done: Promise<StreamSession> } {
    const viaDebrid = input.route.kind === "debrid";
    const session: StreamSession = {
      id: this.idFactory(),
      capability: this.capabilityFactory(),
      backendHandle: null,
      backend: viaDebrid ? "debrid" : "torrent",
      ...(viaDebrid && input.route.kind === "debrid" ? { provider: input.route.provider } : {}),
      name: input.name,
      state: "resolving",
      files: [],
      progress: 0,
      createdAt: this.now(),
    };
    this.sessions.set(session.id, session);
    const abort = new AbortController();
    this.aborts.set(session.id, abort);
    return { session, done: this.resolveInto(session, input, abort) };
  }

  // The body of a session's resolve. Separate from begin() only so begin() can
  // return before this runs; every state transition still happens in here, on
  // the object already in the registry.
  private async resolveInto(
    session: StreamSession,
    input: StartStreamInput,
    abort: AbortController,
  ): Promise<StreamSession> {
    const viaDebrid = input.route.kind === "debrid";
    try {
      if (viaDebrid) {
        const provider = input.debridProvider ?? (input.route.kind === "debrid" ? input.route.provider : undefined);
        if (!input.debridToken || !provider) throw new Error(NO_DEBRID_TOKEN);
        session.files = await this.resolveDebridImpl(provider, input.debridToken, input.magnet, {
          knownHash: input.infoHash,
          signal: abort.signal,
          onProgress: (percent) => {
            session.progress = percent;
          },
        });
      } else {
        const handle = await this.streamTorrentImpl(input.magnet, { signal: abort.signal });
        // A stop() that landed while we were joining the swarm has already
        // removed this session, but a backend that ignored its signal still
        // handed us a live client. Assigning it would strand a swarm and its
        // temp directory past shutdown with nothing holding a reference, so
        // discard it instead — this is what makes stopAll's guarantee hold for
        // any backend, not just the ones that honour cancellation.
        if (!this.sessions.has(session.id)) {
          await handle.stop({ keep: false }).catch(() => {});
          throw new Error("Stream stopped before it was ready.");
        }
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
