import { useEffect, useRef, useState } from "react";
import type { FetchImpl } from "../../util/net";
import { fetchTitleMeta, fetchTitleMetaByName, type OmdbType } from "../../recc/omdb";
import { fetchPosterRows } from "../../util/poster";

// How to look a title up: by IMDb id (For You, where reccd supplies it) or by
// name parsed from a release string (search results).
export type MetaQuery =
  | { by: "id"; imdbId: string }
  | { by: "name"; title: string; year?: number; type?: OmdbType };

interface Meta {
  imdbId: string | null;
  plot: string | null;
  posterUrl: string | null;
}

// undefined = still loading; null = looked up, none available.
export interface TitlePreview {
  imdbId: string | null | undefined;
  plot: string | null | undefined;
  posterRows: string[] | null | undefined;
}

interface Args {
  omdbApiKey: string;
  // Fetch metadata (plot/poster URL) for the selection. Cheap; drives the plot.
  enabled: boolean;
  // Additionally fetch + render the poster image (the expensive part). Defaults
  // to `enabled`. Set false to get the plot without paying for the poster.
  posterEnabled?: boolean;
  // Stable identity of the current selection ("" when nothing is selected).
  // Same key ⇒ same query ⇒ one cached lookup, so quality/group variants and
  // repeat visits don't re-request.
  cacheKey: string;
  query: MetaQuery | null;
  posterCols: number;
  posterMaxRows: number;
  fetchImpl?: FetchImpl;
  debounceMs?: number;
}

// Lazily resolves a selection's plot + poster from OMDb, debounced and cached
// by `cacheKey`. Shared by the For You and search-results preview panes.
export function useTitlePreview(args: Args): TitlePreview {
  const {
    omdbApiKey,
    enabled,
    posterEnabled = enabled,
    cacheKey,
    query,
    posterCols,
    posterMaxRows,
    fetchImpl,
    debounceMs = 150,
  } = args;

  const metas = useRef(new Map<string, Meta>());
  const posters = useRef(new Map<string, string[] | null>());
  const [, bump] = useState(0);
  // `query` is a fresh object each render; drive effects off `cacheKey` (which
  // uniquely identifies it) and read the query itself from a ref.
  const queryRef = useRef(query);
  queryRef.current = query;

  const posterKey = cacheKey ? `${cacheKey}:${posterCols}` : "";

  // Metadata (plot + poster URL), debounced so scrolling doesn't spam OMDb.
  useEffect(() => {
    if (!omdbApiKey || !enabled || !cacheKey || metas.current.has(cacheKey)) return;
    let cancelled = false;
    const t = setTimeout(() => {
      const q = queryRef.current;
      if (!q) return;
      const p =
        q.by === "id"
          ? fetchTitleMeta(q.imdbId, omdbApiKey, { fetchImpl })
          : fetchTitleMetaByName(q.title, omdbApiKey, { year: q.year, type: q.type, fetchImpl });
      void p.then((res) => {
        if (cancelled) return;
        metas.current.set(
          cacheKey,
          res.ok
            ? { imdbId: res.imdbId, plot: res.plot, posterUrl: res.posterUrl }
            : { imdbId: null, plot: null, posterUrl: null },
        );
        bump((n) => n + 1);
      });
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [omdbApiKey, enabled, cacheKey, fetchImpl, debounceMs]);

  const meta = cacheKey ? metas.current.get(cacheKey) : undefined;
  const posterUrl = meta?.posterUrl ?? null;

  // Poster image (the expensive step), only once we know its URL and it's wanted.
  useEffect(() => {
    if (!posterEnabled || !posterUrl || !posterKey || posters.current.has(posterKey)) return;
    let cancelled = false;
    void fetchPosterRows(posterUrl, posterCols, posterMaxRows, { fetchImpl }).then((rows) => {
      if (cancelled) return;
      posters.current.set(posterKey, rows);
      bump((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [posterEnabled, posterUrl, posterKey, posterCols, posterMaxRows, fetchImpl]);

  return {
    imdbId: meta === undefined ? undefined : meta.imdbId,
    plot: meta === undefined ? undefined : meta.plot,
    posterRows: meta === undefined ? undefined : meta.posterUrl === null ? null : posters.current.get(posterKey),
  };
}
