import { describe, expect, it } from "vitest";
import type { PublicStreamHistoryItem } from "../wire";
import {
  addBody,
  addPlan,
  ALL_TAB,
  cachedTag,
  categoryTabs,
  dashRowForPlay,
  debridAddedNotice,
  debridAddLabel,
  debridProviderLabel,
  emptyView,
  erroredSources,
  exportBody,
  exportedNotice,
  modeForQuery,
  parseGrouping,
  parseLayout,
  previewApplies,
  progressLabel,
  reportsHealthLookup,
  resultMeta,
  resultRowPlan,
  rowForPlay,
  searchStatus,
  searchUrl,
  sourceLabel,
  statusLineHidden,
  tabClickPlan,
  visibleGroups,
  visibleResults,
  type PublicSearchResult,
  type PublicSearchSnapshot,
  type SearchView,
  type SourcesResponse,
  positionLookup,
} from "./searchModel";
import { isPlayable } from "./streamFlow";

function result(over: Partial<PublicSearchResult> = {}): PublicSearchResult {
  return {
    infoHash: "a".repeat(40),
    name: "Kestrel.2010.1080p.BluRay.x264-GROUP",
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
  return { ...emptyView(), query: "kestrel", mode: "search", ...over };
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
  cloudflareAccessEnforced: false,
  debridProvider: null,
  debridCachedCheck: false,
  omdbConfigured: false,
  reccConfigured: false,
  reccAccount: null,
  preferences: { maxResolution: null, require: [], exclude: [] },
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
    const results = [result({ infoHash: "1", name: "Kestrel 2010" }), result({ infoHash: "2", name: "Copper Kettle Run" })];
    const shown = visibleResults(
      view({ snapshot: snapshot(results), textFilter: "kettle" }),
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
    expect(nothing.text).toBe("No results for “kestrel”.");
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
    expect(searchStatus(v, 0).text).toBe("No results for “kestrel”.");
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
    expect(modeForQuery("kestrel")).toBe("search");
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
    expect(searchUrl("ashfall", "Movies", "sekrit")).toBe(
      "/api/search?q=ashfall&group=Movies&k=sekrit",
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
    const row = dashRowForPlay("beef", "Kestrel 2010");
    expect(row.id).toBe("beef");
    expect(row.name).toBe("Kestrel 2010");
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
    const row = rowForPlay(result({ infoHash: "beef", name: "Kestrel 2010" }));
    expect(row.name).toBe("Kestrel 2010");
    expect(row.name).not.toBe(row.id);
    expect(row.id).toBe("beef");
  });

  it("produces a row Play is offered on", () => {
    expect(isPlayable(rowForPlay(result()))).toBe(true);
  });
});

describe("addPlan", () => {
  it("adds straight away when Real-Debrid is not configured", () => {
    expect(addPlan("p2p", false, "Kestrel", undefined)).toEqual({ kind: "add", via: "p2p" });
  });

  it("prompts before a P2P add when Real-Debrid is configured", () => {
    const plan = addPlan("p2p", true, "Kestrel", "realdebrid");
    expect(plan.kind).toBe("confirm");
    expect(plan.via).toBe("p2p");
    if (plan.kind !== "confirm") throw new Error("unreachable");
    // The consequence is spelled out. "Continue anyway?" is not informed
    // consent when the thing consented to is publishing your IP.
    expect(plan.message).toContain("IP address will be visible");
    expect(plan.message).toContain("Real-Debrid is configured");
    // The prompt must point at the button the user is actually looking at —
    // "add via RD", not the full "Real-Debrid" name.
    expect(plan.message).toContain("add via RD");
  });

  it("never prompts for an explicit Real-Debrid add", () => {
    expect(addPlan("debrid", true, "Kestrel", "realdebrid")).toEqual({ kind: "add", via: "debrid" });
  });

  it("clips a very long release name out of the prompt", () => {
    const plan = addPlan("p2p", true, "x".repeat(200), "realdebrid");
    if (plan.kind !== "confirm") throw new Error("unreachable");
    expect(plan.message).toContain("…");
    expect(plan.message).not.toContain("x".repeat(70));
  });
});

