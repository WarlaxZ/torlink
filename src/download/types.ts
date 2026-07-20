import type { SourceId } from "../sources/types";

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

// How an item is being fetched: classic peer-to-peer (webtorrent) or via
// Real-Debrid (resolve the magnet to direct links, then download over HTTP).
export type DownloadVia = "p2p" | "realdebrid";

// Real-Debrid downloads move through: "queued" (waiting for a concurrency slot),
// "resolving" (RD caches the torrent on its cloud), then "downloading" (we pull
// the direct links).
export type DownloadPhase = "queued" | "resolving" | "downloading";

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
  // Real-Debrid support existed.
  via?: DownloadVia;
  phase?: DownloadPhase;
  // For Real-Debrid items: the primary resolved direct URL, so it can be copied
  // from the downloads pane. Set once links are resolved.
  directUrl?: string;
  // For Real-Debrid items: the destination file paths on disk, recorded when the
  // download starts, so a cancel of a paused item can delete its partials.
  paths?: string[];
}
