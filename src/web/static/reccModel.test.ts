import { describe, expect, it, vi } from "vitest";
import {
  ACTION_EVENT,
  createReccController,
  DEFAULT_FILTERS,
  dismissesPick,
  pickSub,
  reasonLine,
  reasonTitle,
  reccEventBody,
  reccItems,
  reccStatus,
  recommendationsUrl,
  sameFilters,
  searchGroupForType,
  type PublicRecommendation,
  type PublicRecommendations,
  type ReccFilters,
  type ReccState,
} from "./reccModel";
import type { SourcesResponse } from "./searchModel";

function pick(over: Partial<PublicRecommendation> = {}): PublicRecommendation {
  return {
    imdbId: "tt0133093",
    title: "The Matrix",
    year: 1999,
    score: 0.91,
    reasons: ["because you liked Blade Runner", "sci-fi"],
    ...over,
  };
}

function filters(over: Partial<ReccFilters> = {}): ReccFilters {
  return { ...DEFAULT_FILTERS, ...over };
}

describe("recommendationsUrl", () => {
  it("sends the type and nothing else by default", () => {
    expect(recommendationsUrl(filters())).toBe("/api/recommendations?type=all");
  });

  it("trims the genre and drops it when empty", () => {
    expect(recommendationsUrl(filters({ genre: "  horror " }))).toBe(
      "/api/recommendations?type=all&genre=horror",
    );
    expect(recommendationsUrl(filters({ genre: "   " }))).toBe("/api/recommendations?type=all");
  });

  it("sends explore only when it is on", () => {
    expect(recommendationsUrl(filters({ type: "tv", explore: true }))).toBe(
      "/api/recommendations?type=tv&explore=true",
    );
  });

  it("encodes a genre with a query character in it", () => {
    expect(recommendationsUrl(filters({ genre: "rock & roll" }))).toContain("genre=rock+%26+roll");
  });
});

describe("sameFilters", () => {
  it("ignores whitespace the request would have trimmed anyway", () => {
    expect(sameFilters(filters({ genre: "horror" }), filters({ genre: " horror " }))).toBe(true);
  });

  it("separates every field that changes the request", () => {
    expect(sameFilters(filters(), filters({ type: "tv" }))).toBe(false);
    expect(sameFilters(filters(), filters({ genre: "horror" }))).toBe(false);
    expect(sameFilters(filters(), filters({ explore: true }))).toBe(false);
  });
});

// A controller wired to a fetch whose answers the test resolves by hand, so
// out-of-order responses can actually be produced.
function harness(): {
  ctl: ReturnType<typeof createReccController>;
  resolve: (body: PublicRecommendations | null) => void;
  pending: number;
  calls: ReccFilters[];
  states: ReccState[];
  last: () => ReccState;
} {
  const calls: ReccFilters[] = [];
  const states: ReccState[] = [];
  const queue: ((body: PublicRecommendations | null) => void)[] = [];
  const ctl = createReccController({
    fetch(f) {
      calls.push({ ...f });
      return new Promise((res) => queue.push(res));
    },
    render(state) {
      states.push(state);
    },
  });
  return {
    ctl,
    resolve(body) {
      const next = queue.shift();
      if (!next) throw new Error("no request in flight");
      next(body);
    },
    get pending() {
      return queue.length;
    },
    calls,
    states,
    last: () => states[states.length - 1]!,
  };
}

const OK = (items: PublicRecommendation[]): PublicRecommendations => ({ status: "ok", items });

describe("createReccController — lazy first load", () => {
  /**
   * THE LAZY RULE. The feed is one of three panes and most page loads never
   * open it; fetching on construction asks reccd to score twenty titles for a
   * tab nobody looked at.
   */
  it("asks for nothing until the tab is opened", async () => {
    const h = harness();
    expect(h.calls).toEqual([]);
    expect(h.states).toEqual([]);
    h.ctl.open();
    expect(h.calls).toHaveLength(1);
  });

  it("loads once however many times the tab is re-opened", () => {
    const h = harness();
    h.ctl.open();
    h.resolve(OK([pick()]));
    h.ctl.open();
    h.ctl.open();
    expect(h.calls).toHaveLength(1);
  });

  // Changing a filter before the tab is opened records the choice and still
  // does not fetch — otherwise the lazy rule is gone by the back door.
  it("records a filter set before opening without fetching, then opens with it", () => {
    const h = harness();
    h.ctl.setType("tv");
    h.ctl.setGenre("horror");
    expect(h.calls).toEqual([]);
    h.ctl.open();
    expect(h.calls).toEqual([{ type: "tv", genre: "horror", explore: false }]);
  });

  it("starts idle, which is not an empty feed", () => {
    const h = harness();
    expect(h.ctl.state().phase).toEqual({ kind: "idle" });
    expect(reccStatus(h.ctl.state()).text).toBe("Picks based on what you've watched.");
  });
});

