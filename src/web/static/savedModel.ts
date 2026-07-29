// The saved pane's decisions: which request each button sends, what each list
// says when it is empty or broken, and how one row is labelled.
//
// Separate from app.ts for the reason every model in this directory is — there
// is no jsdom here, so anything with a decision in it has to be reachable
// without a DOM.
//
// Bundled for the browser: no node:* imports, direct or transitive.
import { formatBytes } from "./dashboard";
import type { LibraryRequest, PublicFavourite, WatchlistRequest } from "../wire";

export type { PublicFavourite, SavedResponse } from "../wire";

/** Everything the pane renders from. */
export interface SavedState {
  /** Saved search queries, most-recent first. The TUI's `watchlist`. */
  watchlist: string[];
  /** Favourited torrents, most-recent first. The TUI's `library`. */
  library: PublicFavourite[];
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
  return { watchlist: [], library: [], loaded: false, error: null };
}

/** The `POST /api/watchlist` body. Trimmed here so the box's stray spaces cannot create a second entry. */
export function watchlistBody(query: string, action: "toggle" | "remove"): WatchlistRequest {
  return { query: query.trim(), action };
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

export function watchlistStatus(state: SavedState): SavedStatus {
  return statusFor(state, state.watchlist.length, "Save a search to keep it here.");
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
  const watchlist = body && typeof body === "object" ? (body as { watchlist?: unknown }).watchlist : undefined;
  const library = body && typeof body === "object" ? (body as { library?: unknown }).library : undefined;
  return {
    ...state,
    watchlist: Array.isArray(watchlist) ? (watchlist as string[]) : [],
    library: Array.isArray(library) ? (library as PublicFavourite[]) : [],
    loaded: true,
    error: null,
  };
}

/**
 * Fold a `POST /api/watchlist` response into the state.
 *
 * `body` is `unknown`, not `WatchlistResponse`, because it is whatever came
 * back over the network — `null`, an array, an object whose `watchlist` field
 * is not an array — and this is the one place that guard belongs rather than
 * four copies of it in app.ts. On a malformed body the existing list is kept
 * rather than emptied — a request that came back garbled is not evidence the
 * list is now empty.
 */
export function applyWatchlistResponse(state: SavedState, body: unknown): SavedState {
  const list = body && typeof body === "object" ? (body as { watchlist?: unknown }).watchlist : undefined;
  return {
    ...state,
    watchlist: Array.isArray(list) ? (list as string[]) : state.watchlist,
    loaded: true,
    error: null,
  };
}

/** The same fold as {@link applyWatchlistResponse}, for `POST /api/library`. */
export function applyLibraryResponse(state: SavedState, body: unknown): SavedState {
  const list = body && typeof body === "object" ? (body as { library?: unknown }).library : undefined;
  return {
    ...state,
    library: Array.isArray(list) ? (list as PublicFavourite[]) : state.library,
    loaded: true,
    error: null,
  };
}

/**
 * The notice shown after a watchlist toggle.
 *
 * Reads `body.saved` rather than trusting the button's own optimistic label,
 * so a request that reached the server but flipped the opposite way (a race
 * with another tab, say) still reports what actually happened.
 */
export function watchlistToggleNotice(body: unknown): string {
  const saved = !!(body && typeof body === "object" && (body as { saved?: unknown }).saved === true);
  return saved ? "Saved to your watchlist." : "Removed from your watchlist.";
}

/** The same choice as {@link watchlistToggleNotice}, for a library toggle. */
export function libraryToggleNotice(body: unknown): string {
  const favourited = !!(
    body &&
    typeof body === "object" &&
    (body as { favourited?: unknown }).favourited === true
  );
  return favourited ? "Added to your library." : "Removed from your library.";
}
