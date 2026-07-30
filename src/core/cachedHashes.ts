import type { DebridProvider, RequestOptions } from "../integrations/debrid/types";

/** How many hashes go into one checkcached call. */
export const CACHED_BATCH = 100;

/** Lowercase, de-duplicate, and split into batches of at most `size`. */
export function batchHashes(hashes: readonly string[], size = CACHED_BATCH): string[][] {
  const unique = [...new Set(hashes.map((h) => h.toLowerCase()).filter(Boolean))];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}

export interface CachedHashesOptions extends RequestOptions {
  batchSize?: number;
}

/**
 * Which of `hashes` the provider already has cached.
 *
 * Best-effort by design. A provider with no `checkCached` (Real-Debrid), a
 * missing token, or a failing call all yield an empty set — the marker is an
 * extra the user did not ask for, and an error toast because an advisory lookup
 * timed out would be worse than no marker. Batches are independent, so one
 * failure does not discard the answers that did arrive.
 */
export async function cachedHashesFor(
  provider: DebridProvider,
  token: string,
  hashes: readonly string[],
  opts: CachedHashesOptions = {},
): Promise<Set<string>> {
  const { batchSize, ...requestOpts } = opts;
  if (!provider.checkCached || !token) return new Set();
  const batches = batchHashes(hashes, batchSize);
  const results = await Promise.all(
    batches.map((batch) => provider.checkCached!(token, batch, requestOpts).catch(() => new Set<string>())),
  );
  const out = new Set<string>();
  for (const set of results) for (const hash of set) out.add(hash);
  return out;
}
