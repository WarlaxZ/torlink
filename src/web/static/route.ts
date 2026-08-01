/**
 * What the dashboard's own URL means: which pane you are on, and what you
 * searched for.
 *
 * WHY THIS EXISTS. The player at `/play/:sid/:idx` is a separate document, so
 * leaving it — by the back link or by the browser's Back button — is a full page
 * load of `/`. With no state in the URL that boots to `emptyView()`: an empty
 * box and no results, having thrown away the search that got you there. Finish
 * an episode, want the next one, and the app makes you start again.
 *
 * The terminal has never had that failure. Its panes are `display` toggles on a
 * tree that is never unmounted (`src/ui/App.tsx`), so results survive playing
 * something. This is the browser catching up, and the URL is the only place a
 * separate document can leave a note for the one that replaces it.
 *
 * WHAT IS DELIBERATELY NOT IN HERE. No session id, no `?k=`, no `/play` state.
 * `index.html` used to carry a comment rejecting a router outright, on the
 * grounds that a bookmarked URL "would promise a restored search it cannot
 * deliver (the stream is not replayable)". That is right about STREAMS and this
 * module keeps it true: a stream capability is minted per session and dies with
 * it, so putting one in a bookmarkable URL would promise exactly the thing that
 * cannot be kept. It is wrong about SEARCHES — a query and a tab are replayable
 * by definition, `cachedSearch` (`src/sources/cache.ts`) even serves an
 * immediate return from memory — and that is the whole of what goes in the URL.
 *
 * Pure, and tested. `app.ts` is DOM wiring only (CLAUDE.md), and "what does this
 * URL mean" is a decision.
 */
import { ALL_TAB } from "./searchModel";

/** The four panes, mirroring `ViewName` in app.ts. */
const VIEWS = ["search", "recc", "saved", "queue"] as const;

export type RouteView = (typeof VIEWS)[number];

export interface RouteState {
  view: RouteView;
  /** The search box's contents. Blank is a real state: it is browse mode. */
  query: string;
  /** `ALL_TAB` or one of the server's group names, matching `SearchView.group`. */
  group: string;
}

/**
 * A fresh page: the search pane, nothing typed, every source.
 *
 * Search opens first for the reason app.ts gives — this is a torrent finder, and
 * a queue monitor is what it looks like when it opens on the queue.
 */
export const DEFAULT_ROUTE: RouteState = { view: "search", query: "", group: ALL_TAB };

function isView(value: string): value is RouteView {
  return (VIEWS as readonly string[]).includes(value);
}

/**
 * `?q=…&group=…&view=…` → a route.
 *
 * PARSED, NOT CAST, for the reason `parseLayout` and `parseGrouping` are: the
 * address bar is user-writable and survives upgrades, so `view=admin` has to
 * land on the search pane rather than on `undefined.hidden = false`.
 *
 * The GROUP is passed through as an arbitrary string rather than validated. The
 * real list arrives from `GET /api/sources` after boot and depends on the user's
 * config — whether adult sources are enabled changes it — so validating here
 * would need a second copy of the server's `SOURCE_GROUPS`, which is the
 * copy-then-drift this codebase has four recorded bugs from. An unrecognised
 * group simply matches no tab, which renders as All.
 */
export function routeFromSearch(search: string): RouteState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const rawView = params.get("view") ?? "";
  const group = params.get("group") ?? "";
  return {
    view: isView(rawView) ? rawView : DEFAULT_ROUTE.view,
    query: params.get("q") ?? "",
    group: group || DEFAULT_ROUTE.group,
  };
}

/**
 * A route → the `?…` to put in the address bar, or `""` for the default.
 *
 * Every field that is at its default is OMITTED, so a user who has done nothing
 * sees a clean `/` rather than `/?q=&group=All&view=search`. The parse above is
 * the inverse of that: an absent parameter means the default, so the round trip
 * holds.
 */
export function searchForRoute(state: RouteState): string {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set("q", state.query);
  if (state.group && state.group !== ALL_TAB) params.set("group", state.group);
  if (state.view !== DEFAULT_ROUTE.view) params.set("view", state.view);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * The full URL for a route on a given path — what `replaceState` is handed.
 *
 * It exists as its own function because of the magic link. `app.ts` reads
 * `#k=<token>` from the fragment at boot and then replaces state to strip it;
 * that call used to hardcode `location.pathname + location.search`, which was
 * harmless while the search string was always empty and is not now. The route
 * has to survive the strip and the token must not survive into history, and
 * composing the replacement here — where the fragment is not even an input —
 * is what makes those impossible to do in the wrong order.
 */
export function urlForRoute(pathname: string, state: RouteState): string {
  return `${pathname}${searchForRoute(state)}`;
}