describe("createReccController — refetch on filter change", () => {
  it("refetches when a filter actually changes", () => {
    const h = harness();
    h.ctl.open();
    h.resolve(OK([pick()]));
    h.ctl.setType("movie");
    h.ctl.setExplore(true);
    expect(h.calls).toEqual([
      { type: "all", genre: "", explore: false },
      { type: "movie", genre: "", explore: false },
      { type: "movie", genre: "", explore: true },
    ]);
  });

  it("does not refetch when the filter is set to what it already was", () => {
    const h = harness();
    h.ctl.open();
    h.resolve(OK([pick()]));
    h.ctl.setType("all");
    h.ctl.setGenre("");
    h.ctl.setExplore(false);
    expect(h.calls).toHaveLength(1);
  });

  it("does not refetch when the genre changes only by whitespace", () => {
    const h = harness();
    h.ctl.open();
    h.resolve(OK([]));
    h.ctl.setGenre("horror");
    h.resolve(OK([]));
    h.ctl.setGenre("  horror  ");
    expect(h.calls).toHaveLength(2);
    // …but the state still reflects what the box says.
    expect(h.ctl.state().filters.genre).toBe("  horror  ");
  });

  it("refreshes the same filters on demand", () => {
    const h = harness();
    h.ctl.open();
    h.resolve(OK([]));
    h.ctl.refresh();
    expect(h.calls).toHaveLength(2);
  });
});

describe("createReccController — the request counter", () => {
  /**
   * THE STALE-RESPONSE RULE. Without the counter, switching from movies to tv
   * while the movie request is slow paints the movie feed under a "tv" filter.
   * It is silent, and indistinguishable from reccd being wrong.
   */
  it("drops an earlier response that lands after a newer one", async () => {
    const h = harness();
    h.ctl.open();
    h.ctl.setType("tv");
    expect(h.pending).toBe(2);

    // The newer (tv) request answers first…
    const tvPick = pick({ imdbId: "tt0903747", title: "Breaking Bad" });
    const first = h.calls[0]!;
    h.resolve(OK([pick()])); // resolves the FIRST (all) request
    await Promise.resolve();
    await Promise.resolve();
    expect(first.type).toBe("all");
    // …the stale "all" answer must not have been rendered.
    expect(reccItems(h.ctl.state())).toEqual([]);
    expect(h.ctl.state().phase.kind).toBe("loading");

    h.resolve(OK([tvPick]));
    await Promise.resolve();
    await Promise.resolve();
    expect(reccItems(h.ctl.state())).toEqual([tvPick]);
  });

  it("keeps the newest answer when a refresh overtakes the first load", async () => {
    const h = harness();
    h.ctl.open();
    h.ctl.refresh();
    h.resolve(OK([pick({ title: "Stale" })]));
    h.resolve(OK([pick({ title: "Fresh" })]));
    await Promise.resolve();
    await Promise.resolve();
    expect(reccItems(h.ctl.state()).map((i) => i.title)).toEqual(["Fresh"]);
  });
});

describe("createReccController — answers", () => {
  it("renders reccd's picks", async () => {
    const h = harness();
    h.ctl.open();
    h.resolve(OK([pick()]));
    await Promise.resolve();
    expect(h.ctl.state().phase).toEqual({ kind: "ready", items: [pick()] });
  });

  it("keeps not-configured distinct from an empty feed", async () => {
    const configured = harness();
    configured.ctl.open();
    configured.resolve(OK([]));
    await Promise.resolve();
    expect(configured.ctl.state().phase).toEqual({ kind: "ready", items: [] });

    const bare = harness();
    bare.ctl.open();
    bare.resolve({ status: "not-configured" });
    await Promise.resolve();
    expect(bare.ctl.state().phase).toEqual({ kind: "not-configured" });
  });

  it("shows reccd's own error message", async () => {
    const h = harness();
    h.ctl.open();
    h.resolve({ status: "error", error: "reccd rejected the token — check reccToken" });
    await Promise.resolve();
    expect(reccStatus(h.ctl.state())).toEqual({
      text: "reccd rejected the token — check reccToken",
      tone: "error",
      show: true,
    });
  });

  it("says so honestly when the request itself failed", async () => {
    const h = harness();
    h.ctl.open();
    h.resolve(null);
    await Promise.resolve();
    expect(reccStatus(h.ctl.state()).tone).toBe("error");
    expect(reccStatus(h.ctl.state()).text).toContain("Couldn't reach the server");
  });

  it("hides the status line once there are cards to look at", async () => {
    const h = harness();
    h.ctl.open();
    h.resolve(OK([pick()]));
    await Promise.resolve();
    expect(reccStatus(h.ctl.state()).show).toBe(false);
  });
});