describe("debrid copy", () => {
  it("labels the button after the active provider", () => {
    expect(debridAddLabel("realdebrid")).toBe("add via RD");
    expect(debridAddLabel("torbox")).toBe("add via TorBox");
  });

  it("names the provider in the added notice", () => {
    expect(debridAddedNotice("torbox")).toBe("Added via TorBox.");
    expect(debridAddedNotice("realdebrid")).toBe("Added via Real-Debrid.");
  });

  it("names the provider in the swarm-exposure prompt", () => {
    const plan = addPlan("p2p", true, "Kestrel.2010.1080p.BluRay.x264", "torbox");
    expect(plan.kind).toBe("confirm");
    expect(plan.kind === "confirm" && plan.message).toContain("TorBox");
  });

  it("still never prompts for an explicit debrid add", () => {
    expect(addPlan("debrid", true, "Ashfall.1999.1080p", "torbox")).toEqual({ kind: "add", via: "debrid" });
  });

  it("still never prompts when no debrid is configured", () => {
    expect(addPlan("p2p", false, "Ashfall.1999.1080p", undefined)).toEqual({ kind: "add", via: "p2p" });
  });

  // This is the assertion that makes the two-sources-for-one-fact bug
  // impossible to reintroduce: the prompt's quoted button text must equal
  // debridAddLabel(provider) for BOTH providers, not just coincidentally
  // match one of them.
  it("names the exact button text on screen, for every provider", () => {
    for (const provider of ["realdebrid", "torbox"] as const) {
      const plan = addPlan("p2p", true, "Kestrel.2010.1080p.BluRay.x264", provider);
      if (plan.kind !== "confirm") throw new Error("unreachable");
      expect(plan.message).toContain(`“${debridAddLabel(provider)}”`);
      expect(plan.message).toContain(debridProviderLabel(provider));
    }
  });

  it("provides the full display label for wiring into app.ts", () => {
    expect(debridProviderLabel("realdebrid")).toBe("Real-Debrid");
    expect(debridProviderLabel("torbox")).toBe("TorBox");
  });
});

describe("addBody", () => {
  it("sends the name, not just the hash", () => {
    // MUTATION GUARD (the add path losing the name). Search results carry no
    // magnet, so the server has no `dn` to read a name out of: drop this field
    // and every browser add is a queue row called "3f2a1c…".
    const body = addBody(result({ infoHash: "3f2a", name: "Kestrel 2010" }), "p2p");
    expect(body).toEqual({ infoHash: "3f2a", name: "Kestrel 2010", via: "p2p", sizeBytes: 1073741824 });
    expect(body.name).not.toBe(body.infoHash);
  });

  it("omits an unknown size rather than sending zero", () => {
    expect(addBody(result({ sizeBytes: 0 }), "debrid")).not.toHaveProperty("sizeBytes");
  });

  it("carries no magnet — that field is not on the wire at all", () => {
    expect(addBody(result(), "p2p")).not.toHaveProperty("magnet");
  });
});

describe("exportBody", () => {
  it("sends the name, not just the hash — the name IS the exported filename", () => {
    // MUTATION GUARD, and a sharper one than addBody's: drop the name here and
    // the user does not get a badly-labelled queue row, they get a file on disk
    // called "3f2a….torrent".
    const body = exportBody(result({ infoHash: "3f2a", name: "Kestrel 2010" }));
    expect(body).toEqual({ infoHash: "3f2a", name: "Kestrel 2010" });
    expect(body.name).not.toBe(body.infoHash);
  });

  it("carries no magnet — a search hit has none on the wire", () => {
    expect(exportBody(result())).not.toHaveProperty("magnet");
  });
});

