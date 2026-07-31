import type { SourceId } from "../sources/types";
import type { DebridProviderId } from "../integrations/debrid/types";

// "selecting" = the fork's pre-download file picker state (choose which files
// to fetch before the transfer starts).
// "queued" = waiting for a free download slot (see TORLINK_MAX_DOWNLOADS). Unlike
// "paused" (an explicit user action) a queued item is started automatically as
// soon as a slot frees.
export type DownloadStatus =
  | "selecting"
  | "downloading"
  | "queued"
  | "paused"
  | "completed"
  | "failed";

export interface TorrentFileChoice {
  index: number;
  name: string;
  path: string;
  length: number;
}

// How an item is being fetched: classic peer-to-peer (webtorrent) or via a
// debrid service (resolve the magnet to direct links, then download over HTTP).
// `provider` says which service; see normalizeVia for the legacy value.
export type DownloadVia = "p2p" | "debrid";

// Debrid downloads move through: "queued" (waiting for a concurrency slot),
// "resolving" (the provider caches the torrent on its cloud), then
// "downloading" (we pull the direct links).
export type DownloadPhase = "queued" | "resolving" | "downloading";

/**
 * Read a persisted `via`. Items written before TorBox support used
 * `"realdebrid"` as the whole value; those are Real-Debrid by definition, so
 * the migration is lossless. Anything unrecognised (including absent) is
 * "p2p", which is what an item written before debrid support at all was.
 */
export function normalizeVia(raw: unknown): { via?: DownloadVia; provider?: DebridProviderId } {
  if (raw === "realdebrid") return { via: "debrid", provider: "realdebrid" };
  if (raw === "debrid") return { via: "debrid" };
  return { via: "p2p" };
}

export type SeedStatus = "seeding" | "paused" | "missing";

export interface SeedItem {
  id: string;
  name: string;
  source?: SourceId;
  magnet: string;
  dir: string;
  sizeBytes: number;
  status: SeedStatus;
  uploadSpeed: number;
  uploaded: number;
  peers: number;
}

export interface QueueItem {
  id: string;
  name: string;
  source?: SourceId;
  magnet: string;
  dir: string;
  status: DownloadStatus;
  progress: number;
  totalBytes: number;
  downloadedBytes: number;
  speed: number;
  peers: number;
  eta?: number;
  files?: number;
  availableFiles?: TorrentFileChoice[];
  selectedFileIndices?: number[];
  error?: string;
  addedAt: number;
  // Absent means "p2p" for back-compatibility with items persisted before
  // debrid support existed.
  via?: DownloadVia;
  // Which debrid service fetched this, when `via` is "debrid". Absent on a
  // debrid item means it predates the provider field, i.e. Real-Debrid.
  provider?: DebridProviderId;
  phase?: DownloadPhase;
  // For debrid items: the primary resolved direct URL, so it can be copied
  // from the downloads pane. Set once links are resolved.
  directUrl?: string;
  // For debrid items: the destination file paths on disk, recorded when the
  // download starts, so a cancel of a paused item can delete its partials.
  paths?: string[];
}
