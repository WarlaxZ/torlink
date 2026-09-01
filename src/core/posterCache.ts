import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { postersDir } from "../config/paths";
import { renderPosterFile } from "../util/poster";
import { torlinkFetch, type FetchImpl } from "../util/net";
import { fetchAllowedImageBytes } from "./imageProxy";
import { log } from "../util/logger";

// Hosts we are willing to fetch poster images from. The daemon fetching an
// arbitrary caller-supplied URL is server-side request forgery: on a cloud box
// that reaches the instance metadata service. OMDb only ever hands back these
// CDNs, so an allowlist costs nothing.
//
// This lives in core rather than the web layer because every front-end fetches
// posters through getPoster, and the redirect hop below has to be checked here —
// the layer that actually issues the request. An exact-Set membership test (not
// a suffix match) is what makes `m.media-amazon.com.evil.example` fail closed.
export const POSTER_HOSTS = new Set([
  "m.media-amazon.com",
  "ia.media-imdb.com",
  "img.omdbapi.com",
  // AniList cover art (the Anime group's metadata provider).
  "s4.anilist.co",
  // TMDB's image CDN, via reccd's GET /artwork — season posters and episode
  // stills, which OMDb (the two hosts above) has no equivalent field for.
  "image.tmdb.org",
]);

// Cap the cache rather than letting it grow forever. Posters are ~50-200KB, so
// this holds a few thousand — far more than a session browses.
export const MAX_POSTER_CACHE_BYTES = 200 * 1024 * 1024;

// A single poster is tens to hundreds of KB. The URL is caller-supplied once
// the web layer exposes /api/poster, so refuse anything implausibly large
// rather than buffering it into memory.
export const MAX_POSTER_BYTES = 8 * 1024 * 1024;

/**
 * Whether we're willing to issue a request for this URL at all: an http(s) URL
 * on an allowlisted CDN.
 *
 * This lives inside getPoster rather than at each call site on purpose. "getPoster
 * only ever fetches poster CDNs" is an invariant you can confirm by reading one
 * function; "every caller validates first" can only be confirmed by auditing the
 * whole tree, and it breaks silently the moment someone adds a caller.
 */
function posterUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (!POSTER_HOSTS.has(parsed.hostname.toLowerCase())) {
    // warn, not debug: an unlisted CDN is a hard failure, so every poster silently
    // becomes a placeholder, and debug lines are gated behind TORLINK_DEBUG — a
    // normal install would have no trace at all. This never fires in normal
    // operation (poster URLs come from OMDb, which serves the listed CDNs), so
    // there's nothing to spam: a refusal means either OMDb moved hosts or someone
    // is aiming the fetcher elsewhere, and both are worth an operator's attention.
    log.warn(
      `poster not fetched: host "${parsed.hostname}" is not in the allowed poster CDN list ` +
        `(POSTER_HOSTS in core/posterCache.ts). The poster will fall back to a placeholder.`,
    );
    return false;
  }
  return true;
}

// Pruning walks and stats the whole directory, and during a browse session
// almost every lookup is a miss — so prune periodically rather than on every
// write. The cache can drift a little over the cap between sweeps; that's fine.
const PRUNE_EVERY_N_WRITES = 50;
// Starts "due" so each process sweeps once on its first write: a session that
// caches fewer than N posters would otherwise never prune at all, and the cap
// would drift upwards run after run.
let writesSincePrune = PRUNE_EVERY_N_WRITES;

