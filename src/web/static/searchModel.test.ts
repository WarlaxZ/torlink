import { describe, expect, it } from "vitest";
import {
  addBody,
  addPlan,
  ALL_TAB,
  categoryTabs,
  dashRowForPlay,
  emptyView,
  erroredSources,
  modeForQuery,
  parseLayout,
  previewApplies,
  progressLabel,
  reportsHealthLookup,
  resultMeta,
  rowForPlay,
  searchStatus,
  searchUrl,
  sourceLabel,
  statusLineHidden,
  tabClickPlan,
  visibleResults,
  type PublicSearchResult,
  type PublicSearchSnapshot,
  type SearchView,
  type SourcesResponse,
} from "./searchModel";
import { isPlayable } from "./streamFlow";

function result(over: Partial<PublicSearchResult> = {}): PublicSearchResult {
  return {
    infoHash: "a".repeat(40),
    name: "Sintel.2010.1080p.BluRay.x264-GROUP",
    sizeBytes: 1024 * 1024 * 1024,
    seeders: 10,
    leechers: 2,
    source: "tpb",
    sources: ["tpb"],
    ...over,
  };
}

function snapshot(results: PublicSearchResult[], over: Partial<PublicSearchSnapshot> = {}): PublicSearchSnapshot {
  return {
    results,
    perSource: {},
    done: results.length,
    total: 3,
    ...over,
  };
}

function view(over: Partial<SearchView> = {}): SearchView {
  return { ...emptyView(), query: "sintel", mode: "search", ...over };
}

/** A view mid-browse: the blank query the TUI sends on an empty submit. */
function browsing(over: Partial<SearchView> = {}): SearchView {
  return { ...emptyView(), query: "", mode: "browse", ...over };
}

const ALWAYS_HEALTHY = (): boolean => true;

const sourcesResponse = (over: Partial<SourcesResponse> = {}): SourcesResponse => ({
  groups: [
    { group: "Games", sourceIds: ["fitgirl"] },
    { group: "Movies", sourceIds: ["tpb"] },
    { group: "TV", sourceIds: ["eztv"] },
  ],
  sources: [
    {
      id: "tpb",
      label: "The Pirate Bay",
      groups: ["Movies"],
      adult: false,
      homepage: "https://example.invalid",
      reportsHealth: true,
      enabled: true,
      fails: 0,
      benchedUntil: null,
    },
    {
      id: "nyaa",
      label: "Nyaa",
      groups: ["Anime"],
      adult: false,
      homepage: "https://example.invalid",
      reportsHealth: false,
      enabled: true,
      fails: 0,
      benchedUntil: null,
    },
  ],
  adultEnabled: false,
  debridConfigured: false,
  omdbConfigured: false,
  ...over,
});

describe("categoryTabs", () => {
  it("puts All first and then the server's groups, in order", () => {
    expect(categoryTabs(sourcesResponse())).toEqual([ALL_TAB, "Games", "Movies", "TV"]);
  });

  it("offers no Porn tab when the server did not send that group", () => {
    // MUTATION GUARD (adult sources appearing when the category is off). The
    // server omits the group entirely from /api/sources when adultEnabled is
    // false; a browser that added a tab of its own would offer a category the
    // server refuses to search.
    expect(categoryTabs(sourcesResponse())).not.toContain("Porn");
  });

  it("offers a Porn tab when the server does send it", () => {
    const tabs = categoryTabs(
      sourcesResponse({
        adultEnabled: true,
        groups: [
          { group: "Movies", sourceIds: ["tpb"] },
          { group: "Porn", sourceIds: ["xxx"] },
        ],
      }),
    );
    expect(tabs).toEqual([ALL_TAB, "Movies", "Porn"]);
  });

  it("degrades to just All when /api/sources never answered", () => {
    expect(categoryTabs(null)).toEqual([ALL_TAB]);
  });
});

describe("reportsHealthLookup", () => {
  it("reports what the server said, per source", () => {
    const lookup = reportsHealthLookup(sourcesResponse());
    expect(lookup("tpb")).toBe(true);
    expect(lookup("nyaa")).toBe(false);
  });

  it("treats an unknown source as not reporting health", () => {
    // So its zero-seeder rows survive the alive-only filter instead of an
    // unrecognised id silently emptying the list.
    expect(reportsHealthLookup(sourcesResponse())("who-dis")).toBe(false);
    expect(reportsHealthLookup(null)("tpb")).toBe(false);
  });
});

