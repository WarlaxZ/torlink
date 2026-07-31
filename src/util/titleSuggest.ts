// Title autocomplete against reccd's `GET /search`, shared by both front ends.
//
// Everything here is pure and free of I/O and DOM, because both surfaces need
// the same answers and neither one's wiring is unit-testable: `app.ts` has no
// jsdom to run in, and the Ink tree is verified by rendering it. So the
// decisions live here, where they can be pinned by a test.

/** reccd's own vocabulary for what a title is. */
export type TitleSuggestionType = "movie" | "tv";

/**
 * One hit from reccd's `GET /search`, narrowed to what torlink renders.
 *
 * reccd also returns `genres`, `rating` and `votes` (its `SearchHit extends
 * CatalogTitle`). They are dropped at the client boundary: nothing on screen
 * uses them, and carrying unused fields through `wire.ts` invites a future
 * reader to assume something does.
 */
export interface TitleSuggestion {
  imdbId: string;
  title: string;
  year: number;
  type: TitleSuggestionType;
  /**
   * The alternate title that caused the hit, or null for a primary-title hit.
   * This is what lets the UI say "you typed X, we mean Y" — the reason reccd
   * returns it at all.
   */
  matchedAka: string | null;
}

/**
 * Matches reccd's `SEARCH_MIN_QUERY_LENGTH` (`reccd/src/api/server.ts:70`)
 * exactly. A smaller number fires requests reccd answers with `[]` and no DB
 * round trip; a larger one hides results reccd would have given.
 */
export const SUGGEST_MIN_QUERY_LENGTH = 2;

/** Asked for. The terminal renders 5 of these and the browser all 8. */
export const SUGGEST_LIMIT = 8;

/**
 * reccd's own measured latency is 174–311ms for broad prefixes, so this is
 * deliberately slower than the 150ms `useTitlePreview` uses against OMDb —
 * at 150ms the requests would queue behind each other.
 */
export const SUGGEST_DEBOUNCE_MS = 250;

/**
 * Not the 10s `fetchRecommendations` uses. A suggestion arriving after ten
 * seconds is noise: the user has finished typing and pressed Enter.
 */
export const SUGGEST_TIMEOUT_MS = 2500;

/** Vertical space is scarce in a terminal; the browser has no such limit. */
export const SUGGEST_ROWS_TERMINAL = 5;

export interface SuggestState {
  items: TitleSuggestion[];
  /**
   * The sequence number of the newest reply applied. Replies arrive out of
   * order (see `applyReply`), and this is what makes that harmless.
   */
  appliedSeq: number;
  /**
   * Text the user has already resolved — by accepting a suggestion or by
   * dismissing the list — for which no further request should fire.
   * Trimmed. Null when nothing is suppressed.
   */
  suppressedText: string | null;
}

export function emptySuggestState(): SuggestState {
  return { items: [], appliedSeq: 0, suppressedText: null };
}

export function shouldQuery(raw: string): boolean {
  return raw.trim().length >= SUGGEST_MIN_QUERY_LENGTH;
}

export function shouldQueryFor(state: SuggestState, raw: string): boolean {
  if (!shouldQuery(raw)) return false;
  return raw.trim() !== state.suppressedText;
}

/**
 * Fold a reply into the state, ignoring it if a newer one already landed.
 *
 * THIS GUARD IS LOAD-BEARING. reccd answers a two-character query in ~311ms
 * and an eight-character one in ~71ms, so typing through a broad prefix leaves
 * the slow, stale reply to land after the fast, fresh one. Without the
 * sequence check the visible list would disagree with the input box, and
 * debouncing does not help: two bursts separated by more than the debounce
 * window both fire and nothing orders their replies.
 */
export function applyReply(state: SuggestState, seq: number, items: TitleSuggestion[]): SuggestState {
  if (seq <= state.appliedSeq) return state;
  return { ...state, items, appliedSeq: seq };
}

/**
 * Close the list and stop asking about `raw`. Used by both accepting a
 * suggestion and dismissing with escape — accepting writes the suggestion's
 * text into the box, which fires the change handler again, and without this
 * the list would reopen on the text just picked.
 *
 * `appliedSeq` deliberately survives, so a request fired before this cannot
 * reopen the list when it answers.
 */
export function suppressFor(state: SuggestState, raw: string): SuggestState {
  return { ...state, items: [], suppressedText: raw.trim() };
}

export function topSuggestion(state: SuggestState): TitleSuggestion | null {
  return state.items[0] ?? null;
}

/** e.g. `Kestrel (2010) · film`. */
export function suggestionLabel(hit: TitleSuggestion): string {
  // reccd says movie/tv; torlink says film/show everywhere a user can read it.
  const kind = hit.type === "tv" ? "show" : "film";
  return `${hit.title} (${hit.year}) · ${kind}`;
}

/** The "you typed X, we mean Y" line, or null for a primary-title hit. */
export function akaNote(hit: TitleSuggestion): string | null {
  return hit.matchedAka === null ? null : `also known as "${hit.matchedAka}"`;
}

/**
 * What accepting this suggestion puts in the search box.
 *
 * Title AND year. The year is why canonicalising through a catalog is worth
 * doing: it separates a remake from its original, and torrent release names
 * carry it. Note `ForYou` submits title only — see the spec's known limits.
 */
export function submitTextFor(hit: TitleSuggestion): string {
  return `${hit.title} ${hit.year}`;
}

/** The splash's Tab hint, which changes meaning while a list is open. */
export function tabHintLabel(open: boolean): string {
  return open ? "complete" : "browse";
}
