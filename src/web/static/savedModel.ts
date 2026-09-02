// The saved pane's decisions: which request each button sends, what each list
// says when it is empty or broken, and how one row is labelled.
//
// Separate from app.ts for the reason every model in this directory is — there
// is no jsdom here, so anything with a decision in it has to be reachable
// without a DOM.
//
// Bundled for the browser: no node:* imports, direct or transitive.
import { formatBytes } from "./dashboard";
import type {
  ContinueWatchingRequest,
  LibraryRequest,
  PublicFavourite,
  PublicStreamHistoryItem,
  SavedSearchesRequest,
} from "../wire";

export type { PublicFavourite, PublicStreamHistoryItem, SavedResponse } from "../wire";

/** Everything the pane renders from. */
export interface SavedState {
  /** Saved search queries, most-recent first. The TUI's `savedSearches`. */
  savedSearches: string[];
  /** Favourited torrents, most-recent first. The TUI's `library`. */
  library: PublicFavourite[];
  /**
   * Titles part-way through, most-recent first. The TUI's `streamHistory`.
   *
   * NOT re-sorted here: `recordStream` (src/core/streamHistory.ts) prepends on
   * every stream, so the server's array already arrives newest-first. Sorting
   * again would be redundant at best and, if the tie-break ever disagreed with
   * the store's own order, a silent divergence from the TUI's list.
   */
  continueWatching: PublicStreamHistoryItem[];
  /** The active category tab for `library` — "All" or one of `libraryCategories`. */
  libraryCategory: string;
  /** The active category tab for `continueWatching` — "All" or one of `continueWatchingCategories`. */
  continueWatchingCategory: string;
  /** Non-empty category tabs for `library`, "All" always first, from the server. */
  libraryCategories: string[];
  /** Non-empty category tabs for `continueWatching`, "All" always first, from the server. */
  continueWatchingCategories: string[];
  /**
   * Whether a response has ever arrived.
   *
   * NOT derivable from the two lists being empty, and conflating them is the
   * bug this field exists to prevent: "you have not saved anything" and "this
   * has not loaded yet" are different sentences, and showing the first while
   * the request is still in flight tells the user their library is gone.
   */
  loaded: boolean;
  /** Why the last request failed, or null. Shown over both lists. */
  error: string | null;
}

export function emptySaved(): SavedState {
  return {
    savedSearches: [],
    library: [],
    continueWatching: [],
    libraryCategory: "All",
    continueWatchingCategory: "All",
    libraryCategories: ["All"],
    continueWatchingCategories: ["All"],
    loaded: false,
    error: null,
  };
}

/** The item's own category matches the active tab, or the active tab is "All". */
export function libraryForCategory(state: SavedState): PublicFavourite[] {
  return state.libraryCategory === "All"
    ? state.library
    : state.library.filter((f) => f.category === state.libraryCategory);
}

/** Same as {@link libraryForCategory}, for `continueWatching`. */
export function continueWatchingForCategory(state: SavedState): PublicStreamHistoryItem[] {
  return state.continueWatchingCategory === "All"
    ? state.continueWatching
    : state.continueWatching.filter((c) => c.category === state.continueWatchingCategory);
}

/** Falls back to "All" once the active tab is no longer among the available ones — e.g. the last item in it was just removed. */
function clampCategory(current: string, available: readonly string[]): string {
  return available.includes(current) ? current : "All";
}

/** The `POST /api/saved-searches` body. Trimmed here so the box's stray spaces cannot create a second entry. */
export function savedSearchesBody(query: string, action: "toggle" | "remove"): SavedSearchesRequest {
  return { query: query.trim(), action };
}

/**
 * The `POST /api/continue-watching` body. One action, `"remove"` — nothing
 * plays a title and then un-plays it, so there is no toggle to send.
 */
export function continueWatchingBody(key: string): ContinueWatchingRequest {
  return { key, action: "remove" };
}

