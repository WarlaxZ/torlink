import { useEffect, useMemo, useState } from "react";
import { enabledSources } from "../../sources/registry";
import { cachedSearch } from "../../sources/cache";
import { HttpError } from "../../util/net";
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

function dedupe(list: TorrentResult[]): TorrentResult[] {
  const byHash = new Map<string, TorrentResult>();
  for (const r of list) {
    const existing = byHash.get(r.infoHash);
    if (!existing || r.seeders > existing.seeders) byHash.set(r.infoHash, r);
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
    const per = blankPerSource(sources, true);
    let done = 0;

    setState({
      results: [],
      perSource: { ...per },
      loading: sources.length > 0,
      done: 0,
      total: sources.length,
    });

    for (const source of sources) {
      const sc = new AbortController();
      const onAbort = (): void => sc.abort();
      ctrl.signal.addEventListener("abort", onAbort);
      const timer = setTimeout(() => sc.abort(), PER_SOURCE_TIMEOUT_MS);

      cachedSearch(source, query, { signal: sc.signal })
        .then((res) => {
          if (!alive) return;
          collected.push(...res);
          per[source.id] = { loading: false, error: null, code: null, count: res.length };
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
        })
        .finally(() => {
          clearTimeout(timer);
          ctrl.signal.removeEventListener("abort", onAbort);
          if (!alive) return;
          done += 1;
          setState({
            results: defaultOrder(dedupe(collected.slice())),
            perSource: { ...per },
            loading: done < sources.length,
            done,
            total: sources.length,
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
