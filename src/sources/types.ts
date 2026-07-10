export type SourceId =
  | "fitgirl"
  | "yts"
  | "eztv"
  | "nyaa"
  | "subsplease"
  | "torrents-csv"
  | "tpb-movies"
  | "tpb-tv"
  | "tpb-books"
  | "nyaa-literature"
  | "tpb-music"
  | "x1337-movies"
  | "x1337-tv"
  | "x1337-music"
  | "rt-games"
  | "rt-movies"
  | "rt-tv"
  | "rt-anime"
  | "rt-music"
  | "rt-books"
  | "bittorrented";

export type SourceGroup = "Games" | "Movies" | "TV" | "Anime" | "Music" | "Books";

export interface TorrentResult {
  infoHash: string;
  name: string;
  sizeBytes: number;
  seeders: number;
  leechers: number;
  numFiles?: number;
  source: SourceId;
  /** Every source that returned this infohash; `source` is the healthiest copy. */
  sources?: SourceId[];
  magnet: string;
  added?: number;
}

export interface SearchOptions {
  signal?: AbortSignal;
}

export interface Source {
  id: SourceId;
  label: string;
  // The category tabs a source feeds. Most sources belong to one; a general
  // index can feed several. A source with none shows under the All tab only.
  groups?: readonly SourceGroup[];
  homepage: string;
  // True when the source returns real swarm counts. False when its feed has
  // none, so seeders: 0 means unknown, not dead (the alive-only filter must
  // never drop those rows).
  reportsHealth: boolean;
  search(query: string, opts?: SearchOptions): Promise<TorrentResult[]>;
}
