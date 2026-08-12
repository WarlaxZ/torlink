import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { screenshotsDir } from "../config/paths";
import { fetchAllowedImageBytes } from "./imageProxy";
import { screenshotHostAllowed } from "../util/screenshotExtract";
import { prunePosters } from "./posterCache";
import { torlinkFetch, type FetchImpl } from "../util/net";
import { log } from "../util/logger";

// A single screenshot is tens to hundreds of KB. The URL is caller-supplied once
// /api/screenshot is exposed, so refuse anything implausibly large.
export const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_SCREENSHOT_CACHE_BYTES = 200 * 1024 * 1024;

const PRUNE_EVERY_N_WRITES = 50;

export interface CachedImage {
  path: string;
  bytes: number;
}

export interface ScreenshotCacheOptions {
  dir?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

// jpg / png / gif / webp — screenshot hosts serve more than the poster path's
// jpeg-only. A 200 that isn't actually an image (an HTML "image not found" page)
// must not be cached: it would fail to render forever and its mtime bump would
// pin it in the LRU.
function looksLikeImage(b: Buffer): boolean {
  if (b.length < 4) return false;
  if (b[0] === 0xff && b[1] === 0xd8) return true; // jpeg
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // png
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // gif
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return true;
  return false;
}

// Hash the URL rather than sanitising it: it contains slashes and query strings,
// and a hash both avoids collisions and can't escape the cache directory.
function screenshotFileName(url: string): string {
  return `${createHash("sha1").update(url).digest("hex")}.img`;
}

// Starts "due" so each process sweeps once on its first write.
let writesSincePrune = PRUNE_EVERY_N_WRITES;

/**
 * The cached original bytes for a screenshot URL, fetching once on a miss.
 * Returns null on any failure so callers fall back to a placeholder. Mirrors
 * getPoster's disk cache, but with the screenshot allowlist, broader image magic
 * bytes, and its own cache directory.
 */
export async function getScreenshot(
  url: string,
  opts: ScreenshotCacheOptions = {},
): Promise<CachedImage | null> {
  if (!screenshotHostAllowed(url)) return null;
  const dir = opts.dir ?? screenshotsDir;
  const file = path.join(dir, screenshotFileName(url));

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

  const buf = await fetchAllowedImageBytes(url, {
    allow: screenshotHostAllowed,
    maxBytes: SCREENSHOT_MAX_BYTES,
    accept: looksLikeImage,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl ?? torlinkFetch,
  });
  if (!buf) return null;

  try {
    await fs.mkdir(dir, { recursive: true });
    // Write-then-rename so a concurrent reader never sees a half-written file.
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
  } catch (err) {
    log.debug(`screenshot cache write failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  if (++writesSincePrune >= PRUNE_EVERY_N_WRITES) {
    writesSincePrune = 0;
    void prunePosters(dir, MAX_SCREENSHOT_CACHE_BYTES);
  }
  return { path: file, bytes: buf.length };
}
