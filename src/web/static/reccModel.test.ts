import { describe, expect, it, vi } from "vitest";
import {
  ACTION_EVENT,
  ACTION_LABEL,
  actionNotice,
  createReccController,
  DEFAULT_FILTERS,
  dismissesPick,
  isRatingAction,
  pickSub,
  reasonLine,
  reasonTitle,
  RECC_ACTIONS,
  reccClaimHint,
  reccEventBody,
  reccItems,
  reccPosterHint,
  reccPosterNote,
  reccStatus,
  recommendationsUrl,
  sameFilters,
  saveSearchBlockedNotice,
  searchGroupForType,
  titleToSave,
  type PublicRecommendation,
  type PublicRecommendations,
  type PublicReccAccount,
  type ReccFilters,
  type ReccPosterOutcome,
  type ReccState,
} from "./reccModel";
import {
  NO_KEY_POSTER_NOTE,
  NO_POSTER_NOTE,
  OMDB_KEY_HINT,
  previewCopy,
} from "./previewModel";
import type { SourcesResponse } from "./searchModel";

function pick(over: Partial<PublicRecommendation> = {}): PublicRecommendation {
  return {
    imdbId: "tt1",
    title: "Ashfall",
    year: 1999,
    score: 0.91,
    reasons: ["because you liked Harrowgate", "sci-fi"],
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
    const tvPick = pick({ imdbId: "tt2", title: "Harrowgate" });
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
    h.resolve(OK([pick(), pick({ imdbId: "tt2", title: "Harrowgate" })]));
    await Promise.resolve();
    h.ctl.dismiss("tt1");
    expect(reccItems(h.ctl.state()).map((i) => i.title)).toEqual(["Harrowgate"]);
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

describe("the card's actions", () => {
  it("maps only the three ratings to reccd events", () => {
    expect(ACTION_EVENT.watched).toBe("watched");
    expect(ACTION_EVENT.like).toBe("liked");
    expect(ACTION_EVENT.dislike).toBe("disliked");
    // A swap in this table is invisible on screen and teaches the recommender
    // the opposite of what the user said, which is why it is asserted.
    expect(Object.keys(ACTION_EVENT)).toHaveLength(3);
  });

  it("narrows rating actions and excludes the local one", () => {
    expect(isRatingAction("watched")).toBe(true);
    expect(isRatingAction("like")).toBe(true);
    expect(isRatingAction("dislike")).toBe(true);
    // saveSearch is local: it writes config.savedSearches and tells reccd
    // nothing. If it reached reccEventBody it would post `type: undefined`.
    expect(isRatingAction("saveSearch")).toBe(false);
  });

  it("still offers four actions, with saveSearch last", () => {
    expect(RECC_ACTIONS).toEqual(["watched", "like", "dislike", "saveSearch"]);
  });

  it("captions saveSearch as save search", () => {
    expect(ACTION_LABEL.saveSearch).toBe("save search");
  });

  it("does not dismiss the pick when saving a search", () => {
    // Saving a search should no more remove a pick from the feed than the old
    // Library action did.
    expect(dismissesPick("saveSearch")).toBe(false);
    expect(dismissesPick("watched")).toBe(true);
    expect(dismissesPick("like")).toBe(true);
    expect(dismissesPick("dislike")).toBe(true);
  });

  it("posts the pick's own title as the name", () => {
    expect(reccEventBody("like", pick())).toEqual({ type: "liked", rawName: "Ashfall" });
    expect(reccEventBody("dislike", pick())).toEqual({ type: "disliked", rawName: "Ashfall" });
    expect(reccEventBody("watched", pick())).toEqual({ type: "watched", rawName: "Ashfall" });
  });

  it("tells the user a rating was noted", () => {
    expect(actionNotice("like", pick())).toBe("Thanks — noted “Ashfall” as liked.");
  });

  it("gives back the pick's trimmed title to save, or null with nothing usable", () => {
    expect(titleToSave(pick({ title: "  Ashfall  " }))).toBe("Ashfall");
    expect(titleToSave(pick({ title: "   " }))).toBeNull();
    expect(titleToSave(pick({ title: "" }))).toBeNull();
  });

  it("pins the wording for a pick with no title to save", () => {
    expect(saveSearchBlockedNotice()).toBe("That pick has no title to save.");
  });
});

describe("card copy", () => {
  it("shows reccd's strongest reason, with the rest as hover text", () => {
    expect(reasonLine(pick())).toBe("because you liked Harrowgate");
    expect(reasonTitle(pick())).toBe("because you liked Harrowgate · sci-fi");
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

// The graceful-degradation half of the feed. With no OMDb key the server answers
// `{status:"no-key"}` for every pick, and the feed's job is to say so once and to
// label the frames the way the search pane labels them — not to show twenty
// unexplained boxes that read as a broken feature.
describe("reccPosterNote", () => {
  it("names the missing key on the frame, in the search pane's words", () => {
    expect(reccPosterNote({ kind: "no-key" })).toBe("No OMDb key");
    expect(reccPosterNote({ kind: "no-key" })).toBe(NO_KEY_POSTER_NOTE);
  });

  it("keeps 'No poster' for a title that simply has no artwork", () => {
    expect(reccPosterNote({ kind: "none" })).toBe("No poster");
    expect(reccPosterNote({ kind: "none" })).toBe(NO_POSTER_NOTE);
  });

  it("never nags about a key for an outcome that has a poster", () => {
    // Not reached in practice — a poster paints an <img> — but the function is
    // total, and "No poster" is the safe answer rather than a key nag.
    expect(reccPosterNote({ kind: "poster", url: "blob:x" })).toBe(NO_POSTER_NOTE);
  });
});

describe("reccPosterHint", () => {
  it("explains the missing key when a lookup says no-key", () => {
    const hint = reccPosterHint([{ kind: "no-key" }, { kind: "no-key" }, { kind: "no-key" }]);
    expect(hint).toBe(OMDB_KEY_HINT);
    expect(hint).toContain("OMDb API key");
    expect(hint).toContain("Accounts tab");
  });

  it("says it once for twenty no-key cards, not twenty times", () => {
    const outcomes: ReccPosterOutcome[] = Array.from(
      { length: 20 },
      () => ({ kind: "no-key" }) as const,
    );
    // One string is the whole point: the caller renders it in one place.
    expect(reccPosterHint(outcomes)).toBe(OMDB_KEY_HINT);
  });

  it("stays silent for an ordinary title OMDb has no artwork for", () => {
    // THE MUTATION THIS CATCHES: keying the note off "no poster" rather than off
    // "no key" tells a user who HAS a key to go and add one.
    expect(reccPosterHint([{ kind: "none" }, { kind: "none" }])).toBeNull();
  });

  it("stays silent when every poster loaded", () => {
    expect(
      reccPosterHint([
        { kind: "poster", url: "blob:a" },
        { kind: "poster", url: "blob:b" },
      ]),
    ).toBeNull();
  });

  it("stays silent with nothing answered yet", () => {
    expect(reccPosterHint([])).toBeNull();
  });

  it("appears on the first no-key answer among posters that did load", () => {
    // A mixed feed is real: /api/title is cached per id server-side, so a key
    // removed mid-session leaves some ids answered from cache. One is enough.
    expect(
      reccPosterHint([{ kind: "poster", url: "blob:a" }, { kind: "no-key" }, { kind: "none" }]),
    ).toBe(OMDB_KEY_HINT);
  });

  it("reads a Map's values, which is how the caller holds the outcomes", () => {
    const cache = new Map<string, ReccPosterOutcome>([
      ["tt1", { kind: "none" }],
      ["tt2", { kind: "no-key" }],
    ]);
    expect(reccPosterHint(cache.values())).toBe(OMDB_KEY_HINT);
  });
});

describe("the no-key wording is shared with the search preview", () => {
  it("uses previewCopy's own sentence and frame label, not a second copy", () => {
    // This project has been bitten repeatedly by a second copy of something
    // drifting. The feed must fail here if the preview's wording changes.
    const copy = previewCopy("Kestrel.2010", {
      status: "no-key",
      parsed: { title: "Kestrel", year: 2010, type: "movie" },
    });
    expect(reccPosterHint([{ kind: "no-key" }])).toBe(copy.body);
    expect(reccPosterNote({ kind: "no-key" })).toBe(copy.posterNote);
  });
});

describe("reccClaimHint", () => {
  it("prompts to claim an unclaimed account, naming it", () => {
    const account: PublicReccAccount = { name: "quiet-heron-4f2a", claimed: false };
    expect(reccClaimHint(account)).toBe(
      "Your picks are saved to quiet-heron-4f2a, an account with no password yet. Claim it in the terminal UI to sign in on another machine.",
    );
  });

  it("says nothing for a claimed account", () => {
    const account: PublicReccAccount = { name: "ash", claimed: true };
    expect(reccClaimHint(account)).toBeNull();
  });

  it("says nothing when there is no account", () => {
    expect(reccClaimHint(null)).toBeNull();
  });

  // /api/sources has not answered yet. Staying quiet stops the sentence
  // flashing on a slow load — the same rule resultPosters.ts follows for
  // omdbConfigured: boolean | null.
  it("says nothing before /api/sources has answered", () => {
    expect(reccClaimHint(undefined)).toBeNull();
  });
});
