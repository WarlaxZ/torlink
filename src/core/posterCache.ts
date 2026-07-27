import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { postersDir } from "../config/paths";
import { renderPosterFile } from "../util/poster";
import type { FetchImpl } from "../util/net";
import { log } from "../util/logger";

// Cap the cache rather than letting it grow forever. Posters are ~50-200KB, so
// this holds a few thousand — far more than a session browses.
export const MAX_POSTER_CACHE_BYTES = 200 * 1024 * 1024;

// A single poster is tens to hundreds of KB. The URL is caller-supplied once
// the web layer exposes /api/poster, so refuse anything implausibly large
// rather than buffering it into memory.
export const MAX_POSTER_BYTES = 8 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 8000;

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
 */
export async function getPoster(
  url: string,
  opts: PosterCacheOptions = {},
): Promise<CachedPoster | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const dir = opts.dir ?? postersDir;
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
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

  let buf: Buffer;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    // Trust content-length only to bail out early; the real check is the
    // buffer length below, since the header is optional and can lie.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_POSTER_BYTES) return null;
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    log.debug(`poster cache: fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (buf.length === 0 || buf.length > MAX_POSTER_BYTES) return null;
  // A 200 that isn't actually a JPEG (an HTML error page, a placeholder GIF)
  // must not be cached: it would fail to decode forever, and every lookup would
  // touch its mtime so LRU could never evict it.
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;

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
 * Terminal half-block rows for a poster, via the cache. Same signature shape as
 * `fetchPosterRows` so the TUI hook swaps one call for the other, but the bytes
 * are fetched at most once per URL across the whole app.
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
