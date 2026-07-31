import type { FetchImpl } from "../util/net";
import { log } from "../util/logger";

// Extra metadata for a title: its IMDb id, a short plot summary and a poster
// image URL. OMDb is a third-party service (not IMDb itself); the user supplies
// their own free API key. reccd deliberately carries none of this — see the For
// You / search preview panes. A field is null when OMDb has no value ("N/A").
export type FetchTitleMetaResult =
  | { ok: true; type?: OmdbType | null; imdbId: string | null; plot: string | null; posterUrl: string | null }
  | { ok: false; error: string };

// Narrow a search to the right medium when we know it (e.g. the TV vs Movies
// section, or a parsed season/episode).
export type OmdbType = "movie" | "series";

interface OmdbResponse {
  Response: string;
  imdbID?: string;
  Type?: string;
  Plot?: string;
  Poster?: string;
  Error?: string;
}

function isOmdbResponse(v: unknown): v is OmdbResponse {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).Response === "string";
}

// OMDb uses the literal "N/A" for missing string fields.
function clean(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s && s !== "N/A" ? s : null;
}

// Shared request/parse core. `params` already carries the lookup key (i= or t=).
async function request(
  params: URLSearchParams,
  apiKey: string,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number },
  ctx: string,
): Promise<FetchTitleMetaResult> {
  if (!apiKey) return { ok: false, error: "OMDb key not configured" };
  params.set("apikey", apiKey);
  params.set("plot", "short");
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  try {
    const res = await fetchImpl(`https://www.omdbapi.com/?${params.toString()}`, {
      method: "GET",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (res.status === 401) return { ok: false, error: "OMDb rejected the key — check omdbApiKey" };
    if (!res.ok) return { ok: false, error: `OMDb unavailable (HTTP ${res.status})` };
    const body: unknown = await res.json();
    if (!isOmdbResponse(body)) return { ok: false, error: "unexpected response from OMDb" };
    // OMDb signals "not found" / bad key with 200 + { Response: "False" }.
    if (body.Response !== "True") return { ok: false, error: body.Error || "not found" };
    // OMDb also returns "episode" and "game"; anything but the two we model
    // becomes null rather than being coerced into one of them.
    const type: OmdbType | null =
      body.Type === "movie" || body.Type === "series" ? body.Type : null;
    return { ok: true, type, imdbId: clean(body.imdbID), plot: clean(body.Plot), posterUrl: clean(body.Poster) };
  } catch (err) {
    log.debug(`omdb ${ctx}: failed to reach OMDb: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: "couldn't reach OMDb" };
  }
}

// Look up a title by its IMDb id (used by For You, where reccd supplies the id).
export async function fetchTitleMeta(
  imdbId: string,
  apiKey: string,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<FetchTitleMetaResult> {
  if (!imdbId) return { ok: false, error: "no imdbId" };
  return request(new URLSearchParams({ i: imdbId }), apiKey, opts, `by id ${imdbId}`);
}

// Look up a title by name (used by search results, which carry no id — the name
// is parsed out of the release string first). `year`/`type` sharpen the match.
export async function fetchTitleMetaByName(
  title: string,
  apiKey: string,
  opts: {
    year?: number;
    type?: OmdbType;
    /**
     * One episode of a series. OMDb returns THAT episode's own title and plot,
     * which is what makes a preview pane useful while stepping down a season.
     * Meaningless for a film — sending them gets a Response:"False", which the
     * existing miss path already turns into `{ ok: false }` rather than a throw.
     */
    season?: number;
    episode?: number;
    fetchImpl?: FetchImpl;
    timeoutMs?: number;
  } = {},
): Promise<FetchTitleMetaResult> {
  if (!title.trim()) return { ok: false, error: "no title" };
  const params = new URLSearchParams({ t: title.trim() });
  if (opts.year) params.set("y", String(opts.year));
  if (opts.type) params.set("type", opts.type);
  const wantsEpisode = opts.season !== undefined && opts.episode !== undefined;
  if (opts.season !== undefined) params.set("Season", String(opts.season));
  if (opts.episode !== undefined) params.set("Episode", String(opts.episode));
  const result = await request(params, apiKey, opts, `by name ${title}`);
  if (!wantsEpisode || !result.ok || result.posterUrl) return result;

  // THE EPISODE'S PLOT, THE SERIES' POSTER. OMDb has per-episode stills for some
  // episodes and not others, so without this the pane blanks on every other
  // episode as you arrow down a season — worse than an image that simply does
  // not change. One extra lookup, and only for episodes that have no artwork.
  //
  // Here rather than in either front end because both reach OMDb through this
  // function — the terminal directly, the browser via `/api/title` — and a
  // fallback written twice is the copy-then-drift this codebase keeps recording.
  const seriesParams = new URLSearchParams({ t: title.trim() });
  if (opts.year) seriesParams.set("y", String(opts.year));
  if (opts.type) seriesParams.set("type", opts.type);
  const series = await request(seriesParams, apiKey, opts, `by name ${title} (poster)`);
  // A failed fallback leaves the episode answer exactly as it was: no poster is
  // an ordinary outcome, and it must not turn a good plot into an error.
  return series.ok && series.posterUrl ? { ...result, posterUrl: series.posterUrl } : result;
}
