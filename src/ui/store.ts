import { createContext, useContext, useEffect, useState } from "react";
import type { Config } from "../config/config";
import type { DownloadQueue } from "../download/queue";
import type { HistoryItem } from "../download/history";
import type { QueueItem, SeedItem } from "../download/types";
import type { SourceGroup, SourceId } from "../sources/types";
import type { RdStatus } from "../integrations/rdStatus";
import type { Sort } from "./sort";

export type View = "splash" | "browser";

export type Category = "all" | "games" | "movies" | "tv" | "anime";

export type Section = Category | "downloads" | "seeding" | "accounts";

// The "category" sections (all/games/movies/tv/anime) — i.e. the results view,
// as opposed to the downloads/seeding views.
export function isCategory(section: Section): boolean {
  return section !== "downloads" && section !== "seeding";
}

export const CATEGORIES: { key: Category; label: string; group?: SourceGroup }[] = [
  { key: "all", label: "All" },
  { key: "games", label: "Games", group: "Games" },
  { key: "movies", label: "Movies", group: "Movies" },
  { key: "tv", label: "TV", group: "TV" },
  { key: "anime", label: "Anime", group: "Anime" },
];

// Parse a persisted category preference, falling back to "all" for anything
// that isn't a known result category (unknown values, or downloads/seeding).
export function parseCategory(raw: string | undefined): Category {
  return CATEGORIES.some((c) => c.key === raw) ? (raw as Category) : "all";
}

export type Region = "sidebar" | "content" | "help";

export type CaptureMode = "none" | "text" | "esc";

export type DownloadFocus = "downloading" | "paused" | "failed" | "recent";

export type SeedFocus = "seeding" | "paused" | "missing" | "idle";

export interface Store {
  config: Config;
  setConfig: (c: Config) => void;
  queue: DownloadQueue;

  view: View;
  setView: (v: View) => void;
  query: string;
  submitQuery: (q: string) => void;
  // Recently-run searches (most-recent first) for up-arrow recall.
  searchHistory: string[];
  // Jump to the browser view and open the Real-Debrid token prompt (used by the
  // splash CTA, where the token prompt itself isn't rendered).
  openTokenPrompt: () => void;
  // Jump to the browser view, select the Accounts pane, and focus it.
  openAccounts: () => void;

  section: Section;
  setSection: (s: Section) => void;
  // The active results sort, persisted across launches.
  sort: Sort;
  setSort: (s: Sort) => void;
  // Sources the user has switched off (skipped during search), and a toggle.
  disabledSources: SourceId[];
  toggleSource: (id: SourceId) => void;
  region: Region;
  setRegion: (r: Region) => void;
  captureMode: CaptureMode;
  setCaptureMode: (m: CaptureMode) => void;

  downloadFocus: DownloadFocus | null;
  setDownloadFocus: (f: DownloadFocus | null) => void;
  seedFocus: SeedFocus | null;
  setSeedFocus: (f: SeedFocus | null) => void;

  startDownload: (input: {
    id: string;
    name: string;
    magnet: string;
    source?: SourceId;
    sizeBytes?: number;
  }) => void;
  // The plain (P2P) download button. Gated behind an IP-safety warning when a
  // Real-Debrid token is configured; otherwise downloads immediately.
  requestP2PDownload: (input: {
    id: string;
    name: string;
    magnet: string;
    source?: SourceId;
    sizeBytes?: number;
  }) => void;
  // Download via Real-Debrid (resolve magnet -> direct links -> HTTP).
  startDebridDownload: (input: {
    id: string;
    name: string;
    magnet: string;
    source?: SourceId;
    sizeBytes?: number;
  }) => void;
  // Stream via Real-Debrid: resolve, then play the largest video in a player.
  streamResult: (input: {
    id: string;
    name: string;
    magnet: string;
    source?: SourceId;
    sizeBytes?: number;
  }) => void;
  // True when an RD token is available (config or env var).
  debridConfigured: boolean;
  // The validated Real-Debrid account, or null when unknown/not connected.
  rdStatus: RdStatus | null;
  // Copy an arbitrary link (e.g. a resolved RD direct URL) to the clipboard.
  copyLink: (url: string, name: string) => void;
  copyMagnet: (input: { name: string; magnet: string }) => void;

  notice: string | null;
  setNotice: (s: string | null) => void;

  quitAll: () => void;

  listRows: number;
  compact: boolean;
  contentWidth: number;
  cols: number;
  rows: number;
}

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("Store not available");
  return s;
}

export function useQueueItems(queue: DownloadQueue): QueueItem[] {
  const [items, setItems] = useState<QueueItem[]>(() => queue.getItems());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = (): void => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setItems(queue.getItems());
      }, 200);
    };
    queue.on("update", onUpdate);
    onUpdate();
    return () => {
      queue.off("update", onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [queue]);
  return items;
}

export function useQueueHistory(queue: DownloadQueue): HistoryItem[] {
  const [items, setItems] = useState<HistoryItem[]>(() => queue.getHistory());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = (): void => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setItems(queue.getHistory());
      }, 200);
    };
    queue.on("update", onUpdate);
    onUpdate();
    return () => {
      queue.off("update", onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [queue]);
  return items;
}

export function useSeeds(queue: DownloadQueue): Map<string, SeedItem> {
  const [seeds, setSeeds] = useState<Map<string, SeedItem>>(
    () => new Map(queue.getSeeds().map((s) => [s.id, s])),
  );
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = (): void => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setSeeds(new Map(queue.getSeeds().map((s) => [s.id, s])));
      }, 200);
    };
    queue.on("update", onUpdate);
    onUpdate();
    return () => {
      queue.off("update", onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [queue]);
  return seeds;
}