describe("visibleResults", () => {
  it("preserves the server's order by default", () => {
    // MUTATION GUARD (the browser re-sorting into a different default order).
    // core/search.ts orders by seeders then recency and the TUI leaves it
    // alone. This list is deliberately NOT in any obvious order.
    const results = [
      result({ infoHash: "1", seeders: 3, sizeBytes: 900 }),
      result({ infoHash: "2", seeders: 50, sizeBytes: 100 }),
      result({ infoHash: "3", seeders: 7, sizeBytes: 500 }),
    ];
    const shown = visibleResults(view({ snapshot: snapshot(results) }), ALWAYS_HEALTHY);
    expect(shown.map((r) => r.infoHash)).toEqual(["1", "2", "3"]);
  });

  it("applies the chosen sort, and only when one is chosen", () => {
    const results = [
      result({ infoHash: "1", seeders: 3 }),
      result({ infoHash: "2", seeders: 50 }),
      result({ infoHash: "3", seeders: 7 }),
    ];
    const shown = visibleResults(
      view({ snapshot: snapshot(results), sort: { field: "seeders", dir: "desc" } }),
      ALWAYS_HEALTHY,
    );
    expect(shown.map((r) => r.infoHash)).toEqual(["2", "3", "1"]);
  });

  it("hides zero-seeder rows only from sources that report health", () => {
    const results = [
      result({ infoHash: "dead", seeders: 0, source: "tpb" }),
      result({ infoHash: "unknown", seeders: 0, source: "nyaa" }),
      result({ infoHash: "alive", seeders: 4, source: "tpb" }),
    ];
    const shown = visibleResults(
      view({ snapshot: snapshot(results), hideDead: true }),
      reportsHealthLookup(sourcesResponse()),
    );
    expect(shown.map((r) => r.infoHash)).toEqual(["unknown", "alive"]);
  });

  it("applies the text filter", () => {
    const results = [result({ infoHash: "1", name: "Sintel 2010" }), result({ infoHash: "2", name: "Big Buck Bunny" })];
    const shown = visibleResults(
      view({ snapshot: snapshot(results), textFilter: "bunny" }),
      ALWAYS_HEALTHY,
    );
    expect(shown.map((r) => r.infoHash)).toEqual(["2"]);
  });

  it("is empty before the first frame", () => {
    expect(visibleResults(emptyView(), ALWAYS_HEALTHY)).toEqual([]);
  });
});

