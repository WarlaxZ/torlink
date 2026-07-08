import { EventEmitter } from "node:events";
import { TorrentEngine, type AddHandlers } from "./engine";
import {
  saveQueue,
  saveQueueSync,
  saveSeeds,
  saveSeedsSync,
  saveTorrentMeta,
  torrentMetaPath,
  torrentMetaExists,
  exportTorrentMeta,
  deleteTorrentMeta,
  type SeedRecord,
} from "./persist";
import { saveHistory, saveHistorySync, type HistoryItem } from "./history";
import { downloadFiles, sanitizeFilename } from "./http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { resolveMagnet, isTransient } from "../integrations/realdebrid";
import { Semaphore } from "../util/semaphore";
import { backoffDelay } from "../util/net";
import { log } from "../util/logger";
import { pickStreamFile } from "../util/player";
import type { QueueItem, SeedItem } from "./types";
import type { SourceId } from "../sources/types";

// Injection seam so the Real-Debrid pipeline can be stubbed in tests.
export interface DebridDeps {
  resolveMagnet: typeof resolveMagnet;
  downloadFiles: typeof downloadFiles;
  // Sleep between transient-failure requeues; defaults to real time.
  sleep?: (ms: number) => Promise<void>;
}

const defaultDebridDeps: DebridDeps = { resolveMagnet, downloadFiles };

// Compact, log-safe label for a queue item (short infoHash + short name). The
// name already lives in queue.json, so this leaks nothing new.
function rdLabel(id: string, name: string): string {
  return `${id.slice(0, 8)} ${name.slice(0, 40)}`;
}

/**
 * A real seed never pulls data off the network: verifying on-disk files reads
 * the disk (network speed stays 0), only fetching *missing* data raises it. So
 * sustained network download on a "seed" means its files are gone or partial.
 * Size-agnostic (a 50 GB verify never trips it) and cross-platform (webtorrent
 * owns the real on-disk paths, so we never guess sanitized filenames).
 */
export function strayDownload(s: { total: number; progress: number; speed: number }): boolean {
  return s.total > 0 && s.progress < 1 && s.speed > 0;
}

const STRAY_TICKS = 2; // consecutive stray polls before flagging missing (~1s)

// How long (ms) to let webtorrent verify on-disk pieces before the stray-download
// detector starts watching. Verification reads the disk and can briefly report
// downloadSpeed > 0 / progress < 1, which is indistinguishable from a truly
// missing file. 10 s covers most single-torrent verifications comfortably.
const SEED_GRACE_MS = 10_000;

const POLL_MS = 500;
const HISTORY_MAX = 500;

const MAX_ACTIVE_DEBRID = 2;
const MAX_DEBRID_ATTEMPTS = 3;
const DEBRID_BACKOFF_BASE_MS = 5_000;
const DEBRID_BACKOFF_CAP_MS = 60_000;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface AddInput {
  id: string;
  name: string;
  magnet: string;
  source?: SourceId;
  sizeBytes?: number;
}

export function seedPolicyReached(
  uploaded: number,
  sizeBytes: number,
  ageMs: number,
  ratio: number,
  minutes: number,
): boolean {
  return (ratio > 0 && sizeBytes > 0 && uploaded / sizeBytes >= ratio) ||
    (minutes > 0 && ageMs >= minutes * 60_000);
}

export class DownloadQueue extends EventEmitter {
  private items = new Map<string, QueueItem>();
  private engine = new TorrentEngine();
  private poll: ReturnType<typeof setInterval> | null = null;
  private history: HistoryItem[] = [];
  private seeds = new Map<string, SeedItem>();
  private strayHits = new Map<string, number>();
  private seedStartedAt = new Map<string, number>();
  // Real-Debrid bookkeeping: an abort handle per in-flight RD download, the
  // current token (kept fresh by the app so a retry can re-run), and the deps
  // used to drive the pipeline (overridable in tests).
  private debridAborts = new Map<string, AbortController>();
  private debridToken = "";
  private debridDeps: DebridDeps = defaultDebridDeps;
  private debridSem = new Semaphore(MAX_ACTIVE_DEBRID);
  private debridAttempts = new Map<string, number>();
  private trackers: string[] = [];
  private seedRatio = 0;
  private seedMinutes = 0;
  private p2pAllowed = true;