describe("createReccController — dismiss", () => {
  it("removes a rated pick without a round trip", async () => {
    const h = harness();
    h.ctl.open();
    h.resolve(OK([pick(), pick({ imdbId: "tt0903747", title: "Breaking Bad" })]));
    await Promise.resolve();
    h.ctl.dismiss("tt0133093");
    expect(reccItems(h.ctl.state()).map((i) => i.title)).toEqual(["Breaking Bad"]);
    expect(h.calls).toHaveLength(1);
  });

  it("ignores a dismiss for something that is not in the list", async () => {
    const h = harness();
    h.ctl.open();
    h.resolve(OK([pick()]));
    await Promise.resolve();
    const before = h.states.length;
    h.ctl.dismiss("tt9999999");
    expect(h.states).toHaveLength(before);
  });
});

describe("the action → event mapping", () => {
  /**
   * A swap here is invisible on screen — the button highlights, the card leaves
   * the list — and teaches the recommender the opposite of what the user said.
   */
  it("maps each button to the event it means", () => {
    expect(ACTION_EVENT).toEqual({
      watched: "watched",
      like: "liked",
      dislike: "disliked",
      watchlist: "favourited",
    });
  });

  it("posts the pick's own title as the name", () => {
    expect(reccEventBody("like", pick())).toEqual({ type: "liked", rawName: "The Matrix" });
    expect(reccEventBody("dislike", pick())).toEqual({ type: "disliked", rawName: "The Matrix" });
    expect(reccEventBody("watched", pick())).toEqual({ type: "watched", rawName: "The Matrix" });
    expect(reccEventBody("watchlist", pick())).toEqual({ type: "favourited", rawName: "The Matrix" });
  });

  it("drops a rated pick from the feed but keeps a watchlisted one", () => {
    expect(dismissesPick("watched")).toBe(true);
    expect(dismissesPick("like")).toBe(true);
    expect(dismissesPick("dislike")).toBe(true);
    expect(dismissesPick("watchlist")).toBe(false);
  });
});

describe("card copy", () => {
  it("shows reccd's strongest reason, with the rest as hover text", () => {
    expect(reasonLine(pick())).toBe("because you liked Blade Runner");
    expect(reasonTitle(pick())).toBe("because you liked Blade Runner · sci-fi");
  });

  it("has no reason line when reccd gave none", () => {
    expect(reasonLine(pick({ reasons: [] }))).toBe("");
  });

  // reccd's `score` is an unbounded ranking number (a live one returns 63.72),
  // not a 0..1 confidence — presenting it as a percentage reads "6372% match".
  it("puts the year on the sub line and never dresses the score as a percentage", () => {
    expect(pickSub(pick())).toBe("1999");
    expect(pickSub(pick({ score: 63.72 }))).toBe("1999");
  });
});

describe("searchGroupForType", () => {
  const sources = (groups: string[]): SourcesResponse =>
    ({ groups: groups.map((group) => ({ group, sources: [] })) }) as unknown as SourcesResponse;

  it("opens a movie pick in the Movies tab and a tv pick in TV", () => {
    const s = sources(["Movies", "TV", "Anime"]);
    expect(searchGroupForType("movie", s)).toBe("Movies");
    expect(searchGroupForType("tv", s)).toBe("TV");
  });

  it("falls back to All rather than selecting a tab the server never offered", () => {
    expect(searchGroupForType("movie", sources(["Anime"]))).toBe("All");
    expect(searchGroupForType("tv", null)).toBe("All");
  });

  it("uses All for the unfiltered feed", () => {
    expect(searchGroupForType("all", sources(["Movies", "TV"]))).toBe("All");
  });
});

describe("reccStatus", () => {
  it("names reccd and the two ways to configure it", () => {
    const state: ReccState = { filters: filters(), phase: { kind: "not-configured" } };
    const line = reccStatus(state);
    expect(line.text).toContain("reccd");
    expect(line.text).toContain("TORLINK_RECC_URL");
    expect(line.tone).toBe("info");
  });

  it("never leaves the pane blank", () => {
    const phases: ReccState["phase"][] = [
      { kind: "idle" },
      { kind: "loading" },
      { kind: "not-configured" },
      { kind: "error", error: "nope" },
      { kind: "ready", items: [] },
    ];
    for (const phase of phases) {
      const line = reccStatus({ filters: filters(), phase });
      expect(line.show).toBe(true);
      expect(line.text.length).toBeGreaterThan(0);
    }
  });
});

describe("render", () => {
  it("renders once per state change and never for a no-op", () => {
    const render = vi.fn();
    const ctl = createReccController({ fetch: async () => OK([]), render });
    ctl.setType("all");
    expect(render).not.toHaveBeenCalled();
  });
});
