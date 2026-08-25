// Remembers the screenshot URLs scraped off a torrent listing page, so flicking
// back to an already-viewed result does not re-fetch and re-parse that page.
//
// Bounded rather than time-limited, same reasoning as ProbeCache/HlsVerdictCache:
// a listing page's screenshots are set once when it's posted and essentially
// never change, so a stale entry is not a real risk — unlike search results,
// which go stale as seeders/hashes change.
import { screenshotsFor, type Opts } from "./screenshots";
import type { Shot } from "../util/screenshotExtract";

const DEFAULT_MAX = 500;

export class ScreenshotUrlCache {
  private readonly entries = new Map<string, Shot[]>();

  constructor(private readonly max: number = DEFAULT_MAX) {}

  // JSON-encoded rather than `${source}:${ref}`: a source or ref containing the
  // separator would otherwise collide with a different (source, ref) pair.
  private key(source: string, ref: string): string {
    return JSON.stringify([source, ref]);
  }

  get(source: string, ref: string): Shot[] | undefined {
    return this.entries.get(this.key(source, ref));
  }

  set(source: string, ref: string, shots: Shot[]): void {
    const key = this.key(source, ref);
    // Delete first so a re-set moves the entry to the end of the insertion
    // order rather than leaving it where it was.
    this.entries.delete(key);
    this.entries.set(key, shots);
    // Map iterates in insertion order, so the first key is the oldest.
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

const cache = new ScreenshotUrlCache();

/**
 * screenshotsFor, cached by (source, ref). Overloads for cache/fetchImpl exist
 * only so tests can inject an isolated cache and a fake fetch.
 */
export async function cachedScreenshotsFor(
  source: string,
  ref: string,
  opts: Opts,
  cacheImpl: ScreenshotUrlCache = cache,
  fetchImpl: typeof screenshotsFor = screenshotsFor,
): Promise<Shot[]> {
  if (!ref) return [];
  const hit = cacheImpl.get(source, ref);
  if (hit) return hit;
  const shots = await fetchImpl(source, ref, opts);
  cacheImpl.set(source, ref, shots);
  return shots;
}
