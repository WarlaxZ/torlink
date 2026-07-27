import { useEffect, useMemo, useState } from "react";
import { enabledSources } from "../../sources/registry";
import { blankPerSource, runSearch, type SearchSnapshot, type SourceState } from "../../core/search";
import type { Source, SourceId } from "../../sources/types";
import type { TorrentResult } from "../../sources/types";

// Re-exported so existing importers (and their tests) keep their entry points
// while the logic itself lives in core/search.ts.
export { mergeDuplicateResults, shouldBench } from "../../core/search";
export type { SourceState } from "../../core/search";

export interface ConcurrentSearchState {
  results: TorrentResult[];
  perSource: Record<SourceId, SourceState>;
  loading: boolean;
  done: number;
  total: number;
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

// Coalesce interval for streaming result updates. Sources finish in bursts (a
// cache hit or a couple of fast hosts land almost together), and each update
// re-sorts and re-renders the whole list. Flushing at most once per this window
// keeps a burst from flooding Ink with re-renders and blocking stdin — the same
// leading-throttle the queue hooks in store.ts use for `update` events.
const RESULT_FLUSH_MS = 150;

function toState(snap: SearchSnapshot): ConcurrentSearchState {
  return {
    results: snap.results,
    perSource: snap.perSource,
    loading: snap.done < snap.total,
    done: snap.done,
    total: snap.total,
  };
}

export function useConcurrentSearch(
  query: string,
  disabled: readonly SourceId[] = [],
  adultEnabled = false,
): ConcurrentSearchState {
  // A stable key so the search only re-runs when the *set* of enabled sources
  // changes, not on every render that hands in a fresh array.
  const disabledKey = `${disabled.join(",")}|${adultEnabled ? "1" : "0"}`;
  const sources = useMemo(() => enabledSources(disabled, adultEnabled), [disabledKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useState<ConcurrentSearchState>(() => idleState(sources));

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: SearchSnapshot | null = null;

    const flush = (): void => {
      if (!alive || !pending) return;
      setState(toState(pending));
      pending = null;
    };

    // Push the accumulated snapshot to the UI, but no more than once per
    // window. The final source flushes immediately so "done" / loading:false
    // is prompt.
    const onUpdate = (snap: SearchSnapshot): void => {
      if (!alive) return;
      pending = snap;
      if (snap.done >= snap.total) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        flush();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, RESULT_FLUSH_MS);
    };

    setState({
      results: [],
      perSource: blankPerSource(sources, true),
      loading: sources.length > 0,
      done: 0,
      total: sources.length,
    });

    void runSearch(query, sources, { signal: ctrl.signal, onUpdate }).then((snap) => {
      if (!alive) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      setState(toState(snap));
    });

    return () => {
      alive = false;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [query, sources]);

  return state;
}