/** What a caller must know about a torrent to favourite it. A search result satisfies this. */
export interface LibraryInput {
  infoHash: string;
  name: string;
  sizeBytes?: number;
  source?: string;
}

/**
 * The `POST /api/library` body.
 *
 * `name` IS NOT DECORATION. The server builds the stored magnet with
 * `buildMagnet(infoHash, name)` because a search result carries none, so this
 * string becomes the magnet's `dn` and the library row's label. Send the hash
 * without it and the favourite is 40 hex characters.
 *
 * `sizeBytes: 0` is omitted rather than sent: the server treats any positive
 * value as "size known", and a zero would be a claim of a zero-byte torrent.
 */
export function libraryBody(
  input: LibraryInput,
  action: "toggle" | "remove" | "watched",
  filename?: string,
): LibraryRequest {
  const body: LibraryRequest = { infoHash: input.infoHash, name: input.name, action };
  if (input.sizeBytes !== undefined && input.sizeBytes > 0) body.sizeBytes = input.sizeBytes;
  if (input.source) body.source = input.source;
  // Only where it means something. Sending it on a toggle would imply the
  // server might act on it there.
  if (action === "watched" && filename) body.filename = filename;
  return body;
}

export function isInLibrary(state: SavedState, infoHash: string): boolean {
  return state.library.some((f) => f.id === infoHash);
}

/**
 * The ★ button's label.
 *
 * Named for what the click WILL DO, not for the current state. A button reading
 * "favourited" invites a click that un-favourites — the opposite of what it
 * appears to promise.
 */
export function favouriteLabel(inLibrary: boolean): string {
  return inLibrary ? "unfavourite" : "favourite";
}

/**
 * One library row's meta line: progress, then size.
 *
 * Zero watched says nothing rather than "0 watched" — a favourite you have not
 * started is not a progress report. An unknown size says so rather than
 * printing "0 B", the same call `resultMeta` makes for a swarm it cannot see.
 */
export function favouriteMeta(f: PublicFavourite): string {
  const parts: string[] = [];
  if (f.watched > 0) parts.push(`${f.watched} watched`);
  if (f.sizeBytes !== undefined && f.sizeBytes > 0) {
    parts.push(formatBytes(f.sizeBytes));
  }
  if (parts.length === 0) {
    parts.push("size unknown");
  }
  return parts.join(" · ");
}

/** A status line for one of the two lists, and whether it is bad news. */
export interface SavedStatus {
  text: string;
  show: boolean;
  tone: "dim" | "error";
}

// An error outranks everything, INCLUDING having rows: a stale list next to no
// explanation is worse than a stale list with one, because the user cannot tell
// that these rows may no longer match the server.
function statusFor(state: SavedState, count: number, empty: string): SavedStatus {
  if (state.error !== null) return { text: state.error, show: true, tone: "error" };
  if (!state.loaded) return { text: "Loading…", show: true, tone: "dim" };
  // Once there are rows, the rows are the content; a count would be redundant
  // with what the user is already looking at.
  return { text: empty, show: count === 0, tone: "dim" };
}

export function savedSearchesStatus(state: SavedState): SavedStatus {
  return statusFor(state, state.savedSearches.length, "Save a search to keep it here.");
}

export function libraryStatus(state: SavedState): SavedStatus {
  return statusFor(state, state.library.length, "Favourite a result to keep it here.");
}

/**
 * Fold a `GET /api/saved` response into the state.
 *
 * `body` is `unknown`, not `SavedResponse`, matching its two siblings below:
 * it is whatever came back over the network — a proxy's HTML error page, a
 * `null`, an array — and typing it as the wire shape would be a claim this
 * function's own `Array.isArray` guards already say it does not believe. A
 * `.map` over `undefined` here would take the pane down rather than show its
 * error line, which is what those guards are for.
 */
