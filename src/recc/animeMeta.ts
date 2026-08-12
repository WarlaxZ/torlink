import type { FetchImpl } from "../util/net";
import { animeSearchTitle } from "../util/animeTitle";
import { fetchAnimeMetaByName } from "./anilist";
import { fetchTitleMetaByName, type FetchTitleMetaResult, type OmdbType } from "./omdb";

// The one place the "anime is AniList first, OMDb second" ordering lives. Both
// front ends call this on their Anime path so the ordering and the fallback rule
// cannot drift between a server route and a React hook.
export interface AnimeFirstArgs {
  // Raw torrent release name, normalized here for the AniList search.
  rawName: string;
  // The already-parsed OMDb query, used only for the fallback. No season/episode:
  // anime absolute numbering is meaningless to OMDb's per-season index.
  omdb: { title: string; year?: number; type?: OmdbType };
  // "" when no OMDb key is configured — the fallback is then skipped entirely,
  // which is what lets keyless users still get AniList artwork.
  omdbApiKey: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export async function fetchAnimeFirstMeta(args: AnimeFirstArgs): Promise<FetchTitleMetaResult> {
  const { rawName, omdb, omdbApiKey, fetchImpl, timeoutMs } = args;

  const search = animeSearchTitle(rawName);
  if (search) {
    const anilist = await fetchAnimeMetaByName(search, { fetchImpl, timeoutMs });
    if (anilist.ok) return anilist;
  }

  // AniList missed (or the name had no usable title). Fall back to OMDb only
  // when a key exists; otherwise return the AniList miss (or a "no title" miss).
  if (!omdbApiKey) {
    return search
      ? { ok: false, error: "not found" }
      : { ok: false, error: "no title in that release name" };
  }
  return fetchTitleMetaByName(omdb.title, omdbApiKey, {
    ...(omdb.year !== undefined ? { year: omdb.year } : {}),
    ...(omdb.type !== undefined ? { type: omdb.type } : {}),
    fetchImpl,
    timeoutMs,
  });
}
