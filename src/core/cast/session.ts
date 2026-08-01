import { loadConfig, saveConfig } from "../../config/config";
import { markWatched } from "../../util/favouriteList";
import { loadStreamHistory, recordPlayedFile, saveStreamHistory } from "../streamHistory";
import { CastConnection, type CastMediaRequest, type CastStatus } from "./connection";
import type { CastDevice } from "./discover";

/**
 * The one active cast in this process.
 *
 * One, deliberately: a second would be a second thing claiming the same screen,
 * and there is nowhere on either front end to show two.
 *
 * NOTE THE PER-PROCESS LIMIT, which is honest rather than hidden. The TUI and
 * `serve --web` are separate processes, so a cast started in one is invisible to
 * the other — except where the TUI is hosting the web UI itself (shift+w), which
 * is one process and therefore one registry. Sharing it across processes needs a
 * TUI↔daemon RPC that does not exist.
 */

export interface ActiveCast {
  device: CastDevice;
  sid: string;
  index: number;
  title: string;
  status: CastStatus;
}

export interface StartCastInput {
  device: CastDevice;
  sid: string;
  index: number;
  /** For the played-file write — the key every store in the app is written under. */
  infoHash: string;
  filename: string;
  /** What to show on screen and on the television. */
  title: string;
  media: CastMediaRequest;
}

export type MarkPlayed = (infoHash: string, filename: string) => Promise<void>;

export interface CastRegistryDeps {
  openConnection?: (device: CastDevice) => Promise<CastConnection>;
  markPlayed?: MarkPlayed;
}

/**
 * Advance the same two stores a local play advances.
 *
 * Read-modify-write, never a held snapshot: a `serve --web` process may be
 * running against this same file. Same reference back means nothing moved, which
 * is the write gate — exactly what the browser's "watched" route does, and for
 * the same reason (this fires on every play, and churning config.json on every
 * re-watch is what the check avoids).
 */
const defaultMarkPlayed: MarkPlayed = async (infoHash, filename) => {
  const config = await loadConfig();
  const current = config.favourites ?? [];
  const favourites = markWatched(current, infoHash, filename);
  if (favourites !== current) await saveConfig({ ...config, favourites });
  const history = await loadStreamHistory();
  const advanced = recordPlayedFile(history, infoHash, filename);
  if (advanced !== history) await saveStreamHistory(advanced);
};

/** Nothing has been read off the file yet, so nothing claims a position. */
const INITIAL_STATUS: CastStatus = { state: "loading", positionSec: 0, durationSec: null };

export class CastSessionRegistry {
  private cast: ActiveCast | null = null;
  private connection: CastConnection | null = null;
  private notice: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly openConnection: (device: CastDevice) => Promise<CastConnection>;
  private readonly markPlayed: MarkPlayed;

  constructor(deps: CastRegistryDeps = {}) {
    this.openConnection = deps.openConnection ?? ((device) => CastConnection.open(device));
    this.markPlayed = deps.markPlayed ?? defaultMarkPlayed;
  }

  active(): ActiveCast | null {
    return this.cast;
  }

  /**
   * The message left by a cast that ended badly, cleared by reading it.
   *
   * Once, because both front ends read this and only one should show it.
   */
  takeNotice(): string | null {
    const notice = this.notice;
    this.notice = null;
    return notice;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  async start(input: StartCastInput): Promise<ActiveCast> {
    // Close whatever was casting first, so two connections never hold two
    // televisions at once.
    await this.teardown();
    const connection = await this.openConnection(input.device);
    try {
      await connection.load(input.media);
    } catch (e) {
      // Nothing is left claiming to be playing, and nothing is marked played.
      connection.close();
      throw e;
    }
    const cast: ActiveCast = {
      device: input.device,
      sid: input.sid,
      index: input.index,
      title: input.title,
      status: INITIAL_STATUS,
    };
    this.cast = cast;
    this.connection = connection;
    connection.onStatus((status) => {
      if (this.connection !== connection || !this.cast) return;
      this.cast = { ...this.cast, status };
      this.emit();
    });
    connection.onLost((message) => {
      // A connection that has already been replaced closing is the expected
      // consequence of replacing it, not a failure to report.
      if (this.connection !== connection) return;
      this.connection = null;
      this.cast = null;
      this.notice = message;
      this.emit();
    });
    this.emit();
    try {
      await this.markPlayed(input.infoHash, input.filename);
    } catch {
      // A convenience list must never fail a play the user already started —
      // the rule `recordStreamHistory` follows in the TUI.
    }
    return cast;
  }

  async play(): Promise<void> {
    await this.command((c) => c.play());
  }

  async pause(): Promise<void> {
    await this.command((c) => c.pause());
  }

  /**
   * Stop casting.
   *
   * Tolerant of nothing casting: stopping nothing is what the caller wanted, and
   * a stop button that errors is worse than one that does nothing.
   */
  async stop(): Promise<void> {
    await this.teardown();
    this.emit();
  }

  private async command(run: (c: CastConnection) => Promise<void>): Promise<void> {
    if (!this.connection) throw new Error("Nothing is casting.");
    await run(this.connection);
  }

  private async teardown(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    this.connection = null;
    this.cast = null;
    // The device's own player is quit before the socket goes, so the television
    // returns to its own screen rather than sitting on a stalled frame.
    await connection.stop().catch(() => {});
    connection.close();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
