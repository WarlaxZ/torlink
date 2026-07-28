// Headless runtime: drive the download queue without the Ink TUI.
//
// The TUI is one front-end over DownloadQueue; a seedbox needs another that has
// no terminal at all. This mirrors App.tsx's boot sequence (load config, restore
// queue/history/seeds) so a headless run resumes exactly what an interactive one
// would, then exposes a single addInput() the watch folder and HTTP API share.

import { promises as fs } from "node:fs";
import { type Config, loadConfig, resolveRealDebridToken } from "../config/config";
import { DownloadQueue } from "../download/queue";
import { loadQueue, loadSeeds } from "../download/persist";
import { loadHistory } from "../download/history";
import { reconcileQueue } from "../download/reconcile";
import {
  BOOT_SETTLE_MS,
  armBootMarker,
  disarmBootMarker,
  wasBootInterrupted,
} from "../download/bootguard";
import { parseInput } from "../sources/magnet";
import { magnetFromTorrentFile } from "../sources/torrentFile";
import { StreamSessionRegistry } from "../core/streamSession";

export interface Runtime {
  queue: DownloadQueue;
  downloadDir: string;
  // Live stream sessions, shared by every front-end in this process: a stream
  // started in the TUI is playable from the browser and vice versa.
  sessions: StreamSessionRegistry;
  // True when the previous run died mid-restore and this boot came up in safe
  // mode: everything paused, no engines started (see download/bootguard.ts).
  recovered?: boolean;
}

// One line describing the policy the queue was just given, so a headless run
// makes its limits discoverable the way it already prints its listen address
// and download dir. A seedbox that was uncapped before this shipped needs to be
// able to see, in its own log, why it is now capped.
export function policySummary(cfg: Config): string {
  const rate = (kbps?: number): string => (kbps && kbps > 0 ? `${kbps} KB/s` : "unlimited");
  const parts = [
    `down ${rate(cfg.downloadLimitKbps)}`,
    `up ${rate(cfg.uploadLimitKbps)}`,
    `seed ratio ${cfg.seedRatio && cfg.seedRatio > 0 ? cfg.seedRatio : "off"}`,
    `seed time ${cfg.seedMinutes && cfg.seedMinutes > 0 ? `${cfg.seedMinutes}m` : "off"}`,
    `real-debrid ${resolveRealDebridToken(cfg) ? "on" : "off"}`,
  ];
  return `policy: ${parts.join(" · ")}`;
}

// Build a queue and restore persisted state, matching the TUI's boot order
// (history before seeds — seeds resolve against history). `downloadDir` falls
// back to the saved config's dir when the caller doesn't override it.
export async function startRuntime(overrideDir?: string): Promise<Runtime> {
  const cfg = await loadConfig();
  const queue = new DownloadQueue();
  queue.setTrackers(cfg.trackers);
  // Everything below matches App.tsx's boot: without it a headless run ignores
  // the configured transfer limits, never auto-stops a seed, and fails a
  // resumed Real-Debrid download with "set a token" for a token that is set.
  queue.setTransferPolicy(cfg);
  // resolveRealDebridToken, not cfg.realDebridToken: REALDEBRID_API_TOKEN wins
  // over the file, and the two front-ends must agree on which token is live.
  queue.setRealDebridToken(resolveRealDebridToken(cfg));
  // Deliberately no setP2PAllowed here. In the TUI it isn't a setting but a
  // 1 Hz vpnRouteIsSafe() loop; a one-shot check at boot would go stale and
  // look like a kill switch that isn't one. A configured vpnInterface gets the
  // loud warning below instead of silent, absent protection.
  console.log(`[torlink] ${policySummary(cfg)}`);
  if (cfg.vpnInterface?.trim()) {
    console.error(
      `[torlink] warning: VPN kill switch (${cfg.vpnInterface.trim()}) is not enforced headlessly; ` +
        "it only runs in the interactive TUI.",
    );
  }
  // Crash-boot breaker, mirroring the TUI: a marker left by the previous run
  // means it died mid-restore, so restore paused with the engine cold.
  const safe = wasBootInterrupted();
  armBootMarker();
  queue.restore(reconcileQueue(await loadQueue()), { safe });
  queue.restoreHistory(await loadHistory());
  queue.restoreSeeds(await loadSeeds(), { safe });
  setTimeout(disarmBootMarker, BOOT_SETTLE_MS).unref();
  if (safe) {
    console.error("[torlink] recovered from a crashed start: restored downloads are paused");
  }
  const downloadDir = overrideDir && overrideDir.trim() ? overrideDir.trim() : cfg.downloadDir;
  return { queue, downloadDir, sessions: new StreamSessionRegistry(), recovered: safe };
}

