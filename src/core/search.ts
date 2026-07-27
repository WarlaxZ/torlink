import { cachedSearch } from "../sources/cache";
import {
  isSkipped,
  recordFailure,
  recordSuccess,
  sourceHealth,
  type Health,
} from "../sources/sourceHealth";
import { AuthRequiredError } from "../sources/rutracker";
import { HttpError } from "../util/net";
import type { SearchOptions, Source, SourceId, TorrentResult } from "../sources/types";

export interface SourceState {
  loading: boolean;
  error: string | null;
  code: string | null;
  count: number;
}

// A source gets this long before it's abandoned. Generous: some trackers are
// slow rather than down, and benching handles the genuinely dead ones.
export const PER_SOURCE_TIMEOUT_MS = 25000;

export function errorCode(e: unknown, timedOut: boolean): string {
  if (timedOut) return "timed out";
  if (e instanceof HttpError && e.status > 0) return `HTTP ${e.status}`;
  return "no response";
}

// An auth requirement (e.g. RuTracker not logged in) is not a source
// outage — it must not bench the source, or a later successful login would
// be hidden behind the failure cooldown. Timeouts and real errors still count.
export function shouldBench(e: unknown): boolean {
  return !(e instanceof AuthRequiredError);
}

export function blankPerSource(
  sources: readonly Source[],
  loading: boolean,
): Record<SourceId, SourceState> {
  const out = {} as Record<SourceId, SourceState>;
  for (const s of sources) out[s.id] = { loading, error: null, code: null, count: 0 };
  return out;
}

export function mergeDuplicateResults(list: TorrentResult[]): TorrentResult[] {
  const byHash = new Map<string, TorrentResult>();
  for (const r of list) {
    const existing = byHash.get(r.infoHash);
    if (!existing) {
      byHash.set(r.infoHash, { ...r, sources: [r.source] });
      continue;
    }
    const sources = [...new Set([...(existing.sources ?? [existing.source]), r.source])];
    if (r.seeders > existing.seeders) byHash.set(r.infoHash, { ...r, sources });
    else existing.sources = sources;
  }
  return [...byHash.values()];
}

// torlink's default ordering: healthiest first. The results view can re-sort
// on demand (the `s` key), and its "none"/default state preserves this order.
export function defaultOrder(list: TorrentResult[]): TorrentResult[] {
  return list.sort((a, b) => {
    if (b.seeders !== a.seeders) return b.seeders - a.seeders;
    return (b.added ?? 0) - (a.added ?? 0);
  });
}

export interface SearchSnapshot {
  results: TorrentResult[];
  perSource: Record<SourceId, SourceState>;
  done: number;
  total: number;
}

export type SearchImpl = (
  source: Source,
  query: string,
  opts: SearchOptions,
) => Promise<TorrentResult[]>;

export interface RunSearchOptions {
  signal?: AbortSignal;
  // Called with a full merged+ordered snapshot each time a source settles.
  // Deliberately unthrottled: coalescing is a rendering concern, and the TUI
  // and the browser want different windows.
  onUpdate?: (snapshot: SearchSnapshot) => void;
  searchImpl?: SearchImpl;
  health?: Map<SourceId, Health>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Search every enabled source concurrently and return the merged result.
 *
 * Sources currently benched for repeated failures are skipped outright, so one
 * dead tracker can't stall a search on its timeout. Each source gets its own
 * timeout and its own error slot: a failure is recorded against that source and
 * never rejects the whole search.
 *
 * When the caller's signal aborts, in-flight sources are cancelled and no
 * further snapshots are emitted — the caller is no longer interested, and
 * recording failures for work we cancelled ourselves would wrongly bench
 * healthy sources.
 */
export async function runSearch(
  query: string,
  sources: readonly Source[],
  opts: RunSearchOptions = {},
): Promise<SearchSnapshot> {
  const {
    signal,
    onUpdate,
    searchImpl = cachedSearch,
    health = sourceHealth,
    now = Date.now,
    timeoutMs = PER_SOURCE_TIMEOUT_MS,
  } = opts;

  const active = sources.filter((s) => !isSkipped(health, s.id, now()));
  const perSource = blankPerSource(active, true);
  const collected: TorrentResult[] = [];
  let done = 0;

  const snapshot = (): SearchSnapshot => ({
    results: defaultOrder(mergeDuplicateResults(collected.slice())),
    perSource: { ...perSource },
    done,
    total: active.length,
  });

  await Promise.all(
    active.map(async (source) => {
      const sc = new AbortController();
      const onAbort = (): void => sc.abort();
      signal?.addEventListener("abort", onAbort);
      const abortTimer = setTimeout(() => sc.abort(), timeoutMs);
      try {
        const res = await searchImpl(source, query, { signal: sc.signal });
        if (signal?.aborted) return;
        collected.push(...res);
        perSource[source.id] = { loading: false, error: null, code: null, count: res.length };
        recordSuccess(health, source.id);
      } catch (e) {
        if (signal?.aborted) return;
        const timedOut = sc.signal.aborted;
        perSource[source.id] = {
          loading: false,
          error: timedOut ? "timed out" : e instanceof Error ? e.message : String(e),
          code: errorCode(e, timedOut),
          count: 0,
        };
        // A genuine failure (timeout or error) counts toward benching it.
        if (shouldBench(e)) recordFailure(health, source.id, now());
      } finally {
        clearTimeout(abortTimer);
        signal?.removeEventListener("abort", onAbort);
        if (!signal?.aborted) {
          done += 1;
          onUpdate?.(snapshot());
        }
      }
    }),
  );

  return snapshot();
}
