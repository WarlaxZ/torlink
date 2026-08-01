/**
 * The last few things you searched for, and the magnet for a result.
 *
 * Two small pieces of parity with the terminal, which has had both since it
 * shipped and the browser had neither.
 *
 * RECENT SEARCHES. The TUI binds `↑` in its search box to walk back through
 * recent queries. The browser made you retype, or pre-emptively "save search" —
 * which is a different feature with a different meaning (a saved search is a
 * list you curate; a recent search is just where you have been). Shown as chips
 * rather than bound to a key, because the surface this matters most on is a
 * phone, which has no `↑`.
 *
 * Distinct from `#suggest`, the title-autocomplete combobox: that asks reccd
 * what a partial title might be and only appears once you have typed. These are
 * yours, they need no server, and they are there before you type anything.
 */

const RECENT_KEY = "torlnk.recent";

/**
 * How many to keep.
 *
 * Small on purpose. This is "where was I", not a history feature — a long list
 * would push the first result further down a phone screen, which is the
 * opposite of the point, and the chips are only useful while they can all be
 * read at a glance.
 */
export const RECENT_MAX = 6;

/**
 * Fold a query into the list, newest first.
 *
 * A PURE function over the list rather than a storage call, so the dedupe and
 * cap rules are testable without a DOM. Re-searching something already in the
 * list MOVES it to the front rather than adding a second copy — otherwise a
 * query you run every day fills the whole strip with itself.
 *
 * A blank query is browse mode, which is a real search but not one worth
 * remembering: there is nothing to put on a chip and nothing to go back to.
 */
export function foldRecent(list: readonly string[], query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [...list];
  // Case-insensitive, because "Kestrel" and "kestrel" are the same search to
  // every source and two chips saying so would be noise. The NEW spelling wins:
  // it is what the user just typed.
  const lower = trimmed.toLowerCase();
  return [trimmed, ...list.filter((q) => q.toLowerCase() !== lower)].slice(0, RECENT_MAX);
}

/**
 * The stored list, or empty.
 *
 * PARSED, not cast, for the reason `parseLayout` is: localStorage is
 * user-writable and survives upgrades. Anything that is not an array of
 * non-empty strings is discarded rather than rendered — a chip built from a
 * number or an object would be `[object Object]` at best.
 */
export function parseRecent(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .map((q) => q.trim())
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function readRecent(): string[] {
  try {
    return parseRecent(localStorage.getItem(RECENT_KEY));
  } catch {
    // Storage blocked (Safari private mode, a hardened profile). No history is
    // survivable; a dead page is not.
    return [];
  }
}

export function writeRecent(list: readonly string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* not remembering is survivable */
  }
}

/**
 * A magnet link for a result, rebuilt from its info hash.
 *
 * THE WIRE DOES NOT CARRY MAGNETS, deliberately — `PublicFavourite` documents
 * why: playing goes through `POST /api/stream { infoHash, name }`, which
 * rebuilds the magnet server-side with the default tracker list, so shipping
 * one would be a few hundred bytes of tracker URLs per row to no end. That
 * reasoning holds, and it is why this builds the SHORT form rather than asking
 * for the server's.
 *
 * A hash-and-name magnet is enough for every client that matters: trackers are
 * a hint, and any modern client finds peers for a known info hash through the
 * DHT. The terminal's `y` key copies the same thing.
 */
export function magnetFor(infoHash: string, name: string): string {
  const params = new URLSearchParams({ dn: name });
  return `magnet:?xt=urn:btih:${encodeURIComponent(infoHash)}&${params.toString()}`;
}
