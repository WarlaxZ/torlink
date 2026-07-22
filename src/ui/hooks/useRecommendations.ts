import { useCallback, useEffect, useRef, useState } from "react";
import type { FetchImpl } from "../../util/net";
import {
  fetchRecommendations,
  type ReccClientConfig,
  type Recommendation,
  type RecommendationQuery,
} from "../../recc/client";

export type ReccType = "all" | "movie" | "tv";

export interface RecommendationsState {
  items: Recommendation[];
  loading: boolean;
  error: string | null;
  type: ReccType;
  genre: string;
  explore: boolean;
  refresh: () => void;
  dismiss: (imdbId: string) => void;
  setType: (t: ReccType) => void;
  setGenre: (g: string) => void;
  toggleExplore: () => void;
}

// Owns the For You view's fetch state and filters. Fetches lazily — only once
// the section is first visited (`enabled`), then again on refresh or any filter
// change. A request counter guards against an older in-flight response landing
// after a newer one.
export function useRecommendations(
  config: ReccClientConfig,
  enabled: boolean,
  fetchImpl?: FetchImpl,
): RecommendationsState {
  const [items, setItems] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [type, setTypeState] = useState<ReccType>("all");
  const [genre, setGenreState] = useState("");
  const [explore, setExplore] = useState(false);
  const loadedRef = useRef(false);
  const filtersRef = useRef({ type, genre, explore });
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    if (!config.reccUrl) {
      setItems([]);
      setError(null);
      return;
    }
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    const query: RecommendationQuery = {
      type: type === "all" ? undefined : type,
      genre: genre.trim() || undefined,
      explore,
      limit: 20,
    };
    const result = await fetchRecommendations(config, query, { fetchImpl });
    if (req !== reqRef.current) return; // superseded by a newer request
    if (result.ok) {
      setItems(result.items);
      setError(null);
    } else {
      setItems([]);
      setError(result.error);
    }
    setLoading(false);
  }, [config, type, genre, explore, fetchImpl]);

  // Lazy first load: fire once, the first time the section is visited.
  useEffect(() => {
    if (enabled && !loadedRef.current && config.reccUrl) {
      loadedRef.current = true;
      filtersRef.current = { type, genre, explore };
      void load();
    }
  }, [enabled, config.reccUrl, load, type, genre, explore]);

  // Refetch when a filter actually changes after the first load. Compared
  // against the last-loaded filters (not merely "has loaded"), so this never
  // double-fires alongside the lazy first load on the initial commit. config /
  // fetchImpl are intentionally excluded: their identity churns every render
  // and should not trigger a refetch on their own (use `r` / refresh for that).
  useEffect(() => {
    if (!loadedRef.current) return;
    const prev = filtersRef.current;
    if (prev.type === type && prev.genre === genre && prev.explore === explore) return;
    filtersRef.current = { type, genre, explore };
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, genre, explore]);

  const refresh = useCallback(() => void load(), [load]);

  // Optimistically remove a pick from the list (e.g. once it's been rated).
  // Events are fire-and-forget, so we don't wait on reccd before dropping it.
  const dismiss = useCallback((imdbId: string) => {
    setItems((prev) => prev.filter((it) => it.imdbId !== imdbId));
  }, []);
  const setType = useCallback((t: ReccType) => setTypeState(t), []);
  const setGenre = useCallback((g: string) => setGenreState(g), []);
  const toggleExplore = useCallback(() => setExplore((v) => !v), []);

  return { items, loading, error, type, genre, explore, refresh, dismiss, setType, setGenre, toggleExplore };
}