describe("searchStatus", () => {
  it("counts sources while a search is running", () => {
    const v = view({ running: true, snapshot: snapshot([], { done: 12, total: 23 }) });
    expect(searchStatus(v, 0).text).toBe("Searching 12/23 sources");
    expect(searchStatus(v, 5).text).toBe("searching… 12/23 sources");
  });

  it("distinguishes every source failing from nobody having it", () => {
    const down = {
      perSource: {
        a: { loading: false, error: "timed out", code: "timed out", count: 0 },
        b: { loading: false, error: "HTTP 503", code: "HTTP 503", count: 0 },
      },
      total: 2,
      done: 2,
    };
    const failed = searchStatus(view({ snapshot: snapshot([], down) }), 0);
    expect(failed.text).toBe("Couldn't reach any source. They may be down.");
    expect(failed.tone).toBe("error");

    const nothing = searchStatus(view({ snapshot: snapshot([], { total: 2, done: 2 }) }), 0);
    expect(nothing.text).toBe("No results for “sintel”.");
    expect(nothing.tone).toBe("dim");
  });

  it("blames the filters when they are what emptied the list", () => {
    const v = view({ snapshot: snapshot([result()], { total: 2, done: 2 }), textFilter: "zzz" });
    expect(searchStatus(v, 0).text).toBe("Nothing matches those filters.");
  });

  it("counts results and notes partial outages", () => {
    const v = view({
      snapshot: snapshot([result()], {
        total: 3,
        done: 3,
        perSource: { a: { loading: false, error: "timed out", code: "timed out", count: 0 } },
      }),
    });
    expect(searchStatus(v, 4).text).toBe("4 results · 1 source down");
  });

  it("counts sources while browsing, without calling it a search", () => {
    const v = browsing({ running: true, snapshot: snapshot([], { done: 12, total: 23 }) });
    expect(searchStatus(v, 0).text).toBe("Loading 12/23 sources");
    expect(searchStatus(v, 5).text).toBe("loading… 12/23 sources");
  });

  it("says nothing is new rather than quoting an empty query", () => {
    const v = browsing({ snapshot: snapshot([], { total: 2, done: 2 }) });
    expect(searchStatus(v, 0).text).toBe("Nothing new right now.");
    expect(searchStatus(v, 0).tone).toBe("dim");
  });

  it("labels browse results as the newest across all sources", () => {
    const v = browsing({ snapshot: snapshot([result()], { total: 3, done: 3 }) });
    expect(searchStatus(v, 4).text).toBe("4 results · newest across all sources");
  });

  it("composes the outage note and the browse tail, in that order", () => {
    const v = browsing({
      snapshot: snapshot([result()], {
        total: 3,
        done: 3,
        perSource: { a: { loading: false, error: "timed out", code: "timed out", count: 0 } },
      }),
    });
    expect(searchStatus(v, 4).text).toBe("4 results · 1 source down · newest across all sources");
  });

  // The mode-independent branches must keep winning over the browse lines:
  // "every source is down" and "your filters did this" are still the truth.
  it("keeps the outage and filter branches while browsing", () => {
    const down = {
      perSource: {
        a: { loading: false, error: "timed out", code: "timed out", count: 0 },
        b: { loading: false, error: "HTTP 503", code: "HTTP 503", count: 0 },
      },
      total: 2,
      done: 2,
    };
    const failed = searchStatus(browsing({ snapshot: snapshot([], down) }), 0);
    expect(failed.text).toBe("Couldn't reach any source. They may be down.");
    expect(failed.tone).toBe("error");

    const filtered = browsing({ snapshot: snapshot([result()], { total: 2, done: 2 }), textFilter: "zzz" });
    expect(searchStatus(filtered, 0).text).toBe("Nothing matches those filters.");
  });

  it("still shows the idle line before anything is submitted", () => {
    expect(searchStatus(emptyView(), 0).text).toBe(
      "Search across every enabled source — or submit a blank box to browse.",
    );
  });

  it("does not blame an active filter for an upstream that returned nothing while browsing", () => {
    const v = browsing({ hideDead: true, snapshot: snapshot([], { total: 2, done: 2 }) });
    expect(searchStatus(v, 0).text).toBe("Nothing new right now.");
  });

  it("does not blame an active filter for an upstream that returned nothing while searching", () => {
    const v = view({ hideDead: true, snapshot: snapshot([], { total: 2, done: 2 }) });
    expect(searchStatus(v, 0).text).toBe("No results for “sintel”.");
  });

  it("uses the singular for exactly one browse result", () => {
    const v = browsing({ snapshot: snapshot([result()], { total: 3, done: 3 }) });
    expect(searchStatus(v, 1).text).toBe("1 result · newest across all sources");
  });
});

describe("statusLineHidden", () => {
  it("hides the line for a settled search with rows — the count is redundant with the rows themselves", () => {
    const v = view({ snapshot: snapshot([result()], { total: 1, done: 1 }) });
    expect(statusLineHidden(v, 1)).toBe(true);
  });

  it("keeps the line up while a search is still running, even with rows already in", () => {
    const v = view({ running: true, snapshot: snapshot([result()], { total: 3, done: 1 }) });
    expect(statusLineHidden(v, 1)).toBe(false);
  });

  it("keeps the line up for a settled search with no rows — it's the only message the user gets", () => {
    const v = view({ snapshot: snapshot([], { total: 2, done: 2 }) });
    expect(statusLineHidden(v, 0)).toBe(false);
  });

  it("keeps the line up for a settled browse with rows — it names what the rows are", () => {
    const v = browsing({ snapshot: snapshot([result()], { total: 3, done: 3 }) });
    expect(statusLineHidden(v, 1)).toBe(false);
  });

  it("keeps the line up for a settled browse with no rows", () => {
    const v = browsing({ snapshot: snapshot([], { total: 2, done: 2 }) });
    expect(statusLineHidden(v, 0)).toBe(false);
  });

  it("keeps the line up before anything has been submitted", () => {
    expect(statusLineHidden(emptyView(), 0)).toBe(false);
  });
});

