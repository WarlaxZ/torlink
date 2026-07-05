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
  | "rt-books";

export type SourceGroup = "Games" | "Movies" | "TV" | "Anime" | "Music" | "Books";

export interface TorrentResult {
  infoHash: string;
  name: string;
  sizeBytes: number;
  seeders: number;
  leechers: number;
  numFiles?: number;
  source: SourceId;
  magnet: string;
  added?: number;
}

export interface SearchOptions {
  signal?: AbortSignal;
}

export interface Source {
  id: SourceId;
  label: string;
  group: SourceGroup;
  homepage: string;
  search(query: string, opts?: SearchOptions): Promise<TorrentResult[]>;
}
