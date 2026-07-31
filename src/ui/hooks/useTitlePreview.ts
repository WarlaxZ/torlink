import { useEffect, useRef, useState } from "react";
import type { FetchImpl } from "../../util/net";
import { fetchTitleMeta, fetchTitleMetaByName, type OmdbType } from "../../recc/omdb";
import { cachedPosterRows } from "../../core/posterCache";

// How to look a title up: by IMDb id (For You, where reccd supplies it) or by
// name parsed from a release string (search results).
export type MetaQuery =
  | { by: "id"; imdbId: string }
  | {
      by: "name";
      title: string;
      year?: number;
      type?: OmdbType;
      /**
       * One episode of a series. OMDb answers with THAT episode's plot, which is
       * the point of stepping down a season in the preview pane.
       */
      season?: number;
      episode?: number;
    };

interface Meta {
  imdbId: string | null;
  plot: string | null;
  posterUrl: string | null;
  type: OmdbType | null;
}

// undefined = still loading; null = looked up, none available.
export interface TitlePreview {
  imdbId: string | null | undefined;
  plot: string | null | undefined;
  posterRows: string[] | null | undefined;
  // OMDb's answer for this specific pick — the medium signal For You's Enter
  // handler prefers over its own filter (see util/autoPlayableFilm.ts).
  type: OmdbType | null | undefined;
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
  /**
   * Where the POSTER comes from, when it should not come from `query`.
   *
   * An episode lookup returns the episode's own artwork, which OMDb has for some
   * episodes and not others — so stepping down a season would flicker between a
   * poster and a blank frame. Point this at the series instead and the artwork
   * holds still while only the plot changes.
   *
   * Cached under `posterMetaKey`, so it costs ONE extra lookup per show rather
   * than one per episode. Omit both to take the poster from `query` as before.
   */
  posterQuery?: MetaQuery | null;
  posterMetaKey?: string;
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
    posterQuery = null,
    posterMetaKey = "",
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
  const posterQueryRef = useRef(posterQuery);
  posterQueryRef.current = posterQuery;

  // Keyed on whichever meta owns the poster. For episodes that is the SERIES,
  // so every episode of a show shares one rendered poster instead of
  // re-rasterising the same image per row.
  const posterOwner = posterMetaKey || cacheKey;
  const posterKey = posterOwner ? `${posterOwner}:${posterCols}` : "";

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
          : fetchTitleMetaByName(q.title, omdbApiKey, {
              year: q.year,
              type: q.type,
              season: q.season,
              episode: q.episode,
              fetchImpl,
            });
      void p.then((res) => {
        if (cancelled) return;
        metas.current.set(
          cacheKey,
          res.ok
            ? { imdbId: res.imdbId, plot: res.plot, posterUrl: res.posterUrl, type: res.type ?? null }
            : { imdbId: null, plot: null, posterUrl: null, type: null },
        );
        bump((n) => n + 1);
      });
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [omdbApiKey, enabled, cacheKey, fetchImpl, debounceMs]);

  // The series-level lookup that owns the poster, when one was asked for. Same
  // debounce and same cache as the main one — it is the same shape of request.
  useEffect(() => {
    if (!omdbApiKey || !posterEnabled || !posterMetaKey || metas.current.has(posterMetaKey)) return;
    let cancelled = false;
    const t = setTimeout(() => {
      const q = posterQueryRef.current;
      if (!q) return;
      const p =
        q.by === "id"
          ? fetchTitleMeta(q.imdbId, omdbApiKey, { fetchImpl })
          : fetchTitleMetaByName(q.title, omdbApiKey, { year: q.year, type: q.type, fetchImpl });
      void p.then((res) => {
        if (cancelled) return;
        metas.current.set(
          posterMetaKey,
          res.ok
            ? { imdbId: res.imdbId, plot: res.plot, posterUrl: res.posterUrl, type: res.type ?? null }
            : { imdbId: null, plot: null, posterUrl: null, type: null },
        );
        bump((n) => n + 1);
      });
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [omdbApiKey, posterEnabled, posterMetaKey, fetchImpl, debounceMs]);

  const meta = cacheKey ? metas.current.get(cacheKey) : undefined;
  const posterMeta = posterMetaKey ? metas.current.get(posterMetaKey) : undefined;
  // The series poster wins when one was asked for: an episode's own artwork is
  // patchy, and a pane that blanks on every other episode is worse than a still
  // one. Undefined (not yet loaded) must NOT fall through to the episode's.
  const posterUrl = (posterMetaKey ? posterMeta?.posterUrl : meta?.posterUrl) ?? null;

  // Poster image (the expensive step), only once we know its URL and it's wanted.
  useEffect(() => {
    if (!posterEnabled || !posterUrl || !posterKey || posters.current.has(posterKey)) return;
    let cancelled = false;
    void cachedPosterRows(posterUrl, posterCols, posterMaxRows, { fetchImpl }).then((rows) => {
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
    posterRows: (() => {
      // Loading is the POSTER's own state, not the plot's: for an episode the
      // two are separate lookups and the plot usually lands first.
      const owner = posterMetaKey ? posterMeta : meta;
      if (owner === undefined) return undefined;
      return owner.posterUrl === null ? null : posters.current.get(posterKey);
    })(),
    type: meta === undefined ? undefined : meta.type,
  };
}