describe("modeForQuery", () => {
  it("is search for real text", () => {
    expect(modeForQuery("sintel")).toBe("search");
  });

  it("is browse for an empty string", () => {
    expect(modeForQuery("")).toBe("browse");
  });

  it("is browse for whitespace-only text, matching the server's trim", () => {
    expect(modeForQuery("   ")).toBe("browse");
    expect(modeForQuery("\t\n")).toBe("browse");
  });
});

describe("progressLabel / erroredSources", () => {
  it("reads the fraction the TUI shows", () => {
    expect(progressLabel(snapshot([], { done: 8, total: 23 }))).toBe("8/23 sources");
    expect(progressLabel(null)).toBe("");
  });

  it("lists only the sources that actually errored", () => {
    const snap = snapshot([], {
      perSource: {
        ok: { loading: false, error: null, code: null, count: 4 },
        bad: { loading: false, error: "timed out", code: "timed out", count: 0 },
      },
    });
    expect(erroredSources(snap)).toEqual(["bad"]);
  });
});

describe("searchUrl", () => {
  it("carries the query, the group and the token", () => {
    expect(searchUrl("the matrix", "Movies", "sekrit")).toBe(
      "/api/search?q=the+matrix&group=Movies&k=sekrit",
    );
  });

  it("omits ?k= entirely on a tokenless server", () => {
    expect(searchUrl("x", "All", "")).toBe("/api/search?q=x&group=All");
  });

  it("sends q= for a browse, so the server can tell blank from absent", () => {
    expect(searchUrl("", "All", "")).toBe("/api/search?q=&group=All");
  });
});

describe("resultMeta / sourceLabel", () => {
  it("formats size, swarm and source", () => {
    expect(resultMeta(result(), sourcesResponse())).toBe(
      "1.00 GB · 10 seeders · 2 leechers · The Pirate Bay",
    );
  });

  it("says unknown rather than printing a misleading zero", () => {
    const meta = resultMeta(result({ sizeBytes: 0, seeders: 0, leechers: 0 }), sourcesResponse());
    expect(meta).toBe("size unknown · swarm unknown · The Pirate Bay");
  });

  it("falls back to the raw source id when /api/sources is unavailable", () => {
    expect(sourceLabel(null, "tpb")).toBe("tpb");
  });
});

describe("dashRowForPlay", () => {
  it("builds a playable row from just an id and a name — rowForPlay's own shape", () => {
    // The one definition rowForPlay and the library row in app.ts both call.
    const row = dashRowForPlay("beef", "Sintel 2010");
    expect(row.id).toBe("beef");
    expect(row.name).toBe("Sintel 2010");
    expect(row.status).toBe("queued");
    expect(isPlayable(row)).toBe(true);
  });
});

describe("rowForPlay", () => {
  it("carries the result's name", () => {
    // MUTATION GUARD (runPlay not receiving the name). runPlay puts row.name in
    // the Real-Debrid prompt, the progress line, the picker heading and the
    // stream session — a row named after its hash works end to end and shows
    // the user 40 hex characters at every one of those points.
    const row = rowForPlay(result({ infoHash: "beef", name: "Sintel 2010" }));
    expect(row.name).toBe("Sintel 2010");
    expect(row.name).not.toBe(row.id);
    expect(row.id).toBe("beef");
  });

  it("produces a row Play is offered on", () => {
    expect(isPlayable(rowForPlay(result()))).toBe(true);
  });
});

describe("addPlan", () => {
  it("adds straight away when Real-Debrid is not configured", () => {
    expect(addPlan("p2p", false, "Sintel")).toEqual({ kind: "add", via: "p2p" });
  });

  it("prompts before a P2P add when Real-Debrid is configured", () => {
    const plan = addPlan("p2p", true, "Sintel");
    expect(plan.kind).toBe("confirm");
    expect(plan.via).toBe("p2p");
    if (plan.kind !== "confirm") throw new Error("unreachable");
    // The consequence is spelled out. "Continue anyway?" is not informed
    // consent when the thing consented to is publishing your IP.
    expect(plan.message).toContain("IP address will be visible");
  });

  it("never prompts for an explicit Real-Debrid add", () => {
    expect(addPlan("debrid", true, "Sintel")).toEqual({ kind: "add", via: "debrid" });
  });

  it("clips a very long release name out of the prompt", () => {
    const plan = addPlan("p2p", true, "x".repeat(200));
    if (plan.kind !== "confirm") throw new Error("unreachable");
    expect(plan.message).toContain("…");
    expect(plan.message).not.toContain("x".repeat(70));
  });
});