  setP2PAllowed(allowed: boolean): void {
    this.p2pAllowed = allowed;
    if (!allowed) this.killP2P();
  }

  // Extra announce URLs appended to every torrent added from now on.
  // Existing running torrents aren't retro-updated — the change takes effect
  // for the next add / resume / re-seed.
  setTrackers(trackers: string[]): void {
    this.trackers = trackers;
  }

  setTransferPolicy(policy: {
    downloadLimitKbps?: number;
    uploadLimitKbps?: number;
    seedRatio?: number;
    seedMinutes?: number;
  }): void {
    this.engine.setLimits(policy.downloadLimitKbps, policy.uploadLimitKbps);
    this.seedRatio = Math.max(0, policy.seedRatio ?? 0);
    this.seedMinutes = Math.max(0, policy.seedMinutes ?? 0);
  }

  getItems(): QueueItem[] {
    return [...this.items.values()].sort((a, b) => b.addedAt - a.addedAt);
  }

  get activeCount(): number {
    let n = 0;
    for (const it of this.items.values()) if (it.status === "downloading") n++;
    return n;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  add(input: AddInput, dir: string): void {
    if (this.seeds.has(input.id)) {
      this.engine.remove(input.id);
      this.seeds.delete(input.id);
      this.strayHits.delete(input.id);
      this.seedStartedAt.delete(input.id);
      void this.persistSeeds();
    }
    const existing = this.items.get(input.id);
    if (existing && existing.status !== "failed") return;
    const item: QueueItem = existing
      ? {
          ...existing,
          // A re-add is a fresh request, so it targets the dir asked for now.
          // Partial data doesn't follow to a new folder, so resume progress
          // only survives when the dir is unchanged.
          dir,
          status: "downloading",
          error: undefined,
          speed: 0,
          ...(existing.dir === dir
            ? {}
            : { progress: 0, downloadedBytes: 0, eta: undefined }),
        }
      : {
          id: input.id,
          name: input.name,
          source: input.source,
          magnet: input.magnet,
          dir,
          status: "downloading",
          progress: 0,
          totalBytes: input.sizeBytes ?? 0,
          downloadedBytes: 0,
          speed: 0,
          peers: 0,
          addedAt: Date.now(),
        };
    this.items.set(item.id, item);
    this.startEngine(item);
    this.ensurePoll();
    this.changed();
    void this.persist();
  }

  private startEngine(item: QueueItem): void {
    if (!this.p2pAllowed) {
      item.status = "paused";
      item.error = "VPN kill switch blocked peer-to-peer traffic.";
      return;
    }
    this.engine.add(
      item.id,
      item.magnet,
      item.dir,
      this.engineHandlers(item.id),
      this.trackers,
      item.selectedFileIndices,
    );
  }

  selectFiles(id: string, indices: number[]): boolean {
    const item = this.items.get(id);
    if (!item || item.status !== "selecting" || indices.length === 0) return false;
    const valid = [...new Set(indices)].filter((index) =>
      item.availableFiles?.some((file) => file.index === index),
    );
    if (valid.length === 0) return false;
    item.selectedFileIndices = valid;
    item.status = "downloading";
    item.totalBytes = (item.availableFiles ?? [])
      .filter((file) => valid.includes(file.index))
      .reduce((sum, file) => sum + file.length, 0);
    this.engine.selectFiles(id, valid);
    this.ensurePoll();
    this.changed();
    void this.persist();
    return true;
  }

  // Keep the queue's notion of the current Real-Debrid token in sync with config
  // so a retry (which has no token in hand) can re-run the pipeline.
  setRealDebridToken(token: string): void {
    this.debridToken = token;
  }

  // Download a magnet through Real-Debrid instead of P2P: resolve it to direct
  // links on RD's cloud, then pull those over HTTP into `dir`. The returned
  // promise settles when the whole pipeline finishes (success or failure) so the
  // app can `void` it while tests can await it.
  addDebrid(
    input: AddInput,
    dir: string,
    token: string,
    deps: DebridDeps = defaultDebridDeps,
  ): Promise<void> {
    this.debridToken = token;
    this.debridDeps = deps;
    if (this.seeds.has(input.id)) {
      this.engine.remove(input.id);
      this.seeds.delete(input.id);
      this.strayHits.delete(input.id);
      this.seedStartedAt.delete(input.id);
      void this.persistSeeds();
    }
    const existing = this.items.get(input.id);
    if (existing && existing.status !== "failed") return Promise.resolve();
    const item: QueueItem = {
      id: input.id,
      name: input.name,
      source: input.source,
      magnet: input.magnet,
      dir,
      via: "realdebrid",
      phase: "queued",
      status: "downloading",
      progress: 0,
      totalBytes: input.sizeBytes ?? 0,
      downloadedBytes: 0,
      speed: 0,
      peers: 0,
      addedAt: existing?.addedAt ?? Date.now(),
    };
    this.items.set(item.id, item);
    this.debridAttempts.set(item.id, 0);
    this.changed();
    log.info(`queue ${rdLabel(item.id, item.name)} queued`);
    void this.persist();
    return this.driveDebrid(item.id, token, deps);
  }

  // Schedule one Real-Debrid item: wait for a concurrency slot, run a single
  // pipeline attempt, and on a transient failure requeue with backoff until the
  // attempt budget is spent. Settles when the item reaches a terminal state.
  private async driveDebrid(id: string, token: string, deps: DebridDeps): Promise<void> {
    const sleep = deps.sleep ?? realSleep;
    for (;;) {
      const waiting = this.items.get(id);
      if (!waiting || waiting.status !== "downloading") return; // cancelled/removed while queued
      waiting.phase = "queued";
      waiting.speed = 0;
      this.changed();

      await this.debridSem.acquire();
      let retry = false;
      try {
        const it = this.items.get(id);
        if (!it || it.status !== "downloading") return; // cancelled while waiting for the slot
        await this.runDebrid(id, token, deps); // completes on success, throws on failure
        return;
      } catch (e) {
        // A pause aborted the pipeline: the item is already marked paused; leave
        // it (don't fail or requeue). The finally still releases the slot.
        if (this.items.get(id)?.status === "paused") return;
        const attempts = (this.debridAttempts.get(id) ?? 0) + 1;
        this.debridAttempts.set(id, attempts);
        const stillHere = this.items.get(id)?.status === "downloading";
        if (isTransient(e) && attempts < MAX_DEBRID_ATTEMPTS && stillHere) {
          retry = true;
          const it = this.items.get(id);
          if (it) {
            it.phase = "queued";
            it.speed = 0;
            this.changed();
            log.warn(
              `queue ${rdLabel(id, it.name)} requeue reason=transient attempt=${attempts}/${MAX_DEBRID_ATTEMPTS}`,
            );
          }
        } else {
          this.failDebrid(id, e);
          return;
        }
      } finally {
        this.debridSem.release();
      }
      if (!retry) return;
      const backoff = backoffDelay(
        this.debridAttempts.get(id) ?? 1,
        DEBRID_BACKOFF_BASE_MS,
        DEBRID_BACKOFF_CAP_MS,
        DEBRID_BACKOFF_BASE_MS,
      );
      log.debug(`queue ${id.slice(0, 8)} backoff=${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
    }
  }

  // One Real-Debrid attempt: resolve the magnet to direct links, then pull them
  // over HTTP. Completes the item on success; throws on any failure (the caller
  // decides whether to requeue or fail).
  private async runDebrid(id: string, token: string, deps: DebridDeps): Promise<void> {
    const ctrl = new AbortController();
    this.debridAborts.set(id, ctrl);
    try {
      const start = this.items.get(id);
      if (start) {
        start.phase = "resolving";
        this.changed();
        log.info(`queue ${rdLabel(id, start.name)} resolving`);
      }
      const files = await deps.resolveMagnet(token, this.items.get(id)?.magnet ?? "", {
        signal: ctrl.signal,
        knownHash: id, // queue item id is the torrent infoHash
        onProgress: (percent) => {
          const it = this.items.get(id);
          if (!it || it.status !== "downloading") return;
          it.phase = "resolving";
          // Reserve 100% for the actual file transfer; RD-side caching tops out at 99.
          it.progress = Math.min(99, Math.max(0, Math.round(percent)));
          this.changed();
        },
      });

      const it = this.items.get(id);
      if (!it || it.status !== "downloading") return; // cancelled mid-resolve
      // A multi-file torrent (a season, a movie with extras) gets its own
      // subfolder so files don't scatter into the download root or collide with
      // another torrent's files; a single file lands directly in the folder.
      const dest = files.length > 1 ? path.join(it.dir, sanitizeFilename(it.name)) : it.dir;
      it.phase = "downloading";
      it.progress = 0;
      it.directUrl = pickStreamFile(files)?.url;
      it.totalBytes = files.reduce((sum, f) => sum + (f.bytes || 0), 0) || it.totalBytes;
      it.paths = files.map((f) => path.join(dest, sanitizeFilename(f.filename)));
      this.changed();

      await deps.downloadFiles(files, dest, {
        signal: ctrl.signal,
        onProgress: (p) => {
          const cur = this.items.get(id);
          if (!cur || cur.status !== "downloading") return;
          if (p.total) cur.totalBytes = p.total;
          cur.downloadedBytes = p.downloaded;
          cur.speed = p.speed;
          cur.progress = p.total > 0 ? Math.min(100, Math.round((p.downloaded / p.total) * 100)) : cur.progress;
          this.changed();
        },
      });

      const done = this.items.get(id);
      if (done) this.completeDebrid(done);
    } finally {
      this.debridAborts.delete(id);
    }
  }

  // Mark a Real-Debrid item failed after its attempt budget is spent (or a
  // terminal error). A missing item means it was cancelled — nothing to do.
  private failDebrid(id: string, e: unknown): void {
    this.debridAttempts.delete(id);
    const it = this.items.get(id);
    if (!it) {
      this.maybeStopPoll();
      return;
    }
    it.status = "failed";
    it.error = e instanceof Error ? e.message : String(e);
    it.speed = 0;
    it.peers = 0;
    it.phase = undefined;
    log.warn(`queue ${rdLabel(id, it.name)} failed reason="${it.error}"`);
    this.changed();
    void this.persist();
    this.maybeStopPoll();
  }

  // Finish a Real-Debrid item: record it in history and drop it. Unlike a P2P
  // download we never seed it — there is no live torrent, and seeding would put
  // the user back on the swarm, defeating the privacy reason for using RD.
  private completeDebrid(it: QueueItem): void {
    this.debridAttempts.delete(it.id);
    if (it.totalBytes) it.downloadedBytes = it.totalBytes;
    it.progress = 100;
    it.speed = 0;
    it.phase = undefined;
    log.info(`queue ${rdLabel(it.id, it.name)} complete`);
    this.recordHistory(it);
    this.items.delete(it.id);
    this.emit("completed", it.name);
    this.changed();
    void this.persist();
    this.maybeStopPoll();
  }

  // One torrent serves an item across its whole life (download -> seed ->
  // missing), so the engine handlers are phase-aware: they look up the id in
  // `items` (still downloading) or `seeds` (finished, now seeding) and act on
  // whichever it currently is.
  private engineHandlers(id: string): AddHandlers {
    return {
      onMetadata: (meta) => {
        // Capture the .torrent metadata as soon as it arrives so a later re-seed
        // can verify the on-disk file locally (a bare magnet would have to
        // re-fetch this from the swarm, which fails for rare/dead torrents).
        if (meta.torrentFile) void saveTorrentMeta(id, meta.torrentFile);
        const it = this.items.get(id);
        if (!it) return; // the rest only matters while still downloading
        if (meta.name) it.name = meta.name;
        if (meta.total) it.totalBytes = meta.total;
        it.files = meta.files;
        it.availableFiles = meta.fileList;
        if (meta.fileList.length > 1 && !it.selectedFileIndices?.length) {
          it.status = "selecting";
          it.speed = 0;
        }
        this.changed();
        void this.persist();
      },
      onDone: () => {
        const it = this.items.get(id);
        if (it) {
          // Download finished: record it and keep the torrent seeding.
          if (it.totalBytes) it.downloadedBytes = it.totalBytes;
          this.complete(it);
          return;
        }
        // A re-seed (restart / manual resume) passed verification: the file is
        // confirmed on disk, so clear stray-detection state and end its grace.
        if (this.seeds.has(id)) {
          this.strayHits.set(id, 0);
          this.seedStartedAt.delete(id);
        }
      },
      onError: (msg) => {
        const it = this.items.get(id);
        if (it) {
          it.status = "failed";
          it.error = msg;
          it.speed = 0;
          it.peers = 0;
          this.changed();
          void this.persist();
          this.maybeStopPoll();
          return;
        }
        const sd = this.seeds.get(id);
        if (sd) {
          sd.status = "missing";
          sd.uploadSpeed = 0;
          sd.peers = 0;
          this.seedStartedAt.delete(id);
          this.changed();
          void this.persistSeeds();
          this.maybeStopPoll();
        }
      },
    };
  }

  private complete(it: QueueItem): void {
    this.recordHistory(it);
    this.items.delete(it.id);
    // Opt-out seeding: a finished download is already a complete, verified
    // torrent, so keep it alive and seeding instead of tearing it down.
    this.beginSeed(it);
    this.emit("completed", it.name);
    this.changed();
    void this.persist();
    this.maybeStopPoll();
  }

  // Adopt the just-finished download's live torrent as a seed in place: no
  // re-add, no re-verify (progress is already 1, so stray detection never
  // trips). Restart / manual resume go through startSeeding instead.
  private beginSeed(it: QueueItem): void {
    if (!it.magnet) return;
    this.seeds.set(it.id, {
      id: it.id,
      name: it.name,
      source: it.source,
      magnet: it.magnet,
      dir: it.dir,
      sizeBytes: it.totalBytes,
      status: "seeding",
      uploadSpeed: 0,
      uploaded: 0,
      peers: 0,
    });
    this.strayHits.set(it.id, 0);
    this.seedStartedAt.set(it.id, Date.now());
    this.ensurePoll();
    void this.persistSeeds();
  }

  private tick(): void {
    let any = false;
    for (const it of this.items.values()) {
      if (it.status !== "downloading") continue;
      // Real-Debrid items have no webtorrent engine; they push their own
      // progress through the resolve/download callbacks, so leave them alone.
      if (it.via === "realdebrid") continue;
      const s = this.engine.stats(it.id);
      if (!s) continue;
      it.progress = Math.min(100, Math.round(s.progress * 100));
      it.downloadedBytes = s.downloaded;
      if (s.total) it.totalBytes = s.total;
      it.speed = s.speed;
      it.peers = s.peers;
      it.eta =
        s.timeRemaining > 0 && Number.isFinite(s.timeRemaining)
          ? s.timeRemaining / 1000
          : undefined;
      if (s.name) it.name = s.name;
      any = true;
    }
    const now = Date.now();
    for (const sd of this.seeds.values()) {
      if (sd.status !== "seeding") continue;
      const s = this.engine.stats(sd.id);
      if (!s) continue;
      // Safety-net: a seed that's pulling data has lost its files on disk. Give
      // it a couple of ticks (ignore a one-piece repair blip), then stop it and
      // flag missing, never re-download the whole thing.
      //
      // Skip seeds still inside the grace period: webtorrent needs time to
      // hash-verify on-disk pieces, and during that window progress < 1 with
      // downloadSpeed > 0 is perfectly normal.
      const age = now - (this.seedStartedAt.get(sd.id) ?? 0);
      if (seedPolicyReached(s.uploaded, sd.sizeBytes, age, this.seedRatio, this.seedMinutes)) {
        this.engine.remove(sd.id);
        this.seedStartedAt.delete(sd.id);
        sd.status = "paused";
        sd.uploadSpeed = 0;
        sd.uploaded = s.uploaded;
        sd.peers = 0;
        void this.persistSeeds();
        any = true;
        continue;
      }
      if (age > SEED_GRACE_MS && strayDownload(s)) {
        const hits = (this.strayHits.get(sd.id) ?? 0) + 1;
        this.strayHits.set(sd.id, hits);
        if (hits >= STRAY_TICKS) {
          this.engine.remove(sd.id);
          this.strayHits.delete(sd.id);
          this.seedStartedAt.delete(sd.id);
          sd.status = "missing";
          sd.uploadSpeed = 0;
          sd.peers = 0;
          void this.persistSeeds();
        }
        any = true;
        continue;
      }
      this.strayHits.set(sd.id, 0);
      sd.uploadSpeed = s.uploadSpeed;
      sd.uploaded = s.uploaded;
      sd.peers = s.peers;
      any = true;
    }
    if (any) this.changed();
  }

  private ensurePoll(): void {
    if (this.poll) return;
    this.poll = setInterval(() => this.tick(), POLL_MS);
    this.poll.unref();
  }

  private maybeStopPoll(): void {
    if (this.activeCount === 0 && this.seedingCount === 0 && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  pause(id: string): void {
    const it = this.items.get(id);
    if (!it || it.status !== "downloading") return;
    if (it.via === "realdebrid") {
      // Abort the in-flight pipeline with a "pause" reason so downloadFiles keeps
      // the partial file(s); driveDebrid sees the paused status and won't fail it.
      it.status = "paused";
      it.speed = 0;
      it.peers = 0;
      it.eta = undefined;
      it.phase = undefined;
      it.directUrl = undefined; // resolved link expires; resume re-resolves a fresh one
      this.debridAborts.get(id)?.abort("pause");
      this.changed();
      void this.persist();
      this.maybeStopPoll();
      return;
    }
    it.status = "paused";
    it.speed = 0;
    it.peers = 0;
    it.eta = undefined;
    this.engine.remove(id);
    this.changed();
    void this.persist();
    this.maybeStopPoll();
  }

  resume(id: string): void {
    const it = this.items.get(id);
    if (!it || it.status !== "paused") return;
    if (it.via === "realdebrid") {
      if (!this.debridToken) {
        it.status = "failed";
        it.error = "Set a Real-Debrid token, then download again.";
        this.changed();
        return;
      }
      // Re-run the pipeline: re-resolve for a fresh link, then downloadFiles
      // continues each partial file via HTTP Range from its on-disk size.
      it.status = "downloading";
      it.error = undefined;
      this.debridAttempts.set(id, 0);
      this.changed();
      void this.persist();
      void this.driveDebrid(id, this.debridToken, this.debridDeps);
      return;
    }
    it.status = "downloading";
    this.startEngine(it);
    this.ensurePoll();
    this.changed();
    void this.persist();
  }

  togglePause(id: string): void {
    const it = this.items.get(id);
    if (!it) return;
    if (it.status === "downloading") this.pause(id);
    else if (it.status === "paused") this.resume(id);
  }

  killP2P(): void {
    for (const item of this.items.values()) {
      if (item.via === "realdebrid" || item.status !== "downloading") continue;
      item.status = "paused";
      item.speed = 0;
      item.peers = 0;
      this.engine.remove(item.id);
    }
    for (const seed of this.seeds.values()) {
      if (seed.status !== "seeding") continue;
      seed.status = "paused";
      seed.uploadSpeed = 0;
      seed.peers = 0;
      this.engine.remove(seed.id);
    }
    this.changed();
    void this.persist();
    void this.persistSeeds();
    this.maybeStopPoll();
  }

  // Delete a Real-Debrid item's partial files on disk (used when cancelling a
  // paused item whose pipeline has already unwound). Best-effort; never throws.
  private cleanupDebridFiles(it: QueueItem): void {
    if (it.via !== "realdebrid" || !it.paths || it.paths.length === 0) return;
    const paths = it.paths;
    void (async () => {
      for (const p of paths) await fs.rm(p, { force: true }).catch(() => {});
      // Remove a now-empty per-item subfolder (multi-file downloads); never the
      // shared download root (single-file downloads write directly into it.dir).
      const parent = path.dirname(paths[0]!);
      if (parent !== it.dir) await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
    })();
  }

  exportTorrentFile(id: string): Promise<string | null> {
    const it = this.items.get(id) ?? this.seeds.get(id) ?? this.history.find((h) => h.id === id);
    if (!it) return Promise.resolve(null);
    return exportTorrentMeta(it.id, it.name, it.dir);
  }

  cancel(id: string): void {
    const it = this.items.get(id);
    if (!it) return;
    // Abort an in-flight Real-Debrid transfer first; the HTTP downloader cleans
    // up its own partial files once the signal fires.
    this.debridAborts.get(id)?.abort("cancel");
    this.debridAttempts.delete(id);
    this.cleanupDebridFiles(it);
    this.engine.remove(id);
    this.items.delete(id);
    deleteTorrentMeta(id);
    this.changed();
    void this.persist();
    this.maybeStopPoll();
  }

  retry(id: string): void {
    const it = this.items.get(id);
    if (!it || it.status !== "failed") return;
    it.status = "downloading";
    it.error = undefined;
    if (it.via === "realdebrid") {
      // No token (e.g. retried after a restart): can't re-run, tell the user.
      if (!this.debridToken) {
        it.status = "failed";
        it.error = "Set a Real-Debrid token, then download again.";
        this.changed();
        return;
      }
      it.phase = "queued";
      it.progress = 0;
      it.speed = 0;
      this.debridAttempts.set(id, 0);
      this.changed();
      void this.persist();
      void this.driveDebrid(id, this.debridToken, this.debridDeps);
      return;
    }
    this.startEngine(it);
    this.ensurePoll();
    this.changed();
    void this.persist();
  }

  retryFailed(): void {
    for (const it of [...this.items.values()]) {
      if (it.status === "failed") this.retry(it.id);
    }
  }

  getSeed(id: string): SeedItem | undefined {
    return this.seeds.get(id);
  }

  getSeeds(): SeedItem[] {
    return [...this.seeds.values()];
  }

  get seedingCount(): number {
    let n = 0;
    for (const s of this.seeds.values()) if (s.status === "seeding") n++;
    return n;
  }

  startSeeding(h: HistoryItem): void {
    if (this.seeds.get(h.id)?.status === "seeding") return;
    if (this.items.has(h.id)) return; // don't seed a file that's downloading

    const base: SeedItem = {
      id: h.id,
      name: h.name,
      source: h.source,
      magnet: h.magnet,
      dir: h.dir,
      sizeBytes: h.sizeBytes,
      status: "seeding",
      uploadSpeed: 0,
      uploaded: 0,
      peers: 0,
    };

    // Only hard guard we can make synchronously and portably: no magnet, no seed.
    // We do NOT guess the on-disk path (webtorrent sanitizes names per-OS); we
    // let it verify the real files and the poll safety-net flags a missing one.
    if (!h.magnet) {
      this.seeds.set(h.id, { ...base, status: "missing" });
      this.changed();
      void this.persistSeeds();
      return;
    }

    this.seeds.set(h.id, base);
    this.strayHits.set(h.id, 0);
    this.seedStartedAt.set(h.id, Date.now());
    // Seed from the stored .torrent metadata when we have it (verifies the local
    // file immediately, no swarm needed); fall back to the magnet otherwise.
    const source = torrentMetaExists(h.id) ? torrentMetaPath(h.id) : h.magnet;
    this.engine.add(h.id, source, h.dir, this.engineHandlers(h.id), this.trackers);
    this.ensurePoll();
    this.changed();
    void this.persistSeeds();
  }

  stopSeeding(id: string): void {
    const s = this.seeds.get(id);
    if (!s) return;
    this.engine.remove(id);
    this.strayHits.delete(id);
    this.seedStartedAt.delete(id);
    if (s.status === "seeding") {
      s.status = "paused";
      s.uploadSpeed = 0;
      s.peers = 0;
    }
    this.changed();
    void this.persistSeeds();
    this.maybeStopPoll();
  }

  toggleSeeding(h: HistoryItem): void {
    if (this.seeds.get(h.id)?.status === "seeding") this.stopSeeding(h.id);
    else this.startSeeding(h);
  }

  restoreSeeds(records: SeedRecord[]): void {
    for (const r of records) {
      const h = this.history.find((x) => x.id === r.id);
      if (!h) continue;
      // Respect the persisted choice: resume seeders, but leave a paused seed
      // paused (and visibly so) instead of auto-starting it.
      if (r.status === "seeding") this.startSeeding(h);
      else this.restorePaused(h);
    }
  }

  // Rebuild a paused seed from history without touching the engine, so it shows
  // as paused and stays off until the user presses p to resume it.
  private restorePaused(h: HistoryItem): void {
    if (this.seeds.has(h.id)) return;
    this.seeds.set(h.id, {
      id: h.id,
      name: h.name,
      source: h.source,
      magnet: h.magnet,
      dir: h.dir,
      sizeBytes: h.sizeBytes,
      status: "paused",
      uploadSpeed: 0,
      uploaded: 0,
      peers: 0,
    });
    this.changed();
  }

  private seedRecords(): SeedRecord[] {
    const out: SeedRecord[] = [];
    for (const s of this.seeds.values()) {
      // "missing" is a runtime detection (file gone); persist it as paused so we
      // remember the user had it without auto-seeding a file that isn't there.
      if (s.status === "seeding") out.push({ id: s.id, status: "seeding" });
      else out.push({ id: s.id, status: "paused" });
    }
    return out;
  }

  private persistSeeds(): Promise<void> {
    return saveSeeds(this.seedRecords()).catch(() => {});
  }

  restore(items: QueueItem[]): void {
    for (const raw of items) {
      // A Real-Debrid transfer can't be resumed across a restart (no resolved
      // links, possibly no token), so surface it as a retryable failure rather
      // than handing its magnet to webtorrent (which would silently switch it
      // to P2P).
      if (raw.via === "realdebrid" && raw.status === "downloading") {
        raw.status = "failed";
        raw.error = "Interrupted — download again via Real-Debrid.";
        raw.phase = undefined;
        raw.speed = 0;
        raw.peers = 0;
      }
      this.items.set(raw.id, raw);
      if (raw.status === "downloading" || raw.status === "selecting") this.startEngine(raw);
    }
    if (this.activeCount > 0) this.ensurePoll();
    this.changed();
  }

  restoreHistory(items: HistoryItem[]): void {
    this.history = items.slice(0, HISTORY_MAX);
  }

  getHistory(): HistoryItem[] {
    return this.history;
  }

  private recordHistory(it: QueueItem): void {
    const rec: HistoryItem = {
      id: it.id,
      name: it.name,
      source: it.source,
      sizeBytes: it.totalBytes,
      magnet: it.magnet,
      dir: it.dir,
      via: it.via ?? "p2p",
      completedAt: Date.now(),
    };
    this.history = [rec, ...this.history.filter((h) => h.id !== it.id)].slice(0, HISTORY_MAX);
    void saveHistory(this.history).catch(() => {});
  }

  removeHistory(id: string): void {
    const next = this.history.filter((h) => h.id !== id);
    if (next.length === this.history.length) return;
    this.history = next;
    if (this.seeds.has(id)) {
      this.engine.remove(id);
      this.seeds.delete(id);
      this.strayHits.delete(id);
      this.seedStartedAt.delete(id);
      void this.persistSeeds();
      this.maybeStopPoll();
    }
    deleteTorrentMeta(id);
    void saveHistory(this.history).catch(() => {});
    this.changed();
  }

  clearHistory(): void {
    if (this.history.length === 0) return;
    for (const h of this.history) deleteTorrentMeta(h.id);
    this.history = [];
    if (this.seeds.size > 0) {
      for (const id of this.seeds.keys()) this.engine.remove(id);
      this.seeds.clear();
      this.strayHits.clear();
      this.seedStartedAt.clear();
      void this.persistSeeds();
      this.maybeStopPoll();
    }
    void saveHistory(this.history).catch(() => {});
    this.changed();
  }

  private changed(): void {
    this.emit("update");
  }

  private async persist(): Promise<void> {
    await saveQueue(this.getItems()).catch(() => {});
  }

  // Synchronously flush every state file from current memory. Used on quit so
  // nothing depends on in-flight async writes surviving the hard exit, and so
  // history / seeds can never be lost mid-write. Touches no engine state, so it
  // can never block shutdown.
  persistSync(): void {
    saveQueueSync(this.getItems());
    saveHistorySync(this.history);
    saveSeedsSync(this.seedRecords());
  }

  suspend(): void {
    // Keep active downloads as "downloading" so restore() resumes them on the
    // next launch (mirroring how seeds auto-restore); just zero the live stats.
    for (const it of this.items.values()) {
      if (it.status === "downloading") {
        it.speed = 0;
        it.peers = 0;
        it.eta = undefined;
      }
    }
    this.persistSync();
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    this.engine.destroy();
  }
}
