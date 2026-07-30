// Whether a For You row can be auto-played. IMPORTS NOTHING, like its
// siblings `resultSort.ts` and `resultFilter.ts`, and for the same reason:
// `src/web/static/` is bundled with `platform: "browser"`, so a module both
// front ends share cannot reach anything Node-shaped.

/**
 * What OMDb says a title is.
 *
 * Restated rather than imported from `src/recc/omdb.ts`. A type-only import
 * would in fact be safe — it is erased at build time, which is how
 * `release.ts` gets `OmdbType` — but this module has no imports at all, and
 * keeping it that way is the property that makes it obviously bundle-safe.
 */
export type ReccMedium = "movie" | "series";
/** The For You pane's type filter, in both front ends. */
export type ReccFilter = "all" | "movie" | "tv";

/**
 * Whether a For You row can be auto-played. Only a film has an unambiguous
 * intent — a show needs the season/episode picker (spec D).
 *
 * `omdbType` is per-item and wins when known. The pane's filter is the
 * fallback for when there is no OMDb key, and it can only ever say "yes,
 * film": "all" means the medium is genuinely unknown, because reccd sends no
 * per-item type (`useRecommendations.ts:38` starts the filter at "all").
 *
 * HERE rather than in either front end because both need it and `src/web`
 * may not import `src/ui` (eslint.config.js:78). Two copies of one rule is
 * the copy-then-drift bug this codebase has hit four times.
 */
export function autoPlayableFilm(
  omdbType: ReccMedium | null | undefined,
  filter: ReccFilter,
): boolean {
  if (omdbType) return omdbType === "movie";
  return filter === "movie";
}