export function applySaved(state: SavedState, body: unknown): SavedState {
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const savedSearches = obj?.savedSearches;
  const library = obj?.library;
  const continueWatching = obj?.continueWatching;
  const libraryCategories = Array.isArray(obj?.libraryCategories) ? (obj.libraryCategories as string[]) : ["All"];
  const continueWatchingCategories = Array.isArray(obj?.continueWatchingCategories)
    ? (obj.continueWatchingCategories as string[])
    : ["All"];
  return {
    ...state,
    savedSearches: Array.isArray(savedSearches) ? (savedSearches as string[]) : [],
    library: Array.isArray(library) ? (library as PublicFavourite[]) : [],
    continueWatching: Array.isArray(continueWatching) ? (continueWatching as PublicStreamHistoryItem[]) : [],
    libraryCategories,
    continueWatchingCategories,
    libraryCategory: clampCategory(state.libraryCategory, libraryCategories),
    continueWatchingCategory: clampCategory(state.continueWatchingCategory, continueWatchingCategories),
    loaded: true,
    error: null,
  };
}

/**
 * Fold a `POST /api/saved-searches` response into the state.
 *
 * `body` is `unknown`, not `SavedSearchesResponse`, because it is whatever
 * came back over the network — `null`, an array, an object whose
 * `savedSearches` field is not an array — and this is the one place that
 * guard belongs rather than four copies of it in app.ts. On a malformed body
 * the existing list is kept rather than emptied — a request that came back
 * garbled is not evidence the list is now empty.
 */
export function applySavedSearchesResponse(state: SavedState, body: unknown): SavedState {
  const list =
    body && typeof body === "object" ? (body as { savedSearches?: unknown }).savedSearches : undefined;
  return {
    ...state,
    savedSearches: Array.isArray(list) ? (list as string[]) : state.savedSearches,
    loaded: true,
    error: null,
  };
}

/** The same fold as {@link applySavedSearchesResponse}, for `POST /api/library`. */
export function applyLibraryResponse(state: SavedState, body: unknown): SavedState {
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const list = obj?.library;
  const libraryCategories = Array.isArray(obj?.libraryCategories)
    ? (obj.libraryCategories as string[])
    : state.libraryCategories;
  return {
    ...state,
    library: Array.isArray(list) ? (list as PublicFavourite[]) : state.library,
    libraryCategories,
    libraryCategory: clampCategory(state.libraryCategory, libraryCategories),
    loaded: true,
    error: null,
  };
}

/** The same fold as {@link applySavedSearchesResponse}, for `POST /api/continue-watching`. */
export function applyContinueWatchingResponse(state: SavedState, body: unknown): SavedState {
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const list = obj?.continueWatching;
  const continueWatchingCategories = Array.isArray(obj?.continueWatchingCategories)
    ? (obj.continueWatchingCategories as string[])
    : state.continueWatchingCategories;
  return {
    ...state,
    continueWatching: Array.isArray(list) ? (list as PublicStreamHistoryItem[]) : state.continueWatching,
    continueWatchingCategories,
    continueWatchingCategory: clampCategory(state.continueWatchingCategory, continueWatchingCategories),
    loaded: true,
    error: null,
  };
}

/**
 * The notice shown after a saved-searches toggle.
 *
 * Reads `body.saved` rather than trusting the button's own optimistic label,
 * so a request that reached the server but flipped the opposite way (a race
 * with another tab, say) still reports what actually happened.
 */
export function savedSearchesToggleNotice(body: unknown): string {
  const saved = !!(body && typeof body === "object" && (body as { saved?: unknown }).saved === true);
  return saved ? "Saved to your searches." : "Removed from your searches.";
}

/** The same choice as {@link savedSearchesToggleNotice}, for a library toggle. */
export function libraryToggleNotice(body: unknown): string {
  const favourited = !!(
    body &&
    typeof body === "object" &&
    (body as { favourited?: unknown }).favourited === true
  );
  return favourited ? "Added to your library." : "Removed from your library.";
}

