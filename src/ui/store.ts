import { createContext, useContext, useEffect, useState } from "react";
import type { Config, FavouriteItem } from "../config/config";
import type { DownloadQueue } from "../download/queue";
import type { HistoryItem } from "../download/history";
import type { QueueItem, SeedItem } from "../download/types";
import type { SourceGroup, SourceId } from "../sources/types";
import type { DebridProviderId, DebridStatus } from "../integrations/debrid/types";
import type { Sort } from "./sort";
import type { StreamHistoryItem } from "../core/streamHistory";
import type { PickIntent } from "../util/releasePick";

/**
 * The cast row's data, flattened from `ActiveCast` (src/core/cast/session.ts).
 *
 * Flattened rather than the core type itself so the store carries no live object
 * — `Store` is state the TUI re-renders from, and a registry instance in it would
 * invite a component to reach past the props it was given.
 */
export interface CastRowStatus {
  deviceName: string;
  title: string;
  state: "loading" | "playing" | "paused" | "idle";
  positionSec: number;
  durationSec: number | null;
}

export type View = "splash" | "browser";

export type Category = "all" | "games" | "movies" | "tv" | "anime" | "music" | "books" | "porn";

export type Section =
  | Category
  | "continueWatching"
  | "savedSearches"
  | "library"
  | "downloads"
  | "seeding"
  | "settings"
  | "forYou";

// The "category" sections (all/games/movies/tv/anime) — i.e. the results view,
// as opposed to the downloads/seeding/accounts views.
export function isCategory(section: Section): boolean {
  return (
    section !== "continueWatching" &&
    section !== "savedSearches" &&
    section !== "library" &&
    section !== "downloads" &&
    section !== "seeding" &&
    section !== "settings" &&
    section !== "forYou"
  );
}

export const CATEGORIES: { key: Category; label: string; group?: SourceGroup }[] = [
  { key: "all", label: "All" },
  { key: "games", label: "Games", group: "Games" },
  { key: "movies", label: "Movies", group: "Movies" },
  { key: "tv", label: "TV", group: "TV" },
  { key: "anime", label: "Anime", group: "Anime" },
  { key: "music", label: "Music", group: "Music" },
  { key: "books", label: "Books", group: "Books" },
  // Adult category; only rendered when adult content is enabled (see Sidebar).
  { key: "porn", label: "Porn", group: "Porn" },
];

// Parse a persisted category preference, falling back to "all" for anything
// that isn't a known result category (unknown values, or downloads/seeding).
export function parseCategory(raw: string | undefined): Category {
  return CATEGORIES.some((c) => c.key === raw) ? (raw as Category) : "all";
}

// Every navigable sidebar section, in display order.
const SECTIONS: Section[] = [
  ...CATEGORIES.map((c) => c.key),
  "forYou",
  "continueWatching",
  "savedSearches",
  "library",
  "downloads",
  "seeding",
  "settings",
];

// Parse a persisted "last section" preference (any sidebar tab), falling back
// to "all" for unknown/stale values so torlink reopens where you left off.
export function parseSection(raw: string | undefined): Section {
  // The Accounts pane was folded into Settings; a config written before that
  // stored "accounts" as its last section, so reopen it on Settings rather than
  // dropping the user back on "all".
  if (raw === "accounts") return "settings";
  return (SECTIONS as string[]).includes(raw ?? "") ? (raw as Section) : "all";
}

export type Region = "sidebar" | "content" | "help";

export type CaptureMode = "none" | "text" | "esc";

export type DownloadFocus = "downloading" | "paused" | "failed" | "recent";

export type SeedFocus = "seeding" | "paused" | "missing" | "idle";

