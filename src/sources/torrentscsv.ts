import { fetchResilient, HttpError, USER_AGENT } from "../util/net";
import { buildMagnet } from "./magnet";
import type { SearchOptions, Source, TorrentResult } from "./types";

// Torrents-CSV: an open-source, self-hostable torrent search DB that only keeps
// seeded torrents. Returns magnet infohashes plus real seeder counts, which is
// why it slots cleanly into the "healthiest first" default order.
const API = "https://torrents-csv.com/service/search";

interface TcsvTorrent {
  infohash?: string;
  name?: string;
  size_bytes?: number;
  seeders?: number | null;
  leechers?: number | null;
  created_unix?: number;
}

interface TcsvResponse {
  torrents?: TcsvTorrent[];
}

export function parseTorrentsCsv(json: TcsvResponse): TorrentResult[] {
  const out: TorrentResult[] = [];
  for (const t of json.torrents ?? []) {
    const infoHash = (t.infohash ?? "").toLowerCase();
    if (!infoHash) continue;
    const name = t.name || "Unknown";
    out.push({
      infoHash,
      name,
      sizeBytes: Number(t.size_bytes) || 0,
      seeders: Number(t.seeders) || 0,
      leechers: Number(t.leechers) || 0,
      source: "torrents-csv",
      magnet: buildMagnet(infoHash, name),
      added: Number(t.created_unix) || undefined,
    });
  }
  return out;
}

async function search(query: string, opts: SearchOptions = {}): Promise<TorrentResult[]> {
  const q = query.trim();
  // The API has no browse/empty-query endpoint, so sit out the "browse latest"
  // mode and let the other sources fill it.
  if (!q) return [];

  const url = `${API}?q=${encodeURIComponent(q)}&size=100`;
  const res = await fetchResilient(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: opts.signal,
    retries: 1,
  });
  if (!res.ok) throw new HttpError(res.status, `Torrents-CSV returned ${res.status}`);
  const json = (await res.json()) as TcsvResponse;
  return parseTorrentsCsv(json);
}

export const torrentsCsv: Source = {
  id: "torrents-csv",
  label: "Torrents.csv",
  group: "Movies",
  homepage: "https://torrents-csv.com",
  search,
};