/**
 * "just now" / "N minutes ago" / … / "N weeks ago", for a continue-watching
 * row's age. `now` is a parameter rather than `Date.now()` read inside so the
 * three boundary tests (`savedModel.test.ts`) are arithmetic, not a race
 * against the clock.
 */
export function relativeAge(then: number, now: number): string {
  const diffMs = Math.max(0, now - then);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;

  const minutes = Math.floor(diffMs / MIN);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(diffMs / HOUR);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(diffMs / DAY);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;

  const weeks = Math.floor(diffMs / WEEK);
  return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
}

/**
 * "S02E04", zero-padded to two digits each — the same shape `nextLabel`
 * (src/core/streamHistory.ts) uses for its `"next S02E05"`.
 *
 * EXPORTED SO A TEST CAN CROSS-CHECK IT AGAINST `nextLabel` DIRECTLY, not just
 * trust that this comment is still true. This module cannot *import*
 * `nextLabel` (it pulls in `node:fs` via `src/core/streamHistory.ts`, which
 * would break the browser build — see the module header), so a hand-copied
 * format string is exactly the copy-then-drift shape this codebase has hit
 * four times before. `savedModel.test.ts`'s "agrees with nextLabel" case
 * imports `nextLabel` itself (fine in a test file, which is never bundled)
 * and asserts the two produce the same `"next SxxExx"` fragment — the only
 * string actually shared between the two front ends, since the TUI's pane
 * renders no age and no "last SxxExx" of its own.
 */
export function episodeTag(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/**
 * Which category tab a Continue-watching row's artwork should be looked up as.
 *
 * Not the search tab the user last clicked: these rows are not part of a
 * search, and a show looked up under "Movies" comes back with the wrong poster
 * or none. `type` is the store's own judgement, written when the row was
 * recorded, so this is a translation rather than a second guess. Falls back to
 * `ALL_TAB` when the store never decided — `previewApplies` accepts it and OMDb
 * is left to work it out.
 */
export function continueWatchingGroup(item: PublicStreamHistoryItem): string {
  if (item.type === "series") return "TV";
  if (item.type === "movie") return "Movies";
  return "All";
}

/**
 * A continue-watching row's subtitle: age, the last episode watched (when this
 * is a series), and the next one to offer (when the server computed one).
 *
 * `item.next` — not a local re-derivation — is what decides whether "next …"
 * appears: it is computed server-side by `nextEpisode`
 * (src/core/streamHistory.ts) and is null for a film and for a season pack, so
 * trusting it here is what keeps this string identical to the TUI's, without
 * importing `src/core/streamHistory.ts` (which pulls in `node:fs`) into this
 * browser bundle.
 */
export function continueWatchingSub(item: PublicStreamHistoryItem, now: number): string {
  const parts = [relativeAge(item.startedAt, now)];
  if (item.season !== undefined && item.episode !== undefined) {
    parts.push(`last ${episodeTag(item.season, item.episode)}`);
  }
  if (item.next) {
    parts.push(`next ${episodeTag(item.next.season, item.next.episode)}`);
  }
  return parts.join(" · ");
}

/**
 * What to search for when the remembered torrent will not resolve.
 *
 * The next episode when there is one — searching for the episode you have NOT
 * seen beats searching for the one you just watched — else the bare title
 * (a film, or a season pack that named no episode).
 */
export function continueWatchingFallbackQuery(item: PublicStreamHistoryItem): string {
  if (item.next) return `${item.title} ${episodeTag(item.next.season, item.next.episode)}`;
  return item.title;
}

/** The continue-watching strip's status line. Reuses {@link statusFor}, the same helper the two lists share. */
export function continueWatchingStatus(state: SavedState): SavedStatus {
  return statusFor(state, state.continueWatching.length, "Stream something and it will show up here.");
}