export type ResultFocus = "list" | "detail";

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
  savedSearches: string[];
  toggleSavedSearch: (query: string) => void;
  // Pinned VIDEO torrents (the "Library"), most-recent first.
  favourites: FavouriteItem[];
  toggleFavourite: (item: FavouriteItem) => void;
  removeFavourite: (id: string) => void;
  openFavourite: (fav: FavouriteItem) => void;
  isFavourited: (id: string) => boolean;
  // What the user is part-way through, newest-first (the store guarantees
  // ordering; the pane must not re-sort it).
  streamHistory: StreamHistoryItem[];
  openStreamHistory: (item: StreamHistoryItem) => void;
  removeStreamHistory: (key: string) => void;
  /**
   * Search for `title`, choose a release with the user's quality preference,
   * and play it. `fallback` runs when nothing usable was found — Continue
   * Watching passes its existing resume action so an offline or aged-out title
   * still does something.
   */
  autoPlayTitle: (title: string, intent: PickIntent, fallback?: () => void) => void;

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
  resultFocus: ResultFocus | null;
  setResultFocus: (f: ResultFocus | null) => void;

  startDownload: (input: {
    id: string;
    name: string;
    magnet: string;
    source?: SourceId;
    sizeBytes?: number;
  }) => void;
  // The plain (P2P) download button. Gated behind an IP-safety warning when a
  // debrid provider is configured; otherwise downloads immediately.
  requestP2PDownload: (input: {
    id: string;
    name: string;
    magnet: string;
    source?: SourceId;
    sizeBytes?: number;
  }) => void;
  // Opens the "download to" prompt (D) so this one download can land in a
  // folder other than the configured default.
  requestDownloadTo: (input: {
    id: string;
    name: string;
    magnet: string;
    source?: SourceId;
    sizeBytes?: number;
  }) => void;
  // Download via the active debrid provider (resolve magnet -> direct links -> HTTP).
  startDebridDownload: (input: {
    id: string;
    name: string;
    magnet: string;
    source?: SourceId;
    sizeBytes?: number;
  }) => void;
  // Stream via the active debrid provider: resolve, then play in a player.
  streamResult: (input: {
    id: string;
    name: string;
    magnet: string;
    source?: SourceId;
    sizeBytes?: number;
  }) => void;
  // True when a debrid token is available (config or env var).
  debridConfigured: boolean;
  // Which debrid service resolves magnets, or null when none is configured.
  debridProvider: DebridProviderId | null;
  // True when a recc (recommendation engine) URL is configured.
  reccConfigured: boolean;
  // True when an OMDb API key is configured (enables For You plot summaries).
  omdbConfigured: boolean;
  // The resolved OMDb API key ("" when unset). Drives the search-results and
  // For You poster/plot preview panes.
  omdbApiKey: string;
  // True when the adult ("Porn") category is enabled (config or TORLINK_ADULT).
  // Gates the Porn tab, its sources, and the Porn group in the sources panel.
  adultEnabled: boolean;
  // True while a torrent-stream session is live. While true, "x" is reserved
  // globally for stopping the stream, so components with their own "x"
  // handler (clear history, sign out) must ignore it.
  streamActive: boolean;
  // What is playing on a Chromecast right now, or null. Display only: nothing in
  // torlink persists a playback position, so this drives the cast row and is
  // never written down. Per-process, like the registry behind it — a cast started
  // in a separate `serve --web` is not visible here.
  castStatus: CastRowStatus | null;
  // The validated debrid account (whichever provider is active), or null when
  // unknown/not connected.
  debridStatus: DebridStatus | null;
  // Info hashes the active debrid provider has cached, for the results marker.
  // Empty when the provider cannot answer — see cachedTag's reasoning in
  // src/web/static/searchModel.ts, which this mirrors for the terminal.
  cachedHashes: ReadonlySet<string>;
  // Called once a search settles with the hashes on screen. Resolves and
  // clears `cachedHashes` itself; App.tsx owns this rather than the caller
  // because it is the one place holding the debrid token (Store deliberately
  // does not).
  refreshCachedHashes: (hashes: readonly string[]) => void;
  // Copy an arbitrary link (e.g. a resolved RD direct URL) to the clipboard.
  copyLink: (url: string, name: string) => void;
  copyMagnet: (input: { name: string; magnet: string }) => void;
  openDownloadFolder: (dir: string) => void;
  // Copies the cached .torrent metadata into the item's download folder and
  // reports the outcome through the notice line.
  exportTorrent: (input: { id: string; name: string }) => void;
  // Fetches the .torrent metadata for a search result (via magnet if not yet
  // cached) and exports it to the configured download folder.
  fetchAndExportTorrent: (input: { id: string; name: string; magnet: string }) => void;

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
