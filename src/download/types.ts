import type { SourceId } from "../sources/types";

export type DownloadStatus = "downloading" | "paused" | "completed" | "failed";

// How an item is being fetched: classic peer-to-peer (webtorrent) or via
// Real-Debrid (resolve the magnet to direct links, then download over HTTP).
export type DownloadVia = "p2p" | "realdebrid";

// Real-Debrid downloads have two phases: "resolving" while RD caches the
// torrent on its cloud, then "downloading" while we pull the direct links.
export type DownloadPhase = "resolving" | "downloading";

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
  error?: string;
  addedAt: number;
  // Absent means "p2p" for back-compatibility with items persisted before
  // Real-Debrid support existed.
  via?: DownloadVia;
  phase?: DownloadPhase;
  // For Real-Debrid items: the primary resolved direct URL, so it can be copied
  // from the downloads pane. Set once links are resolved.
  directUrl?: string;
}