describe("exportedNotice", () => {
  it("names the folder the file landed in, since the disk is the server's", () => {
    // On a LAN dashboard the export is on a machine the user may not be sitting
    // at. "Exported." alone gives them nothing to go looking with.
    expect(exportedNotice("/downloads/Kestrel 2010.torrent")).toContain("/downloads");
  });

  it("survives a Windows path", () => {
    expect(exportedNotice("C:\\Users\\a\\Downloads\\Kestrel.torrent")).toContain("Kestrel.torrent");
  });

  it("falls back to the bare path when there is no separator to split on", () => {
    expect(exportedNotice("Kestrel.torrent")).toContain("Kestrel.torrent");
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
    // User types "tin rivers" without pressing Enter, then clicks a different tab.
    // tabClickPlan hands back the box's own value rather than "", so a
    // handler that renders plan.query keeps it on screen.
    expect(tabClickPlan(emptyView(), "Movies", "tin rivers")).toEqual({
      action: "run",
      query: "tin rivers",
    });
  });

  it("returns the box's value on a group change regardless of the view's mode or query", () => {
    // tabClickPlan only compares view.group to the clicked group — it reads
    // neither view.mode nor view.query, so the same plan comes back whether
    // the view was mid-search or mid-browse; the box's own value is what gets
    // used for the run.
    const searching: SearchView = { ...emptyView(), query: "kestrel", mode: "search", group: "All" };
    expect(tabClickPlan(searching, "Movies", "kestrel")).toEqual({
      action: "run",
      query: "kestrel",
    });
    const browsing: SearchView = { ...emptyView(), query: "", mode: "browse", group: "All" };
    expect(tabClickPlan(browsing, "TV", "")).toEqual({
      action: "run",
      query: "",
    });
  });

  it("ignores a click on the already-selected tab", () => {
    // Clicking the current tab restarts a 23-source fan-out. Don't do that.
    const view: SearchView = { ...emptyView(), mode: "search", query: "tin rivers", group: "Movies" };
    expect(tabClickPlan(view, "Movies", "tin rivers")).toEqual({ action: "ignore" });
    expect(tabClickPlan(emptyView(), "All", "")).toEqual({ action: "ignore" });
  });
});

describe("cachedTag", () => {
  it("marks a cached result when the provider can check", () => {
    expect(cachedTag("aabb", new Set(["aabb"]), true)).toBe("cached");
  });

  it("shows nothing for an uncached result — absence is not a claim", () => {
    expect(cachedTag("aabb", new Set(["ccdd"]), true)).toBeNull();
  });

  it("shows nothing at all when the provider cannot check", () => {
    // Real-Debrid withdrew its instant-availability endpoint; an "unknown"
    // state would read as "not cached", which is a claim we cannot make.
    expect(cachedTag("aabb", new Set(["aabb"]), false)).toBeNull();
  });

  it("matches case-insensitively", () => {
    expect(cachedTag("AABB", new Set(["aabb"]), true)).toBe("cached");
  });
});

