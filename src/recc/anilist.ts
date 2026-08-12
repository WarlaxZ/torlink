import type { FetchImpl } from "../util/net";
import { log } from "../util/logger";
import type { FetchTitleMetaResult, OmdbType } from "./omdb";

// AniList is a free, keyless GraphQL API for anime. It is the right database for
// the Anime group, where OMDb (an IMDb mirror) cannot match romaji/CJK titles or
// absolute episode numbering. We return the SAME FetchTitleMetaResult union OMDb
// returns so every caller — TUI hook and web route — handles one shape.

const ENDPOINT = "https://graphql.anilist.co";

// One media match, ranked by search relevance. type: ANIME excludes manga.
const QUERY = `
query ($search: String) {
  Media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
    id
    title { romaji english native }
    description(asHtml: false)
    coverImage { extraLarge large }
    format
    siteUrl
  }
}`;

interface AniListMedia {
  description?: string | null;
  coverImage?: { extraLarge?: string | null; large?: string | null } | null;
  format?: string | null;
}

interface AniListResponse {
  data?: { Media?: AniListMedia | null } | null;
  errors?: unknown;
}

function isResponse(v: unknown): v is AniListResponse {
  return typeof v === "object" && v !== null;
}

// AniList descriptions carry light HTML (<br>, <i>, ...) even with asHtml:false.
// Strip tags and collapse whitespace to a single-paragraph plot.
function cleanPlot(desc: string | null | undefined): string | null {
  const s = (desc ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 0 ? s : null;
}

// Map AniList's format enum to the two media types we model. MOVIE is a film;
// every other video format (TV, TV_SHORT, OVA, ONA, SPECIAL) is a series.
// MUSIC and anything unrecognised is not something we can present -> null.
function mapType(format: string | null | undefined): OmdbType | null {
  if (format === "MOVIE") return "movie";
  if (format === "TV" || format === "TV_SHORT" || format === "OVA" || format === "ONA" || format === "SPECIAL") {
    return "series";
  }
  return null;
}

export async function fetchAnimeMetaByName(
  title: string,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<FetchTitleMetaResult> {
  const search = title.trim();
  if (!search) return { ok: false, error: "no title" };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { search } }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) return { ok: false, error: `AniList unavailable (HTTP ${res.status})` };
    const body: unknown = await res.json();
    if (!isResponse(body) || body.errors) return { ok: false, error: "not found" };
    const media = body.data?.Media;
    if (!media) return { ok: false, error: "not found" };
    const type = mapType(media.format);
    if (type === null) return { ok: false, error: "not found" };
    const posterUrl = media.coverImage?.extraLarge || media.coverImage?.large || null;
    return { ok: true, type, imdbId: null, plot: cleanPlot(media.description), posterUrl };
  } catch (err) {
    log.debug(`anilist by name ${search}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: "couldn't reach AniList" };
  }
}
