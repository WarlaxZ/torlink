import { useEffect, useMemo, useState } from "react";
import { enabledSources } from "../../sources/registry";
import { cachedSearch } from "../../sources/cache";
import { isSkipped, recordFailure, recordSuccess, sourceHealth } from "../../sources/sourceHealth";
import { HttpError } from "../../util/net";
import { AuthRequiredError } from "../../sources/rutracker";
import type { Source, SourceId, TorrentResult } from "../../sources/types";

export interface SourceState {
  loading: boolean;
  error: string | null;
  code: string | null;
  count: number;
}

function errorCode(e: unknown, timedOut: boolean): string {
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

export interface ConcurrentSearchState {
  results: TorrentResult[];
  perSource: Record<SourceId, SourceState>;
  loading: boolean;
  done: number;
  total: number;
}

const PER_SOURCE_TIMEOUT_MS = 25000;

function blankPerSource(sources: readonly Source[], loading: boolean): Record<SourceId, SourceState> {
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
function defaultOrder(list: TorrentResult[]): TorrentResult[] {
  return list.sort((a, b) => {
    if (b.seeders !== a.seeders) return b.seeders - a.seeders;
    return (b.added ?? 0) - (a.added ?? 0);
  });
}

function idleState(sources: readonly Source[]): ConcurrentSearchState {
  return {
    results: [],
    perSource: blankPerSource(sources, false),
    loading: false,
    done: 0,
    total: sources.length,
  };
}

export function useConcurrentSearch(
  query: string,
  disabled: readonly SourceId[] = [],
): ConcurrentSearchState {
  // A stable key so the search only re-runs when the *set* of enabled sources
  // changes, not on every render that hands in a fresh array.
  const disabledKey = disabled.join(",");
  const sources = useMemo(() => enabledSources(disabled), [disabledKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useState<ConcurrentSearchState>(() => idleState(sources));

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    const collected: TorrentResult[] = [];
    // Skip sources that are currently benched for repeated failures, so a dead
    // source doesn't stall every search on its timeout. They come back on their
    // own once the cooldown lapses.
    const active = sources.filter((s) => !isSkipped(sourceHealth, s.id, Date.now()));
    const per = blankPerSource(active, true);
    let done = 0;

    setState({
      results: [],
      perSource: { ...per },
      loading: active.length > 0,
      done: 0,
      total: active.length,
    });

    for (const source of active) {
      const sc = new AbortController();
      const onAbort = (): void => sc.abort();
      ctrl.signal.addEventListener("abort", onAbort);
      const timer = setTimeout(() => sc.abort(), PER_SOURCE_TIMEOUT_MS);

      cachedSearch(source, query, { signal: sc.signal })
        .then((res) => {
          if (!alive) return;
          collected.push(...res);
          per[source.id] = { loading: false, error: null, code: null, count: res.length };
          recordSuccess(sourceHealth, source.id);
        })
        .catch((e: unknown) => {
          if (!alive || ctrl.signal.aborted) return;
          const timedOut = sc.signal.aborted;
          per[source.id] = {
            loading: false,
            error: timedOut ? "timed out" : e instanceof Error ? e.message : String(e),
            code: errorCode(e, timedOut),
            count: 0,
          };
          // A genuine failure (timeout or error) counts toward benching it.
          if (shouldBench(e)) {
            recordFailure(sourceHealth, source.id, Date.now());
          }
        })
        .finally(() => {
          clearTimeout(timer);
          ctrl.signal.removeEventListener("abort", onAbort);
          if (!alive) return;
          done += 1;
          setState({
            results: defaultOrder(mergeDuplicateResults(collected.slice())),
            perSource: { ...per },
            loading: done < active.length,
            done,
            total: active.length,
          });
        });
    }

    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [query, sources]);

  return state;
}