export type AddOutcome = "added" | "duplicate" | "invalid";

// Turn a magnet URI, bare info hash, or a path to a .torrent file into a queued
// download. Deduplicates by info hash (the queue's own id), so re-submitting the
// same torrent is a no-op rather than a restart. Never throws — bad input is
// reported as "invalid" so callers (a watcher, an HTTP handler) can fail soft.
export interface AddInputOptions {
  // Treat an input ending in .torrent as a local file path and read it. Only
  // the watch folder opts in; a network caller (the HTTP add API) must never
  // be able to point the daemon at the local filesystem.
  allowTorrentPath?: boolean;
  /**
   * Display name for the queue row, overriding whatever the magnet carried.
   *
   * THIS IS WHAT MAKES A HASH-ONLY ADD USABLE. `parseInput` takes the name from
   * the magnet's `dn` parameter, and a bare info hash has none — so it falls
   * back to the hash itself and the queue shows a row called
   * "1f9c3a…". The browser's search results deliberately carry no magnet (see
   * `PublicSearchResult` in src/web/wire.ts: it is ~6MB per search), only a
   * hash and a name, so without this every add from the browser would be
   * hash-named. Blank/whitespace falls back to the parsed name rather than
   * clearing it.
   */
  name?: string;
  /**
   * Fetch through Real-Debrid with this token instead of joining the swarm.
   *
   * Mirrors the TUI's `startDebridDownload`: same `queue.addDebrid`, same
   * fire-and-forget drive. The token is passed in rather than read from config
   * here so the decision of *whether* to use Real-Debrid stays with the caller
   * — the TUI asks the user, and the web layer requires an explicit `via`. An
   * add that silently chose the network for you is the one outcome both
   * front-ends are built to avoid.
   */
  debridToken?: string;
  /** Total size in bytes when the caller knows it; seeds the row's progress total. */
  sizeBytes?: number;
}

export async function addInput(
  runtime: Runtime,
  input: string,
  options: AddInputOptions = {},
): Promise<AddOutcome> {
  const trimmed = input.trim();
  let parsed;
  if (/\.torrent$/i.test(trimmed)) {
    if (!options.allowTorrentPath) return "invalid";
    parsed = await magnetFromTorrentFile(trimmed);
  } else {
    parsed = parseInput(trimmed);
  }
  if (!parsed) return "invalid";
  if (runtime.queue.has(parsed.infoHash)) return "duplicate";
  await fs.mkdir(runtime.downloadDir, { recursive: true }).catch(() => {});
  const item = {
    id: parsed.infoHash,
    name: options.name?.trim() || parsed.name,
    magnet: parsed.magnet,
    ...(options.sizeBytes !== undefined ? { sizeBytes: options.sizeBytes } : {}),
  };
  if (options.debridToken) {
    // Not awaited, exactly as the TUI does it: addDebrid's promise resolves
    // when the whole download finishes (or fails), which is minutes away. The
    // queue row exists synchronously, which is what "added" means here.
    void runtime.queue.addDebrid(item, runtime.downloadDir, options.debridToken);
    return "added";
  }
  runtime.queue.add(item, runtime.downloadDir);
  return "added";
}