export interface PosterCacheOptions {
  dir?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface CachedPoster {
  path: string;
  bytes: number;
}

// Hash the URL rather than sanitising it: poster URLs contain slashes, query
// strings and arbitrary characters, and a hash is both collision-safe enough
// and incapable of escaping the cache directory.
export function posterFileName(url: string): string {
  return `${createHash("sha1").update(url).digest("hex")}.jpg`;
}

// Delete least-recently-used files until the directory fits `maxBytes`. Never
// throws — this is opportunistic housekeeping, not a correctness requirement.
export async function prunePosters(dir: string, maxBytes: number): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const entries: { file: string; size: number; mtimeMs: number }[] = [];
  let total = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) continue;
      entries.push({ file, size: st.size, mtimeMs: st.mtimeMs });
      total += st.size;
    } catch {
      /* vanished under us — nothing to account for */
    }
  }
  if (total <= maxBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const e of entries) {
    if (total <= maxBytes) break;
    try {
      await fs.rm(e.file, { force: true });
      total -= e.size;
    } catch {
      /* leave it; the next prune will try again */
    }
  }
}

/**
 * The cached original bytes for a poster URL, fetching once on a miss. Returns
 * null on any failure (non-http URL, network error, non-2xx) so callers fall
 * back to their placeholder rather than handling errors.
 *
 * A hit updates the file's mtime so `prunePosters` treats the cache as LRU
 * rather than first-in-first-out.
 *
 * If this grows another phase, the clean cut is
 * `posterBytes(url, fetchImpl, timeoutMs): Promise<Buffer | null>` covering the
 * redirect loop plus the ok / content-length / size / magic-byte validation: that
 * span touches only the network and a buffer, never the filesystem, so it
 * separates without having to thread cache paths through it.
 */
export async function getPoster(
  url: string,
  opts: PosterCacheOptions = {},
): Promise<CachedPoster | null> {
  if (!posterUrlAllowed(url)) return null;
  const dir = opts.dir ?? postersDir;
  // torlinkFetch, not the global `fetch`: poster CDNs must resolve through the
  // custom-DNS dispatcher every other request uses, or a box whose network
  // sinkholes DNS serves working search results with no poster behind any of them.
  const fetchImpl = opts.fetchImpl ?? torlinkFetch;
  const file = path.join(dir, posterFileName(url));

  try {
    const st = await fs.stat(file);
    if (st.isFile() && st.size > 0) {
      const now = Date.now() / 1000;
      await fs.utimes(file, now, now).catch(() => {});
      return { path: file, bytes: st.size };
    }
  } catch {
    /* miss — fetch below */
  }

  // The redirect loop, allowlist re-check, size cap and magic-byte validation all
  // live in the shared fetcher now — one copy for posters and screenshots, so the
  // SSRF guard can't drift between them. JPEG only, as before: the half-block
  // renderer decodes JPEG, and a 200 that isn't one (an HTML error page, a
  // placeholder GIF) must not be cached or it would fail to decode forever.
  const buf = await fetchAllowedImageBytes(url, {
    allow: posterUrlAllowed,
    maxBytes: MAX_POSTER_BYTES,
    accept: (b) => b.length >= 2 && b[0] === 0xff && b[1] === 0xd8,
    timeoutMs: opts.timeoutMs,
    fetchImpl,
  });
  if (!buf) return null;

  try {
    await fs.mkdir(dir, { recursive: true });
    // Write-then-rename so a concurrent reader never sees a half-written file.
    // The tmp name is unique per write so two concurrent writers for the same
    // URL can't interleave and publish each other's partial bytes.
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
  } catch (err) {
    log.debug(`poster cache: write failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  if (++writesSincePrune >= PRUNE_EVERY_N_WRITES) {
    writesSincePrune = 0;
    void prunePosters(dir, opts.maxBytes ?? MAX_POSTER_CACHE_BYTES);
  }
  return { path: file, bytes: buf.length };
}

/**
 * Terminal half-block rows for a poster, via the cache. The bytes are fetched
 * at most once per URL across the whole app.
 */
export async function cachedPosterRows(
  url: string,
  cols: number,
  maxRows: number,
  opts: PosterCacheOptions = {},
): Promise<string[] | null> {
  const hit = await getPoster(url, opts);
  if (!hit) return null;
  return renderPosterFile(hit.path, cols, maxRows);
}
