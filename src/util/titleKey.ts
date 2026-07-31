/**
 * One definition of "the same show", shared by the two things that key on it.
 *
 * IMPORTS NOTHING, deliberately, for the reason `streamHistoryKey.ts` states
 * about itself: that file must stay reachable from `src/web/static/**`, which
 * may not touch a `node:*` builtin even transitively. Leaving this in
 * `resultGroup.ts` would drag `parse-torrent-title` into every consumer of the
 * history key.
 *
 * It exists because those two producers had drifted. `historyKeyFor` lower-cased
 * the parsed title and stopped; `normaliseTitle` also stripped a tracker prefix,
 * a bracketed group tag, pack filler and a leading article. Four of six measured
 * shapes disagreed, so a show you were mid-way through showed no position, and
 * Continue-watching grew a second row for it.
 */

/**
 * Normalise a parsed title before it becomes a key.
 *
 * THE ORDER IS LOAD-BEARING. Punctuation becomes spaces BEFORE the leading
 * article is dropped: a title wrapped in another script — "супер … (the …
 * movie)" appears in live data — keeps its "the" if the article is stripped
 * first, and splits off into a group of its own.
 */
export function normaliseTitle(raw: string): string {
  const base = raw
    // "www.uindex.org    -    Kestrel 2010": a tracker stamps its own domain on
    // the front of the release name. Five of 129 live results for one film were
    // stranded in a group of their own by this alone.
    .replace(/^\s*(?:www\.)?[a-z0-9-]+\.[a-z]{2,12}\s*[-–—]\s*/i, "")
    // "[Judas] Harrowgate S03": see BRACKET_PREFIX.
    .replace(BRACKET_PREFIX, "")
    .replace(/\.(?:mkv|mp4|m4v|avi|7z|zip|iso)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(?:the|a|an)\s+/, "")
    .trim();
  // "Harrowgate Complete Series" is the same show as "Harrowgate": the parser
  // leaves pack words in the title when no season number follows them to anchor
  // on. Stripped only from the END and never down to nothing, so a title that is
  // genuinely one of these words survives.
  const trimmed = base.replace(PACK_FILLER, "").trim();
  return trimmed || base;
}

export const PACK_FILLER = /(?:[\s._-]+(?:complete|full|series|seasons?|packs?))+$/i;

/**
 * A release group in brackets on the front, the convention for fansubbed shows.
 *
 * The lookahead demands a LETTER in what is left, not merely a non-space: a film
 * actually titled "(Ashfall) 1999" would otherwise reduce to "1999", and a title
 * eaten down to a bare number groups with every other numeric residue. Bracketed
 * junk in front of nothing is not a prefix, it IS the name.
 */
export const BRACKET_PREFIX = /^\s*[[({][^\])}]*[\])}]\s*(?=[^a-z]*[a-z])/i;

/**
 * The same two strips, on a DISPLAY title, which keeps its own case.
 *
 * A heading reading "Harrowgate COMPLETE SERIES" while the group beside it reads
 * "Harrowgate" is the duplicate-looking-rows complaint one layer up: the key
 * already treats them as one thing, so the label has to as well.
 */
export function tidyTitle(raw: string): string {
  const base = raw.replace(BRACKET_PREFIX, "").trim();
  return base.replace(PACK_FILLER, "").trim() || base;
}