describe("resultRowPlan", () => {
  const health = () => true;
  const grouped = () =>
    view({
      snapshot: snapshot([
        result({ name: "Kestrel.2010.1080p.BluRay.x264", infoHash: "a".repeat(40) }),
        result({ name: "Kestrel.2010.2160p.WEB-DL", infoHash: "b".repeat(40) }),
        result({ name: "Ashfall.1999.1080p", infoHash: "c".repeat(40) }),
      ]),
    });

  it("collapses the duplicate title and leaves the singleton as a plain row", () => {
    const rows = resultRowPlan(grouped(), health, new Set());
    expect(rows.map((r) => r.kind)).toEqual(["group", "release"]);
  });

  it("returns one plain release row per result when grouping is off", () => {
    const rows = resultRowPlan(view({ ...grouped(), grouped: false }), health, new Set());
    expect(rows.map((r) => r.kind)).toEqual(["release", "release", "release"]);
  });

  it("keys an ungrouped row on the info hash, so focus and selection can find it", () => {
    const rows = resultRowPlan(view({ ...grouped(), grouped: false }), health, new Set());
    expect(rows[0]!.key).toBe("a".repeat(40));
  });

  it("expands the named group", () => {
    const key = resultRowPlan(grouped(), health, new Set())[0]!.key;
    const rows = resultRowPlan(grouped(), health, new Set([key]));
    expect(rows.map((r) => r.kind)).toEqual(["group", "release", "release", "release"]);
  });

  it("groups only what the filters left, so a filter still narrows the list", () => {
    const rows = resultRowPlan(view({ ...grouped(), textFilter: "ashfall" }), health, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("release");
  });

  it("defaults to grouped, because a duplicate-heavy browse is the common case", () => {
    expect(emptyView().grouped).toBe(true);
  });
});

describe("visibleGroups", () => {
  it("groups the filtered, sorted results", () => {
    const groups = visibleGroups(
      view({
        snapshot: snapshot([
          result({ name: "Kestrel.2010.1080p.BluRay.x264", infoHash: "a".repeat(40) }),
          result({ name: "Kestrel.2010.2160p.WEB-DL", infoHash: "b".repeat(40) }),
        ]),
      }),
      () => true,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toHaveLength(2);
    expect(groups[0]!.title).toBe("Kestrel");
  });
});

describe("parseGrouping", () => {
  it("defaults on for a missing or junk stored value", () => {
    expect(parseGrouping(null)).toBe(true);
    expect(parseGrouping("nonsense")).toBe(true);
  });

  it("honours an explicit opt-out", () => {
    expect(parseGrouping("off")).toBe(false);
  });
});

describe("grouping parity with the terminal", () => {
  // The TUI groups with hintForSection(section); the browser must group with the
  // equivalent hint for its tab names, or the same feed groups differently in the
  // two front ends.
  //
  // NON-VACUOUS BY CONSTRUCTION. parseRelease only consults the hint when the
  // name has no episode markers of its own (`type = isSeries ? "series" : hint ??
  // …`), so a fixture like "Kepler 01x04" keys as a series with or without it —
  // the first version of this test asserted exactly that and proved nothing. A
  // bare title with no year and no markers is the case where the hint decides,
  // and the assertion is that the tab changes the key.
  it("passes the tab's parser hint through to the grouping key", () => {
    const bare = [result({ name: "Harrowgate", infoHash: "a".repeat(40) })];
    const onTv = visibleGroups(view({ group: "TV", snapshot: snapshot(bare) }), () => true);
    const onAll = visibleGroups(view({ group: ALL_TAB, snapshot: snapshot(bare) }), () => true);
    expect(onTv[0]!.key).toContain("|series|");
    // The All tab has no medium to assume, so the same name keys differently.
    expect(onAll[0]!.key).not.toContain("|series|");
    expect(onTv[0]!.key).not.toBe(onAll[0]!.key);
  });

  it("groups a Movies tab with the film-shaped key", () => {
    const bare = [result({ name: "Harrowgate", infoHash: "a".repeat(40) })];
    const onMovies = visibleGroups(view({ group: "Movies", snapshot: snapshot(bare) }), () => true);
    expect(onMovies[0]!.key).toBe("harrowgate||movie");
  });
});

describe("positionLookup", () => {
  const row = (over: Partial<PublicStreamHistoryItem> = {}): PublicStreamHistoryItem => ({
    key: "harrowgate|series",
    title: "Harrowgate",
    type: "series",
    season: 3,
    episode: 7,
    next: { season: 3, episode: 8 },
    rawName: "Harrowgate.S03E07.1080p.WEB-DL",
    infoHash: "a1",
    startedAt: 1,
    ...over,
  });

  it("answers on the show key the group keys use", () => {
    expect(positionLookup([row()])("harrowgate")).toEqual({ season: 3, episode: 7 });
  });

  it("is null for a show with no row", () => {
    expect(positionLookup([row()])("kepler")).toBeNull();
  });

  it("ignores a film, which has no episode to be part-way through", () => {
    const film = row({ key: "kestrel|2010|movie", type: "movie", season: undefined, episode: undefined });
    expect(positionLookup([film])("kestrel|2010|movie")).toBeNull();
  });

  it("ignores a series row that names a season but no episode", () => {
    // A season pack streamed before Piece B's fix, or one never advanced.
    expect(positionLookup([row({ episode: undefined })])("harrowgate")).toBeNull();
  });
});
