/**
 * Where the player page's back link goes.
 *
 * WHY IT IS NOT `document.referrer`. That was the first attempt and it cannot
 * work here: `player.html` sets `<meta name="referrer" content="no-referrer">`
 * on purpose, because this page's URL carries a stream capability in `?k=` and a
 * `Referer` would hand it to whatever a link on the page points at. So the
 * referrer is *always* empty, and a back link keyed on it would silently never
 * fire. The security header is right; the heuristic was wrong.
 *
 * So the dashboard leaves a note instead. `openPlayer` writes the URL it is
 * navigating away from into sessionStorage before it calls `location.assign`;
 * the player page reads it. sessionStorage is per TAB and `openPlayer` navigates
 * the same tab, so the note is there for exactly the journeys that made it and
 * absent for every other way of arriving — a bookmark, a link pasted onto a
 * phone, a fresh tab.
 *
 * That note is also better than a bare `history.back()`, because it says WHERE
 * as well as WHETHER: a player URL opened cold in a tab with unrelated history
 * would have `history.length > 1` and going back would leave the site entirely.
 *
 * The value is a same-origin path this app wrote, and it is used only as a
 * `href`/`history.back()` target — but sessionStorage is user-writable, so
 * {@link backTarget} validates it rather than trusting it.
 */
const RETURN_KEY = "torlnk.returnTo";

/** Remember where we are, just before navigating to the player. */
export function rememberReturn(url: string): void {
  try {
    sessionStorage.setItem(RETURN_KEY, url);
  } catch {
    /* storage blocked; the back link falls back to "/" */
  }
}

/** The remembered dashboard URL, or "". */
export function readReturn(): string {
  try {
    return sessionStorage.getItem(RETURN_KEY) ?? "";
  } catch {
    return "";
  }
}

export type BackTarget =
  /** Go back one entry — the dashboard is sitting there with its state intact. */
  | { kind: "back" }
  /** Navigate. Restores the search from the URL, at the cost of re-running it. */
  | { kind: "href"; href: string };

/**
 * What the back link should do.
 *
 * `back` whenever the dashboard is the previous entry, because that is strictly
 * better than navigating to the same URL: the browser may restore the page from
 * bfcache with its results still on screen, and even when it does not, one entry
 * back is what a user pressing Back expects to match.
 *
 * `href` otherwise, and the remembered URL is preferred over the markup's bare
 * `/` — someone who bookmarked a player page still gets the search that
 * originally led to it, if this tab happens to know it.
 *
 * VALIDATED, not trusted. `stored` comes from sessionStorage, which is
 * user-writable and survives upgrades, and it ends up in `location`. Only a
 * root-relative path is accepted: `//evil.example` and `javascript:…` are both
 * rejected, and so is anything that is not this app's own dashboard.
 */
export function backTarget(stored: string, historyLength: number, fallback: string): BackTarget {
  const safe = isDashboardPath(stored) ? stored : "";
  // history.length counts this entry, so >1 means there is something behind us.
  // Paired with the note, which is what says that something is the dashboard.
  if (safe && historyLength > 1) return { kind: "back" };
  return { kind: "href", href: safe || fallback };
}

/**
 * A path on this app's dashboard: `/`, optionally with a query.
 *
 * Deliberately strict. A leading `//` is a protocol-relative URL to another
 * host, which is the classic open-redirect shape, and anything with a scheme is
 * refused outright rather than parsed and inspected.
 */
function isDashboardPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  const path = value.split("?")[0];
  return path === "/" || path === "";
}
