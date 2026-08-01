import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTE,
  routeFromSearch,
  searchForRoute,
  urlForRoute,
  type RouteState,
} from "./route";
import { ALL_TAB } from "./searchModel";

describe("routeFromSearch", () => {
  it("reads the query, the tab and the view", () => {
    expect(routeFromSearch("?q=harrowgate&group=TV&view=search")).toEqual({
      view: "search",
      query: "harrowgate",
      group: "TV",
    });
  });

  it("works with or without the leading question mark", () => {
    expect(routeFromSearch("q=kepler")).toEqual({ ...DEFAULT_ROUTE, query: "kepler" });
    expect(routeFromSearch("?q=kepler")).toEqual({ ...DEFAULT_ROUTE, query: "kepler" });
  });

  it("is the default route for an empty search string", () => {
    expect(routeFromSearch("")).toEqual(DEFAULT_ROUTE);
    expect(routeFromSearch("?")).toEqual(DEFAULT_ROUTE);
  });

  /**
   * The URL bar is user-writable and survives upgrades, so every field is
   * PARSED rather than cast — the same rule `parseLayout`/`parseGrouping` apply
   * to localStorage. A hand-edited `view=admin` must land on the search pane,
   * not on `undefined.hidden = false`.
   */
  it("falls back rather than throwing on a view it does not know", () => {
    expect(routeFromSearch("?view=admin").view).toBe("search");
    expect(routeFromSearch("?view=").view).toBe("search");
  });

  /**
   * An unknown group is NOT validated against the source list here — that list
   * arrives from `GET /api/sources` after boot, and this module is pure. It is
   * passed through as a string and the tab strip simply never matches it, which
   * renders as the All tab. Validating it here would need a second copy of the
   * server's `SOURCE_GROUPS`, which is the copy-then-drift this codebase keeps
   * paying for.
   */
  it("passes an unrecognised group through as a string", () => {
    expect(routeFromSearch("?group=Nonsense").group).toBe("Nonsense");
  });

  it("decodes a query with spaces and punctuation", () => {
    expect(routeFromSearch("?q=tin%20rivers").query).toBe("tin rivers");
    expect(routeFromSearch("?q=tin+rivers").query).toBe("tin rivers");
  });

  it("ignores anything else already in the query string", () => {
    expect(routeFromSearch("?q=kepler&utm_source=x")).toEqual({
      ...DEFAULT_ROUTE,
      query: "kepler",
    });
  });
});

describe("searchForRoute", () => {
  it("is empty for the default route, so a fresh page keeps a clean URL", () => {
    expect(searchForRoute(DEFAULT_ROUTE)).toBe("");
  });

  it("omits the group when it is the All tab", () => {
    expect(searchForRoute({ view: "search", query: "kepler", group: ALL_TAB })).toBe("?q=kepler");
  });

  it("omits the view when it is the search pane", () => {
    expect(searchForRoute({ view: "search", query: "kepler", group: "TV" })).toBe(
      "?q=kepler&group=TV",
    );
  });

  it("writes the view when it is not the search pane", () => {
    expect(searchForRoute({ view: "saved", query: "", group: ALL_TAB })).toBe("?view=saved");
  });

  /**
   * A blank query is a real state — it is browse mode, the empty query every
   * source maps to its own top/latest endpoint — but it is also the default, so
   * it is not worth a `q=` in the URL when nothing else distinguishes it.
   */
  it("omits a blank query", () => {
    expect(searchForRoute({ view: "queue", query: "", group: ALL_TAB })).toBe("?view=queue");
    expect(searchForRoute({ view: "search", query: "   ", group: "TV" })).toBe("?group=TV");
  });

  it("round-trips every field", () => {
    const state: RouteState = { view: "recc", query: "tin rivers", group: "Movies" };
    expect(routeFromSearch(searchForRoute(state))).toEqual(state);
  });

  it("round-trips a query that needs encoding", () => {
    const state: RouteState = { view: "search", query: "a&b=c d", group: ALL_TAB };
    expect(searchForRoute(state)).not.toContain("&b=c");
    expect(routeFromSearch(searchForRoute(state))).toEqual(state);
  });
});

/**
 * The magic-link interaction, which is where this most plausibly breaks.
 *
 * `app.ts` reads `#k=<token>` at boot and then `replaceState`s to strip it. That
 * strip used to hardcode `location.pathname + location.search`, which was
 * harmless when the search string was always empty and is not now: the route has
 * to survive the strip, and the token must not survive into history. Composing
 * the replacement URL here — from the route, out of reach of the fragment —
 * is what makes the ordering impossible to get wrong at the call site.
 */
describe("urlForRoute", () => {
  it("keeps the route on the path", () => {
    expect(urlForRoute("/", { view: "search", query: "harrowgate", group: "TV" })).toBe(
      "/?q=harrowgate&group=TV",
    );
  });

  /**
   * The fragment is not an input, and that is the guarantee: whatever `#k=`
   * held cannot reach a URL this function returns, because it never sees it.
   */
  it("cannot carry a token into the URL it produces", () => {
    const out = urlForRoute("/", routeFromSearch("?q=kepler"));
    expect(out).not.toContain("#");
    expect(out).toBe("/?q=kepler");
  });

  it("leaves a bare path bare when there is no route to keep", () => {
    expect(urlForRoute("/", DEFAULT_ROUTE)).toBe("/");
  });

  /**
   * The search string is rewritten FROM THE ROUTE, never preserved from what
   * happened to be in the address bar. The route is the whole of what this
   * page's URL means, so a stray parameter someone pasted in does not survive.
   */
  it("drops a parameter that is not part of the route", () => {
    expect(urlForRoute("/", routeFromSearch("?q=kepler&utm_source=x"))).toBe("/?q=kepler");
  });
});
