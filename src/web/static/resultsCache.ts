/**
 * The last completed search's results, kept just long enough that navigating
 * back from the player restores the list on screen instead of an empty one.
 *
 * WHY SESSIONSTORAGE, NOT LOCALSTORAGE. Same reasoning as `returnTo.ts` applied
 * to a second value: this should die with the tab, not outlive it. A result set
 * from three days ago is more likely wrong (seeders changed, a torrent died)
 * than useful, and `localStorage` would show it in a fresh session with no way
 * for the user to know it is stale.
 *
 * WHY NOT JUST THE URL. `route.ts` already puts the query/group in the address
 * bar, so returning re-runs the same search and (within `cachedSearch`'s five
 * minutes) gets it back fast. This exists on top of that, to paint the list
 * immediately from what was already on screen rather than wait on any request
 * at all, even a fast one.
 *
 * Cleared the moment a new search actually runs (`startSearch` in app.ts),
 * whether or not the stored snapshot ended up being used — a stale entry only
 * ever matters for the one boot that immediately follows the navigation that
 * wrote it.
 */
import type { PublicSearchSnapshot } from "../wire";

const KEY = "torlnk.resultsCache";

export interface StoredResults {
  query: string;
  group: string;
  snapshot: PublicSearchSnapshot;
}

function isSnapshot(value: unknown): value is PublicSearchSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.results) && typeof v.perSource === "object" && v.perSource !== null;
}

/**
 * A parsed value, trusted only once it looks like what this module wrote.
 * sessionStorage is user-writable and survives upgrades — the shape a past
 * version of this app saved is not guaranteed to match this version's type.
 */
export function parseStoredResults(raw: string | null): StoredResults | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.query !== "string" || typeof v.group !== "string") return null;
  if (!isSnapshot(v.snapshot)) return null;
  return { query: v.query, group: v.group, snapshot: v.snapshot };
}

/** Whether a stored snapshot is the right one to paint immediately for this route. */
export function matchesRoute(stored: StoredResults | null, query: string, group: string): stored is StoredResults {
  return stored !== null && stored.query === query.trim() && stored.group === group;
}

/** Remember the current search, so the next boot can paint it instantly. Fails soft. */
export function saveResultsSnapshot(state: StoredResults): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage blocked or full; the next boot just searches live, same as today */
  }
}

/** The remembered search, or null if there is none or it doesn't parse. */
export function loadResultsSnapshot(): StoredResults | null {
  try {
    return parseStoredResults(sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** Drop the remembered search. Called the moment a new one actually starts. */
export function clearResultsSnapshot(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked; nothing to clear */
  }
}