describe("addBody", () => {
  it("sends the name, not just the hash", () => {
    // MUTATION GUARD (the add path losing the name). Search results carry no
    // magnet, so the server has no `dn` to read a name out of: drop this field
    // and every browser add is a queue row called "3f2a1c…".
    const body = addBody(result({ infoHash: "3f2a", name: "Sintel 2010" }), "p2p");
    expect(body).toEqual({ infoHash: "3f2a", name: "Sintel 2010", via: "p2p", sizeBytes: 1073741824 });
    expect(body.name).not.toBe(body.infoHash);
  });

  it("omits an unknown size rather than sending zero", () => {
    expect(addBody(result({ sizeBytes: 0 }), "debrid")).not.toHaveProperty("sizeBytes");
  });

  it("carries no magnet — that field is not on the wire at all", () => {
    expect(addBody(result(), "p2p")).not.toHaveProperty("magnet");
  });
});

describe("previewApplies", () => {
  it("covers the video tabs and All, like the TUI's preview pane", () => {
    expect(previewApplies(ALL_TAB)).toBe(true);
    expect(previewApplies("Movies")).toBe(true);
    expect(previewApplies("TV")).toBe(true);
    expect(previewApplies("Anime")).toBe(true);
  });

  it("does not spend OMDb lookups on games, music or books", () => {
    expect(previewApplies("Games")).toBe(false);
    expect(previewApplies("Music")).toBe(false);
    expect(previewApplies("Books")).toBe(false);
  });
});

describe("parseLayout", () => {
  it("reads the two layouts", () => {
    expect(parseLayout("list")).toBe("list");
    expect(parseLayout("grid")).toBe("grid");
  });

  it("falls back to list for anything else", () => {
    // The value comes out of localStorage, which is user-writable and survives
    // upgrades — a stale or hand-edited entry must degrade to the default
    // rather than render nothing. List is the default because it is the layout
    // that works without an OMDb key.
    expect(parseLayout(null)).toBe("list");
    expect(parseLayout("")).toBe("list");
    expect(parseLayout("gallery")).toBe("list");
  });
});

describe("tabClickPlan", () => {
  it("returns the box's current value when browsing (an empty box)", () => {
    // Opening the page and clicking "Movies" with an empty search box used to
    // call renderResults() while idle, which re-rendered an empty list. The
    // fix is returning { action: "run", query: boxValue } here rather than
    // deciding "" for anyone, which causes startSearch("") → modeForQuery("")
    // → "browse" one layer up.
    expect(tabClickPlan(emptyView(), "Movies", "")).toEqual({
      action: "run",
      query: "",
    });
  });

  it("returns the box's current value when it holds typed-but-unsubmitted text", () => {
    // User types "dune" without pressing Enter, then clicks a different tab.
    // tabClickPlan hands back the box's own value rather than "", so a
    // handler that renders plan.query keeps it on screen.
    expect(tabClickPlan(emptyView(), "Movies", "dune")).toEqual({
      action: "run",
      query: "dune",
    });
  });

  it("returns the box's value on a group change regardless of the view's mode or query", () => {
    // tabClickPlan only compares view.group to the clicked group — it reads
    // neither view.mode nor view.query, so the same plan comes back whether
    // the view was mid-search or mid-browse; the box's own value is what gets
    // used for the run.
    const searching: SearchView = { ...emptyView(), query: "sintel", mode: "search", group: "All" };
    expect(tabClickPlan(searching, "Movies", "sintel")).toEqual({
      action: "run",
      query: "sintel",
    });
    const browsing: SearchView = { ...emptyView(), query: "", mode: "browse", group: "All" };
    expect(tabClickPlan(browsing, "TV", "")).toEqual({
      action: "run",
      query: "",
    });
  });

  it("ignores a click on the already-selected tab", () => {
    // Clicking the current tab restarts a 23-source fan-out. Don't do that.
    const view: SearchView = { ...emptyView(), mode: "search", query: "dune", group: "Movies" };
    expect(tabClickPlan(view, "Movies", "dune")).toEqual({ action: "ignore" });
    expect(tabClickPlan(emptyView(), "All", "")).toEqual({ action: "ignore" });
  });
});
