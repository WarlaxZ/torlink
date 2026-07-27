import { describe, expect, it } from "vitest";
import {
  addBody,
  addPlan,
  ALL_TAB,
  categoryTabs,
  emptyView,
  erroredSources,
  previewApplies,
  progressLabel,
  reportsHealthLookup,
  resultMeta,
  rowForPlay,
  searchStatus,
  searchUrl,
  sourceLabel,
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
  return { ...emptyView(), query: "sintel", ...over };
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
